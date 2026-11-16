'use strict';

if (!process.env.MEM0_TELEMETRY) {
  process.env.MEM0_TELEMETRY = 'false';
}

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { resolveMem0Config } = require('./config');
const { Mem0Service } = require('./engine');
const {
  redactSecrets,
  isNoisyContent,
  boundedRedacted,
} = require('./redact');

function safeSessionId(raw) {
  const clean = String(raw || 'default-session').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  return clean || 'default-session';
}

function sessionFilePath(config, sessionId) {
  return path.join(config.storage.sessionsDir, `${safeSessionId(sessionId)}.json`);
}

function readSessionState(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { turns: 0, messages: [], injectedIds: [], lastRecallQuery: '', lastRecallTurn: -10, lastFlushedCount: 0 };
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      turns: Number(data.turns) || 0,
      messages: Array.isArray(data.messages) ? data.messages : [],
      injectedIds: Array.isArray(data.injectedIds) ? data.injectedIds : [],
      lastRecallQuery: String(data.lastRecallQuery || ''),
      lastRecallTurn: Number.isFinite(data.lastRecallTurn) ? data.lastRecallTurn : -10,
      lastFlushedCount: Number(data.lastFlushedCount) || 0,
    };
  } catch (_) {
    return { turns: 0, messages: [], injectedIds: [], lastRecallQuery: '', lastRecallTurn: -10, lastFlushedCount: 0 };
  }
}

function writeSessionState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, filePath);
}

