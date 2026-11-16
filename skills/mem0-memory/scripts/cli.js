'use strict';

if (!process.env.MEM0_TELEMETRY) {
  process.env.MEM0_TELEMETRY = 'false';
}

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { MEMORY_CATEGORIES, CATEGORY_DESCRIPTIONS, resolveMem0Config } = require('./config');
const { Mem0Service } = require('./engine');
const { syncRepositoryKnowledge, syncFeatureCapsule } = require('./sync');

function parseFlags(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

/**
 * 幂等合并 mem0 生命周期 hooks 到指定的 hooks.json（保留用户既有 hook 不覆盖）。
 */
function mergeCodexHooksFile(hooksFilePath, projectRoot) {
  fs.mkdirSync(path.dirname(hooksFilePath), { recursive: true });
  let existing = { hooks: {} };
  if (fs.existsSync(hooksFilePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(hooksFilePath, 'utf8'));
      if (!existing || typeof existing !== 'object') existing = { hooks: {} };
      if (!existing.hooks || typeof existing.hooks !== 'object') existing.hooks = {};
    } catch (_) {
      existing = { hooks: {} };
    }
  }

  const hookScript = path.join(projectRoot, 'skills', 'mem0-memory', 'scripts', 'codex-hook.js');
  const nodeBin = process.execPath;
  const desired = {
    UserPromptSubmit: `"${nodeBin}" "${hookScript}" user-prompt`,
    PostToolUse: `"${nodeBin}" "${hookScript}" post-tool`,
    Stop: `"${nodeBin}" "${hookScript}" stop`,
    PreCompact: `"${nodeBin}" "${hookScript}" pre-compact`,
    SessionEnd: `"${nodeBin}" "${hookScript}" session-end`,
  };

  for (const [eventName, command] of Object.entries(desired)) {
    if (!Array.isArray(existing.hooks[eventName])) {
      existing.hooks[eventName] = [];
    }
    const alreadyPresent = existing.hooks[eventName].some(
      (group) =>
        Array.isArray(group?.hooks) &&
        group.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('codex-hook.js'))
    );
    if (!alreadyPresent) {
      existing.hooks[eventName].push({
        ...(eventName === 'PostToolUse' ? { matcher: '.*' } : {}),
        hooks: [{ type: 'command', command, timeout: 4 }],
      });
    }
  }

  fs.writeFileSync(hooksFilePath, `${JSON.stringify(existing, null, 2)}\n`);
  return hooksFilePath;
}

/**
 * 幂等更新 ~/.codex/config.toml 中的 [mcp_servers.mem0]（不写入任何明文密钥）。
 */
