'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const {
  redactSecrets,
  maskSecret,
  estimateTokens,
  truncateToTokenBudget,
  isNoisyContent,
} = require(path.join(PROJECT_ROOT, 'skills/mem0-memory/scripts/redact.js'));
const { resolveMem0Config } = require(path.join(PROJECT_ROOT, 'skills/mem0-memory/scripts/config.js'));
const { Mem0Service, hashMemoryText } = require(path.join(PROJECT_ROOT, 'skills/mem0-memory/scripts/engine.js'));
const { syncRepositoryKnowledge, splitMarkdownSections } = require(path.join(PROJECT_ROOT, 'skills/mem0-memory/scripts/sync.js'));
const { handleHookEvent } = require(path.join(PROJECT_ROOT, 'skills/mem0-memory/scripts/codex-hook.js'));
const { processHandoff } = require(path.join(PROJECT_ROOT, 'skills/mem0-memory/scripts/flush-worker.js'));
const { mergeCodexHooksFile, upsertCodexMcpConfig } = require(path.join(PROJECT_ROOT, 'skills/mem0-memory/scripts/cli.js'));

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createMockBackend(initialItems = [], handlers = {}) {
  const store = new Map();
  for (const item of initialItems) {
    store.set(item.id, { ...item });
  }
  const calls = { add: [], search: [], update: [], delete: [], completeJson: [] };

  return {
    kind: 'mock',
    calls,
    store,
    async add(text, options) {
      calls.add.push({ text, options });
      const id = `mem-${store.size + 1}`;
      const item = {
        id,
        memory: text,
        metadata: options.metadata || {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.set(id, item);
      return [{ id, memory: text, metadata: { event: 'ADD' } }];
    },
    async search(query, options) {
      calls.search.push({ query, options });
      if (handlers.onSearch) return handlers.onSearch(query, options, store);
      const results = [];
      for (const item of store.values()) {
        if (options.category && item.metadata?.category !== options.category) continue;
        results.push({
          ...item,
          score: item.score ?? 0.6,
          semanticScore: item.semanticScore ?? item.score ?? 0.6,
        });
      }
      return results.slice(0, options.topK || 5);
    },
    async update(memoryId, text, metadata) {
      calls.update.push({ memoryId, text, metadata });
      const prev = store.get(memoryId) || { id: memoryId };
      store.set(memoryId, {
        ...prev,
        memory: text,
        metadata: { ...(prev.metadata || {}), ...(metadata || {}) },
        updatedAt: new Date().toISOString(),
      });
      return { message: 'Memory updated successfully!' };
    },
    async delete(memoryId) {
      calls.delete.push({ memoryId });
      store.delete(memoryId);
      return { message: 'Memory deleted successfully!' };
    },
    async getAll(options) {
      return Array.from(store.values()).slice(0, options.limit || 200);
    },
    async history(memoryId) {
      return [{ memory_id: memoryId, event: 'ADD' }];
    },
    async completeJson(messages) {
      calls.completeJson.push(messages);
      if (handlers.onCompleteJson) return handlers.onCompleteJson(messages);
      return null;
    },
  };
}

describe('mem0 隐私脱敏与 Token 预算控制', () => {
  test('redactSecrets 过滤各类 API Key、Token、Bearer、PEM 与 .env 凭据', () => {
    const raw = [
      'GOOGLE_API_KEY=AIzaSyDummyKeyValue1234567890abcdef',
      'Authorization: Bearer sk-proj-1234567890abcdefghij',
      'MEM0_API_KEY=m0-secretkey1234567890abcdef',
      'ghp_1234567890abcdefghij1234567890abcd',
      '{"api_key":"super-secret-value"}',
      'https://example.com/api?key=AIzaSyAnotherKey1234567890',
      '-----BEGIN PRIVATE KEY-----\nABC123\n-----END PRIVATE KEY-----',
    ].join('\n');
    const clean = redactSecrets(raw);
    assert.ok(!clean.includes('AIzaSyDummyKeyValue'), '不得保留 Google Key');
    assert.ok(!clean.includes('sk-proj-123456'), '不得保留 OpenAI Key');
    assert.ok(!clean.includes('m0-secretkey'), '不得保留 Mem0 Key');
    assert.ok(!clean.includes('ghp_123456'), '不得保留 GitHub Token');
    assert.ok(!clean.includes('super-secret-value'), '不得保留 JSON api_key');
    assert.ok(!clean.includes('AIzaSyAnotherKey'), '不得保留 URL query key');
    assert.ok(!clean.includes('ABC123'), '不得保留 PEM 私钥内容');
    assert.ok(clean.includes('[REDACTED]'));
    assert.strictEqual(maskSecret('AIza1234567890wxyz'), 'AIza...wxyz');
    assert.strictEqual(maskSecret(''), '<unset>');
  });

  test('estimateTokens 与 truncateToTokenBudget 严格约束上下文长度', () => {
    const longText = '架构决策：'.repeat(120);
    const truncated = truncateToTokenBudget(longText, 80);
    assert.ok(estimateTokens(truncated) <= 85, '截断后 Token 应贴合预算上限');
    assert.ok(truncated.endsWith('...'));
    assert.strictEqual(isNoisyContent('ok'), true);
    assert.strictEqual(isNoisyContent('好的'), true);
    assert.strictEqual(isNoisyContent('bin/loopx-flow 负责契约审批与门禁串联'), false);
  });

  test('search 过滤低相关性记忆并执行 Token 预算裁剪与去重', async () => {
    const tmp = makeTempDir('mem0-search-');
    try {
      const backend = createMockBackend([
        {
          id: 'm1',
          memory: '高相关架构：bin/loopx-flow 串联阶段 0~8 并调用 LoopX 控制面。',
          semanticScore: 0.78,
          score: 0.72,
          metadata: { category: 'architecture' },
        },
        {
          id: 'm2',
          memory: '高相关架构：bin/loopx-flow 串联阶段 0~8 并调用 LoopX 控制面。',
          semanticScore: 0.75,
          score: 0.70,
          metadata: { category: 'architecture' },
        },
        {
          id: 'm3',
          memory: '低相关噪声：无关的历史天气备忘。',
          semanticScore: 0.21,
          score: 0.20,
          metadata: { category: 'decisions' },
        },
      ]);
      const svc = new Mem0Service({ cwd: PROJECT_ROOT, dataDir: tmp, backend });
      const res = await svc.search('loopx-flow 架构如何工作', {
        topK: 5,
        minSemanticScore: 0.42,
        maxContextTokens: 200,
      });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.results.length, 1, '应过滤低相关 m3 且去重 m2');
      assert.strictEqual(res.results[0].id, 'm1');
      assert.ok(res.tokens <= 200);
      assert.strictEqual(res.filteredOut, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('mem0 自动写入、去重、更新与删除仲裁', () => {
  test('精确哈希去重与语义高相似度去重 (NONE)', async () => {
    const tmp = makeTempDir('mem0-dedup-');
    try {
      const existingText = '所有修改前必须通过 loopx-flow approve contract 锁定 SHA256 指纹。';
      const backend = createMockBackend(
        [
          {
            id: 'm1',
            memory: existingText,
            semanticScore: 0.95,
            metadata: { category: 'business_rules', content_hash: hashMemoryText(existingText) },
          },
        ],
        {
          onSearch: async () => [
            {
              id: 'm1',
              memory: existingText,
              semanticScore: 0.95,
              metadata: { category: 'business_rules' },
            },
          ],
        }
      );
      const svc = new Mem0Service({ cwd: PROJECT_ROOT, dataDir: tmp, backend });

      // 1. 精确哈希命中 -> NONE
      const res1 = await svc.capture(existingText, { category: 'business_rules', curated: true });
      assert.strictEqual(res1.ok, true);
      assert.strictEqual(res1.operations[0].event, 'NONE');
      assert.strictEqual(res1.operations[0].reason, 'exact_hash_duplicate');
      assert.strictEqual(backend.calls.add.length, 0);

      // 2. 语义近似 >= 0.92 -> NONE
      const res2 = await svc.capture('修改代码前需先运行 loopx-flow approve contract 锁定契约 SHA256。', {
        category: 'business_rules',
        curated: true,
      });
      assert.strictEqual(res2.ok, true);
      assert.strictEqual(res2.operations[0].event, 'NONE');
      assert.strictEqual(res2.operations[0].reason, 'semantic_duplicate');
      assert.strictEqual(backend.calls.add.length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('中等相似度命中时触发 LLM 仲裁执行 UPDATE 与 DELETE', async () => {
    const tmp = makeTempDir('mem0-reconcile-');
    try {
      const oldText = '代码审查报告支持降级手写五段式模板。';
      let mode = 'UPDATE';
      const backend = createMockBackend(
        [{ id: 'm-old', memory: oldText, metadata: { category: 'decisions' } }],
        {
          onSearch: async () => [
            { id: 'm-old', memory: oldText, semanticScore: 0.81, metadata: { category: 'decisions' } },
          ],
          onCompleteJson: async () => {
            if (mode === 'UPDATE') {
              return {
                action: 'UPDATE',
                targetIdx: '0',
                text: '代码审查报告严禁降级手写五段式模板，必须复用 LoopX 原生 review_template，不可用时输出 NOT_VERIFIED。',
                reason: '规则已收紧为 Fail-Closed',
              };
            }
            return {
              action: 'DELETE',
              targetIdx: '0',
              text: 'gate verify pr 子命令已彻底退役。',
              reason: '旧机制已废弃并被替换',
            };
          },
        }
      );
      const svc = new Mem0Service({ cwd: PROJECT_ROOT, dataDir: tmp, backend });

      const resUpdate = await svc.capture(
        '根据 ADR-0005，review 禁止降级自造报告，模板缺失时 fail-closed 返回 NOT_VERIFIED。',
        { category: 'decisions', curated: true }
      );
      assert.strictEqual(resUpdate.ok, true);
      assert.strictEqual(resUpdate.operations[0].event, 'UPDATE');
      assert.strictEqual(backend.calls.update.length, 1);
      assert.ok(backend.store.get('m-old').memory.includes('NOT_VERIFIED'));

      mode = 'DELETE';
      const resDelete = await svc.capture('gate verify pr 已退役，不再允许调用。', {
        category: 'decisions',
        curated: true,
      });
      assert.strictEqual(resDelete.ok, true);
      assert.strictEqual(resDelete.operations[0].event, 'DELETE');
      assert.strictEqual(resDelete.operations[1].event, 'ADD');
      assert.strictEqual(backend.calls.delete.length, 1);
      assert.strictEqual(backend.store.has('m-old'), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('会话对话提取 (curated=false) 自动分类沉淀 5 类项目知识且脱敏', async () => {
    const tmp = makeTempDir('mem0-extract-');
    try {
      const backend = createMockBackend([], {
        onSearch: async () => [],
        onCompleteJson: async () => ({
          facts: [
            { text: 'Issue #17 根因为 feature 命令提前创建了 ACTIVE_STATE.md，导致 bootstrap 跳过 canonical authority 初始化。', category: 'troubleshooting', importance: 'high' },
            { text: '所有修改后必须执行 npm run typecheck && npm run lint && npm run build && npm run test 四大门禁。', category: 'conventions', importance: 'high' },
          ],
        }),
      });
      const svc = new Mem0Service({ cwd: PROJECT_ROOT, dataDir: tmp, backend });
      const res = await svc.capture(
        '我们定位到 issue #17 是因为预先写了 ACTIVE_STATE.md，顺便注意 GOOGLE_API_KEY=AIzaSySecretTest1234567890 不要提交，改完跑四大门禁。',
        { source: 'codex_session', curated: false }
      );
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.operations.length, 2);
      assert.strictEqual(res.operations[0].category, 'troubleshooting');
      assert.strictEqual(res.operations[1].category, 'conventions');
      // 确保传入 LLM 提取的文本已脱敏
      const promptPayload = JSON.stringify(backend.calls.completeJson[0]);
      assert.ok(!promptPayload.includes('AIzaSySecretTest'), '发送给 LLM 的内容必须先脱敏');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('异常处理、Codex Hooks、增量同步与 CLI 集成', () => {
  test('缺少 API Key 时返回结构化降级错误且不抛未捕获异常', async () => {
    const tmp = makeTempDir('mem0-nokey-');
    const saved = {
      MEM0_API_KEY: process.env.MEM0_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      MEM0_LLM_API_KEY: process.env.MEM0_LLM_API_KEY,
    };
    delete process.env.MEM0_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.MEM0_LLM_API_KEY;
    try {
      const svc = new Mem0Service({ cwd: tmp, dataDir: tmp, mode: 'oss' });
      const sRes = await svc.search('任意查询');
      assert.strictEqual(sRes.ok, false);
      assert.strictEqual(sRes.degraded, true);
      assert.strictEqual(sRes.code, 'MISSING_EMBED_API_KEY');
      assert.deepStrictEqual(sRes.results, []);

      const cRes = await svc.capture('测试一条足够长但无密钥的配置记录', { curated: true });
      assert.strictEqual(cRes.ok, false);
      assert.strictEqual(cRes.degraded, true);

      const doc = await svc.doctor();
      assert.strictEqual(doc.ok, false);
      assert.strictEqual(doc.storageWritable, true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('Codex UserPromptSubmit hook 自动检索、同会话去重与异常 fail-open', async () => {
    const tmp = makeTempDir('mem0-hook-');
    const savedDataDir = process.env.MEM0_DATA_DIR;
    process.env.MEM0_DATA_DIR = tmp;
    try {
      const backend = createMockBackend([
        {
          id: 'm-arch',
          memory: 'loopx-flow approve contract 会把 04-contract.md 的 SHA256 锁定到 LoopX 控制面。',
          semanticScore: 0.85,
          metadata: { category: 'architecture' },
        },
      ]);
      const factory = (cwd) => new Mem0Service({ cwd, dataDir: tmp, backend });

      // 1. 首轮提示触发自动召回并注入 additionalContext
      const out1 = await handleHookEvent(
        'user-prompt',
        { session_id: 'sess-1', cwd: PROJECT_ROOT, prompt: '请帮我检查 approve contract 如何锁定契约指纹？GOOGLE_API_KEY=AIzaSyHookLeakTest1234567' },
        factory
      );
      assert.ok(out1.hookSpecificOutput?.additionalContext?.includes('approve contract'));

      // 验证落盘 session 缓冲已脱敏
      const sessJson = fs.readFileSync(path.join(tmp, 'sessions', 'sess-1.json'), 'utf8');
      assert.ok(!sessJson.includes('AIzaSyHookLeakTest'), 'session 文件中不得保留原始密钥');

      // 2. 同会话第二轮相似提示不再重复注入相同记忆（节省 Token）
      const out2 = await handleHookEvent(
        'user-prompt',
        { session_id: 'sess-1', cwd: PROJECT_ROOT, prompt: '继续说说 approve contract 契约指纹验证逻辑' },
        factory
      );
      assert.deepStrictEqual(out2, {});

      // 3. 异常注入时 hook 保持 fail-open 返回 {}
      const brokenFactory = () => ({
        search: async () => {
          throw new Error('network down');
        },
        formatRecallContext: () => ({ formatted: '' }),
      });
      const outErr = await handleHookEvent(
        'user-prompt',
        { session_id: 'sess-err', cwd: PROJECT_ROOT, prompt: '这是一个会触发网络异常的查询语句测试' },
        brokenFactory
      );
      assert.deepStrictEqual(outErr, {});

      // 4. flush-worker 处理 handoff 并清理文件
      const handoffFile = path.join(tmp, 'handoff.json');
      fs.writeFileSync(
        handoffFile,
        JSON.stringify({
          sessionId: 'sess-1',
          cwd: PROJECT_ROOT,
          dataDir: tmp,
          reason: 'stop',
          messages: [{ role: 'user', content: '记录一条架构结论：mem0 数据落在 .loopx/memory/' }],
        })
      );
      const flushRes = await processHandoff(handoffFile, (cwd, dd) => new Mem0Service({ cwd, dataDir: dd, backend: createMockBackend([], { onCompleteJson: async () => ({ facts: [{ text: 'mem0 数据目录落在 .loopx/memory/ 且已被 gitignore。', category: 'architecture' }] }) }) }));
      assert.strictEqual(flushRes.ok, true);
      assert.strictEqual(fs.existsSync(handoffFile), false, 'handoff 处理完毕后应删除');
    } finally {
      if (savedDataDir !== undefined) process.env.MEM0_DATA_DIR = savedDataDir;
      else delete process.env.MEM0_DATA_DIR;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('syncRepositoryKnowledge 增量同步：未修改文件跳过，节省 Token', async () => {
    const tmpRepo = makeTempDir('mem0-sync-repo-');
    const tmpData = makeTempDir('mem0-sync-data-');
    try {
      fs.writeFileSync(path.join(tmpRepo, 'AGENTS.md'), '# 规范\n\n## 门禁\n提交前必须运行 npm run typecheck && npm run lint && npm run build && npm run test，严禁在 main 分支直接提交。\n');
      const backend = createMockBackend([], {
        onSearch: async () => [],
        onCompleteJson: async () => ({
          facts: [{ text: '提交前必须运行四大硬门禁且禁止在 main 直接提交。', category: 'conventions' }],
        }),
      });
      const svc = new Mem0Service({ cwd: tmpRepo, dataDir: tmpData, backend });

      const first = await syncRepositoryKnowledge(svc);
      assert.strictEqual(first.ok, true);
      assert.deepStrictEqual(first.syncedFiles, ['AGENTS.md']);
      assert.strictEqual(first.skippedUnchanged, 0);

      const second = await syncRepositoryKnowledge(svc);
      assert.strictEqual(second.ok, true);
      assert.deepStrictEqual(second.syncedFiles, []);
      assert.strictEqual(second.skippedUnchanged, 1);
      assert.ok(splitMarkdownSections('# A\n' + 'x'.repeat(60)).length === 1);
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
    }
  });

  test('setup-codex 配置合并保留既有 hook 且不写入明文密钥', () => {
    const tmp = makeTempDir('mem0-setup-');
    try {
      const hooksPath = path.join(tmp, 'hooks.json');
      fs.writeFileSync(hooksPath, JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] }
      }));
      mergeCodexHooksFile(hooksPath, PROJECT_ROOT);
      mergeCodexHooksFile(hooksPath, PROJECT_ROOT); // 幂等验证
      const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
      assert.strictEqual(parsed.hooks.UserPromptSubmit.length, 2, '应保留既有 hook 且不重复追加 mem0 hook');
      assert.ok(parsed.hooks.Stop.length === 1);

      const tomlPath = path.join(tmp, 'config.toml');
      fs.writeFileSync(tomlPath, 'model = "test"\n');
      upsertCodexMcpConfig(tomlPath, PROJECT_ROOT);
      const toml = fs.readFileSync(tomlPath, 'utf8');
      assert.ok(toml.includes('[mcp_servers.mem0]'));
      assert.ok(toml.includes('MEM0_TELEMETRY = "false"'));
      assert.ok(!toml.includes('AIza'), 'config.toml 不得写入任何 API Key 明文');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('MCP Server stdio 协议响应 initialize 与 tools/list，CLI 帮助可执行', async () => {
    const cliRes = spawnSync(path.join(PROJECT_ROOT, 'bin/loopx-flow'), ['memory', '--help'], {
      encoding: 'utf8',
    });
    assert.strictEqual(cliRes.status, 0);
    assert.ok(cliRes.stdout.includes('loopx-flow memory'));

    const mcpPath = path.join(PROJECT_ROOT, 'skills/mem0-memory/scripts/mcp-server.js');
    const child = spawn(process.execPath, [mcpPath], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responses = await new Promise((resolve, reject) => {
      let buf = '';
      const msgs = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('MCP server handshake timeout: ' + buf));
      }, 5000);

      child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          msgs.push(JSON.parse(line));
          if (msgs.length === 2) {
            clearTimeout(timer);
            child.kill();
            resolve(msgs);
          }
        }
      });

      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      }) + '\n');
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }) + '\n');
    });

    assert.strictEqual(responses[0].id, 1);
    assert.strictEqual(responses[0].result.serverInfo.name, 'loopx-mem0');
    const toolNames = responses[1].result.tools.map((t) => t.name);
    for (const expected of ['search_memories', 'add_memory', 'update_memory', 'delete_memory', 'list_memories', 'memory_stats']) {
      assert.ok(toolNames.includes(expected), `MCP 应注册工具 ${expected}`);
    }
  });
});