function tokenOverlap(a, b) {
  const tokenize = (s) =>
    new Set(
      String(s || '')
        .toLowerCase()
        .split(/[\s,.;:!?()[\]{}"'`/\\]+/)
        .filter((w) => w.length >= 2)
    );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const w of setA) {
    if (setB.has(w)) inter += 1;
  }
  return inter / Math.max(setA.size, setB.size);
}

function spawnFlushWorker(config, sessionId, messages, reason) {
  if (!messages || messages.length === 0) return false;
  fs.mkdirSync(config.storage.handoffDir, { recursive: true });
  const handoffId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
  const handoffPath = path.join(config.storage.handoffDir, handoffId);
  fs.writeFileSync(
    handoffPath,
    JSON.stringify({
      sessionId,
      cwd: config.identity.projectRoot,
      dataDir: config.dataDir,
      reason,
      messages,
      createdAt: new Date().toISOString(),
    })
  );

  const workerScript = path.join(__dirname, 'flush-worker.js');
  const child = spawn(process.execPath, [workerScript, handoffPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  return true;
}

async function handleHookEvent(event, payload = {}, serviceFactory = (cwd) => new Mem0Service({ cwd })) {
  const cwd = payload.cwd || process.env.MEM0_PROJECT_ROOT || process.cwd();
  const config = resolveMem0Config({ cwd });
  const sessionId = safeSessionId(payload.session_id || payload.thread_id || 'codex-session');
  const stateFile = sessionFilePath(config, sessionId);
  const state = readSessionState(stateFile);

  if (event === 'user-prompt' || event === 'UserPromptSubmit') {
    const rawPrompt = redactSecrets(payload.prompt || payload.user_prompt || '').trim();
    if (isNoisyContent(rawPrompt, config.budgets.minPromptChars)) {
      return {};
    }

    state.turns += 1;
    state.messages.push({ role: 'user', content: boundedRedacted(rawPrompt, 2000) });
    // 限制单会话本地缓冲长度
    if (state.messages.length > 40) {
      state.messages = state.messages.slice(-40);
    }

    const isFirstRecall = state.lastRecallTurn < 0;
    const turnsSinceRecall = state.turns - state.lastRecallTurn;
    const overlap = tokenOverlap(rawPrompt, state.lastRecallQuery);
    const shouldRecall = isFirstRecall || (turnsSinceRecall >= 3 && overlap < 0.45);

    if (!shouldRecall) {
      writeSessionState(stateFile, state);
      return {};
    }

    let searchRes = { ok: false, results: [] };
    let service = null;
    try {
      service = serviceFactory(cwd);
      searchRes = await service.search(rawPrompt, {
        topK: config.budgets.topK,
        maxContextTokens: Math.min(config.budgets.maxContextTokens, 700),
        minSemanticScore: config.budgets.minSemanticScore,
        timeoutMs: config.budgets.hookTimeoutMs,
      });
    } catch (_) {
      searchRes = { ok: false, results: [] };
    }

    if (!service || !searchRes.ok || !searchRes.results || searchRes.results.length === 0) {
      writeSessionState(stateFile, state);
      return {};
    }

    const freshItems = searchRes.results.filter((r) => !state.injectedIds.includes(r.id));
    if (freshItems.length === 0) {
      writeSessionState(stateFile, state);
      return {};
    }

    const { formatted } = service.formatRecallContext(freshItems, {
      maxContextTokens: Math.min(config.budgets.maxContextTokens, 700),
      maxItemChars: config.budgets.maxItemChars,
    });

    if (!formatted) {
      writeSessionState(stateFile, state);
      return {};
    }

    state.lastRecallQuery = rawPrompt.slice(0, 300);
    state.lastRecallTurn = state.turns;
    for (const item of freshItems) {
      if (item.id && !state.injectedIds.includes(item.id)) {
        state.injectedIds.push(item.id);
      }
    }
    if (state.injectedIds.length > 50) {
      state.injectedIds = state.injectedIds.slice(-50);
    }
    writeSessionState(stateFile, state);

    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: formatted,
      },
    };
  }

  if (event === 'post-tool' || event === 'PostToolUse') {
    const toolName = String(payload.tool_name || payload.toolName || 'tool');
    const resp = payload.tool_response ?? payload.toolResponse;
    const failed =
      typeof resp === 'object' && resp !== null &&
      ((typeof resp.exit_code === 'number' && resp.exit_code !== 0) ||
        resp.isError === true ||
        resp.success === false);
    // 仅记录失败工具调用或高信号修改工具，防止海量命令日志污染缓冲
    if (failed || /apply_patch|write|edit|exec_command/i.test(toolName)) {
      const summary = boundedRedacted(
        `[tool:${toolName}${failed ? ' FAILED' : ''}] ${typeof resp === 'string' ? resp : JSON.stringify(resp || {})}`,
        360
      );
      if (!isNoisyContent(summary, 20)) {
        state.messages.push({ role: 'tool', content: summary });
        if (state.messages.length > 40) state.messages = state.messages.slice(-40);
        writeSessionState(stateFile, state);
      }
    }
    return {};
  }

  if (event === 'stop' || event === 'Stop') {
    const assistantMsg = redactSecrets(payload.last_assistant_message || '').trim();
    if (assistantMsg && !isNoisyContent(assistantMsg, 30)) {
      state.messages.push({ role: 'assistant', content: boundedRedacted(assistantMsg, 1600) });
      if (state.messages.length > 40) state.messages = state.messages.slice(-40);
    }
    const pending = state.messages.slice(state.lastFlushedCount);
    const hasSubstantial = pending.some((m) => m.role === 'assistant') && pending.length >= 2;
    if (hasSubstantial && !payload.disable_spawn) {
      spawnFlushWorker(config, sessionId, pending, 'stop');
      state.lastFlushedCount = state.messages.length;
    }
    writeSessionState(stateFile, state);
    return {};
  }

  if (event === 'pre-compact' || event === 'PreCompact' || event === 'session-end' || event === 'SessionEnd') {
    const pending = state.messages.slice(state.lastFlushedCount);
    if (pending.length > 0 && !payload.disable_spawn) {
      spawnFlushWorker(config, sessionId, pending, event);
      state.lastFlushedCount = state.messages.length;
      writeSessionState(stateFile, state);
    }
    return {};
  }

  return {};
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    const timer = setTimeout(() => resolve({}), 800);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(raw || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (_) {
        resolve({});
      }
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
  });
}

async function main() {
  const event = process.argv[2] || 'user-prompt';
  const payload = await readStdin();
  try {
    const out = await handleHookEvent(event, payload);
    process.stdout.write(`${JSON.stringify(out || {})}\n`);
  } catch (_) {
    // 严格 fail-open：Hook 异常绝不阻断 Codex 主流程
    process.stdout.write('{}\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  handleHookEvent,
  readSessionState,
  writeSessionState,
  tokenOverlap,
};