function upsertCodexMcpConfig(configTomlPath, projectRoot) {
  const mcpScript = path.join(projectRoot, 'skills', 'mem0-memory', 'scripts', 'mcp-server.js');
  const nodeBin = process.execPath;
  const block = [
    '[mcp_servers.mem0]',
    `command = "${nodeBin}"`,
    `args = ["${mcpScript}"]`,
    'env_vars = ["MEM0_API_KEY", "MEM0_API_URL", "GOOGLE_API_KEY", "OPENAI_API_KEY", "MEM0_LLM_API_KEY", "MEM0_MODE", "MEM0_LLM_MODEL", "MEM0_EMBED_MODEL", "MEM0_MAX_CONTEXT_TOKENS"]',
    '',
    '[mcp_servers.mem0.env]',
    `MEM0_PROJECT_ROOT = "${projectRoot}"`,
    'MEM0_TELEMETRY = "false"',
  ].join('\n');

  let content = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf8') : '';
  const sectionRe = /\[mcp_servers\.mem0\][\s\S]*?(?=\n\[[^m]|\[mcp_servers\.(?!mem0)|$)/;
  if (sectionRe.test(content)) {
    content = content.replace(sectionRe, block);
  } else {
    content = `${content.trimEnd()}\n\n${block}\n`;
  }
  fs.mkdirSync(path.dirname(configTomlPath), { recursive: true });
  fs.writeFileSync(configTomlPath, content);
  return configTomlPath;
}

function printUsage() {
  console.log(`用法: loopx-flow memory <subcommand> [options]

子命令:
  search <query>         检索高相关长期记忆 (--category --scope repo|mine|all --top-k N --max-tokens N --json)
  add <text>             写入并自动去重/更新记忆 (--category <cat> --feature <name> --extract --json)
  update <id> <text>     更新指定记忆
  delete <id>            删除指定记忆
  list                   列出记忆 (--category <cat> --limit N --json)
  history <id>           查看指定记忆的变更历史
  sync                   增量同步仓库文档/ADR/胶囊到 mem0 (--force --json)
  stats                  查看记忆库统计信息 (--json)
  doctor                 检查 mem0 环境、API Key 与存储就绪度 (--live --json)
  setup-codex            配置 Codex MCP Server 与 Hooks (--global --project --json)

支持分类:
  ${MEMORY_CATEGORIES.map((c) => `${c}: ${CATEGORY_DESCRIPTIONS[c]}`).join('\n  ')}`);
}

async function runCli(argv = process.argv.slice(2), opts = {}) {
  const sub = argv[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printUsage();
    return 0;
  }

  const { positionals, flags } = parseFlags(argv.slice(1));
  const service = opts.service || new Mem0Service({ cwd: flags.cwd || process.cwd() });
  const asJson = Boolean(flags.json);

  if (sub === 'search' || sub === 'auto-recall') {
    const query = positionals.join(' ').trim();
    if (!query) {
      if (sub === 'auto-recall') return 0;
      console.error('错误: 请提供检索查询内容。');
      return 1;
    }
    const res = await service.search(query, {
      category: typeof flags.category === 'string' ? flags.category : undefined,
      scope: typeof flags.scope === 'string' ? flags.scope : 'repo',
      feature: typeof flags.feature === 'string' ? flags.feature : undefined,
      topK: flags['top-k'] ? Number(flags['top-k']) : undefined,
      maxContextTokens: flags['max-tokens'] ? Number(flags['max-tokens']) : undefined,
      timeoutMs: sub === 'auto-recall' ? 2200 : 8000,
    });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.ok && res.formatted) {
      console.log(res.formatted);
      if (sub !== 'auto-recall') {
        console.log(`\n[mem0] 命中 ${res.results.length} 条（消耗 ~${res.tokens} tokens，已过滤低相关/重复 ${res.filteredOut} 条）`);
      }
    } else if (sub !== 'auto-recall') {
      console.log(res.ok ? '[mem0] 未找到高相关历史记忆。' : `[mem0] 检索降级: ${res.error}`);
    }
    return res.ok || sub === 'auto-recall' ? 0 : 1;
  }

  if (sub === 'add') {
    const text = positionals.join(' ').trim();
    if (!text) {
      console.error('错误: 请提供待写入的记忆内容。');
      return 1;
    }
    const res = await service.capture(text, {
      category: typeof flags.category === 'string' ? flags.category : 'decisions',
      feature: typeof flags.feature === 'string' ? flags.feature : undefined,
      importance: flags.importance === 'high' ? 'high' : 'normal',
      curated: !flags.extract,
      source: 'cli_add',
    });
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }

  if (sub === 'update') {
    const [id, ...rest] = positionals;
    const text = rest.join(' ').trim();
    const res = await service.update(id, text, flags.category ? { category: flags.category } : {});
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }

  if (sub === 'delete') {
    const res = await service.delete(positionals[0]);
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }

  if (sub === 'list') {
    const res = await service.list({
      category: typeof flags.category === 'string' ? flags.category : undefined,
      limit: flags.limit ? Number(flags.limit) : 30,
      scope: typeof flags.scope === 'string' ? flags.scope : 'repo',
    });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else if (!res.ok) {
      console.error(`[mem0] 列表失败: ${res.error}`);
    } else if (res.results.length === 0) {
      console.log('[mem0] 当前仓库暂无已存储记忆。');
    } else {
      for (const item of res.results) {
        console.log(`- [${item.category}] (${item.id}) ${item.memory}`);
      }
      console.log(`\n共 ${res.total} 条记忆。`);
    }
    return res.ok ? 0 : 1;
  }

  if (sub === 'history') {
    const res = await service.history(positionals[0]);
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }

  if (sub === 'sync') {
    const res = await syncRepositoryKnowledge(service, {
      force: Boolean(flags.force),
      includeCapsules: Boolean(flags.all || flags['include-capsules']),
    });
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }

  if (sub === 'auto-capture') {
    const [feature, stage] = positionals;
    try {
      const res = await syncFeatureCapsule(service, feature, stage || 'approve');
      if (asJson) console.log(JSON.stringify(res));
    } catch (_) {
      // auto-capture 严格 fail-open，不阻塞 loopx-flow 主流转
    }
    return 0;
  }

  if (sub === 'stats') {
    const res = await service.stats();
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }

  if (sub === 'doctor') {
    const res = await service.doctor({ live: Boolean(flags.live) });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`Mem0 Doctor (${res.ok ? 'READY' : 'NOT_READY'})`);
      console.log(`- Mode: ${res.diagnostics.mode}`);
      console.log(`- Project Root: ${res.diagnostics.projectRoot}`);
      console.log(`- Agent Scope: ${res.diagnostics.agentId}`);
      console.log(`- Embedder: ${res.diagnostics.embedProvider} (${res.diagnostics.embedModel}, ${res.diagnostics.embedDimension}d)`);
      console.log(`- LLM: ${res.diagnostics.llmProvider} (${res.diagnostics.llmModel})`);
      console.log(`- Telemetry: ${res.diagnostics.telemetryEnabled ? 'enabled' : 'disabled'}`);
      console.log(`- Storage Writable: ${res.storageWritable}`);
      console.log(`- Keys: MEM0=${res.diagnostics.keys.MEM0_API_KEY}, GOOGLE=${res.diagnostics.keys.GOOGLE_API_KEY}, OPENAI=${res.diagnostics.keys.OPENAI_API_KEY}`);
      if (!res.credentials.ok) {
        console.log(`- Credential Issue: ${res.credentials.message}`);
      }
      if (res.liveProbe) {
        console.log(`- Live Probe: ${res.liveProbe.ok ? 'PASS' : `FAIL (${res.liveProbe.error})`}`);
      }
    }
    return res.ok ? 0 : 1;
  }

  if (sub === 'setup-codex') {
    const cfg = resolveMem0Config({ cwd: flags.cwd || process.cwd() });
    const root = cfg.identity.projectRoot;
    const codexHome = path.join(os.homedir(), '.codex');
    const updated = [];

    // MCP Server 默认写入 ~/.codex/config.toml；Hooks 默认写入项目级 .codex/hooks.json，避免与全局 hooks.json 重复触发
    const configureGlobalHooks = Boolean(flags.global);
    const configureProjectHooks = flags.project !== undefined ? Boolean(flags.project) : !configureGlobalHooks;
    const configureMcp = !flags['no-mcp'];

    if (configureMcp) {
      updated.push(upsertCodexMcpConfig(path.join(codexHome, 'config.toml'), root));
    }
    if (configureGlobalHooks) {
      updated.push(mergeCodexHooksFile(path.join(codexHome, 'hooks.json'), root));
    }
    if (configureProjectHooks) {
      updated.push(mergeCodexHooksFile(path.join(root, '.codex', 'hooks.json'), root));
    }

    console.log(JSON.stringify({ ok: true, updated }, null, 2));
    return 0;
  }

  console.error(`未知子命令: ${sub}`);
  printUsage();
  return 1;
}

if (require.main === module) {
  runCli().then((code) => process.exit(code));
}

module.exports = {
  runCli,
  parseFlags,
  mergeCodexHooksFile,
  upsertCodexMcpConfig,
};
