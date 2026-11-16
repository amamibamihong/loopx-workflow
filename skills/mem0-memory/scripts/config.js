'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { maskSecret } = require('./redact');

const MEMORY_CATEGORIES = Object.freeze([
  'architecture',
  'decisions',
  'conventions',
  'business_rules',
  'troubleshooting',
]);

const CATEGORY_DESCRIPTIONS = Object.freeze({
  architecture: '项目架构、模块边界、数据流、组件职责与运行结构',
  decisions: '技术决策、ADR、方案取舍、否决路径与契约约束',
  conventions: '代码规范、命名风格、门禁规则、测试约定与反模式',
  business_rules: '业务规则、REQ-* 需求、Fail-Closed 门禁与审批流转',
  troubleshooting: '历史问题解决方案、Issue 根因、已知缺陷与踩坑修复',
});

/**
 * 从可选的本地 gitignored env 文件加载未设置的环境变量（环境变量优先级最高）。
 * @param {string} projectRoot
 */
function loadLocalEnv(projectRoot) {
  const candidates = [
    path.join(projectRoot, '.loopx', 'memory', '.env'),
    path.join(projectRoot, '.env.local'),
  ];
  for (const envFile of candidates) {
    if (!fs.existsSync(envFile)) continue;
    try {
      const content = fs.readFileSync(envFile, 'utf8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
        const eqIdx = cleaned.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = cleaned.slice(0, eqIdx).trim();
        let val = cleaned.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (key && process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    } catch (_) {
      // 忽略不可读的本地 env 文件，不暴露内容
    }
  }
}

function runGit(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return '';
  }
}

function normalizeGitRemote(remote) {
  let cleaned = String(remote || '').trim();
  if (!cleaned) return '';
  if (cleaned.startsWith('git@') && cleaned.includes(':')) {
    const rest = cleaned.slice(4).replace(':', '/');
    cleaned = `https://${rest}`;
  }
  if (cleaned.endsWith('.git')) {
    cleaned = cleaned.slice(0, -4);
  }
  try {
    const parsed = new URL(cleaned);
    const host = parsed.hostname || '';
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${host}${pathname}`.toLowerCase();
  } catch (_) {
    return cleaned.replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * 解析当前项目根目录、规范化仓库身份（防止跨仓库记忆污染）以及用户身份。
 * @param {string} [cwd]
 */
function resolveProjectIdentity(cwd) {
  const startDir = path.resolve(cwd || process.env.MEM0_PROJECT_ROOT || process.cwd());
  const gitTop = runGit(startDir, ['rev-parse', '--show-toplevel']);
  const projectRoot = gitTop || startDir;
  const remoteRaw = runGit(projectRoot, ['config', '--get', 'remote.origin.url']);
  const normalizedRemote = normalizeGitRemote(remoteRaw);
  const branch = runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'detached';
  const repoBase = normalizedRemote || path.basename(projectRoot) || 'workspace';
  const repoHash = crypto.createHash('sha256').update(repoBase).digest('hex').slice(0, 12);
  const repoSlug = repoBase.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'repo';
  const rawUser =
    process.env.MEM0_USER_ID ||
    process.env.MEM0_CODE_USER_ID ||
    process.env.USER ||
    os.userInfo().username ||
    'developer';
  const userId = `user:${String(rawUser).trim().replace(/\s+/g, '_')}`;
  const agentId = `repo:${repoSlug}:${repoHash}`;

  return {
    projectRoot,
    repoSlug,
    repoRemote: normalizedRemote || projectRoot,
    repoHash,
    branch,
    agentId,
    userId,
  };
}

function parsePositiveInt(val, fallback) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function parseRatio(val, fallback) {
  const num = Number(val);
  return Number.isFinite(num) && num >= 0 && num <= 1 ? num : fallback;
}

/**
 * 解析 Mem0 运行时配置（支持 OSS 本地模式与 Platform 云端模式）。
 * @param {{ cwd?: string; dataDir?: string; mode?: string }} [opts]
 */
function resolveMem0Config(opts = {}) {
  const identity = resolveProjectIdentity(opts.cwd);
  loadLocalEnv(identity.projectRoot);

  const dataDir = path.resolve(
    opts.dataDir ||
      process.env.MEM0_DATA_DIR ||
      path.join(identity.projectRoot, '.loopx', 'memory')
  );

  const mem0ApiKey = (process.env.MEM0_API_KEY || '').trim();
  const googleApiKey = (process.env.GOOGLE_API_KEY || '').trim();
  const openaiApiKey = (process.env.OPENAI_API_KEY || '').trim();
  const llmApiKey = (process.env.MEM0_LLM_API_KEY || '').trim();
  const embedApiKey = (process.env.MEM0_EMBED_API_KEY || '').trim();

  const requestedMode = (opts.mode || process.env.MEM0_MODE || 'auto').toLowerCase();
  const mode =
    requestedMode === 'platform' || (requestedMode === 'auto' && Boolean(mem0ApiKey))
      ? 'platform'
      : 'oss';

  let embedProvider = (process.env.MEM0_EMBED_PROVIDER || '').toLowerCase();
  if (!embedProvider) {
    if (googleApiKey) embedProvider = 'google';
    else if (openaiApiKey || embedApiKey) embedProvider = 'openai';
    else embedProvider = 'none';
  }

  const embedModel =
    process.env.MEM0_EMBED_MODEL ||
    (embedProvider === 'google' ? 'gemini-embedding-001' : 'text-embedding-3-small');
  const embedDimension = parsePositiveInt(
    process.env.MEM0_EMBED_DIMENSION,
    embedProvider === 'google' ? 768 : 1536
  );

  let llmProvider = (process.env.MEM0_LLM_PROVIDER || '').toLowerCase();
  if (!llmProvider) {
    if (googleApiKey) llmProvider = 'google';
    else if (openaiApiKey || llmApiKey) llmProvider = 'openai';
    else llmProvider = 'none';
  }

  const llmModel =
    process.env.MEM0_LLM_MODEL ||
    (llmProvider === 'google' ? 'gemini-2.5-flash-lite' : 'gpt-4o-mini');
  const llmBaseUrl = (process.env.MEM0_LLM_BASE_URL || process.env.OPENAI_BASE_URL || '').trim() || undefined;
  const embedBaseUrl = (process.env.MEM0_EMBED_BASE_URL || '').trim() || undefined;

  const vectorDbPath = path.join(dataDir, 'vector_store.db');
  const historyDbPath = path.join(dataDir, 'history.db');
  const sessionsDir = path.join(dataDir, 'sessions');
  const manifestPath = path.join(dataDir, 'sync-manifest.json');
  const handoffDir = path.join(dataDir, 'handoffs');

  const budgets = {
    topK: parsePositiveInt(process.env.MEM0_TOP_K, 5),
    maxTopK: 15,
    minSemanticScore: parseRatio(process.env.MEM0_MIN_SEMANTIC_SCORE, 0.42),
    maxContextTokens: parsePositiveInt(process.env.MEM0_MAX_CONTEXT_TOKENS, 800),
    maxItemChars: parsePositiveInt(process.env.MEM0_MAX_ITEM_CHARS, 280),
    maxExtractionChars: parsePositiveInt(process.env.MEM0_MAX_EXTRACTION_CHARS, 8000),
    minPromptChars: parsePositiveInt(process.env.MEM0_MIN_PROMPT_CHARS, 15),
    dedupSkipThreshold: parseRatio(process.env.MEM0_DEDUP_SKIP_THRESHOLD, 0.92),
    dedupUpdateThreshold: parseRatio(process.env.MEM0_DEDUP_UPDATE_THRESHOLD, 0.72),
    hookTimeoutMs: parsePositiveInt(process.env.MEM0_HOOK_TIMEOUT_MS, 2500),
  };

  return {
    identity,
    mode,
    dataDir,
    storage: {
      vectorDbPath,
      historyDbPath,
      sessionsDir,
      manifestPath,
      handoffDir,
      collectionName: `loopx_${identity.repoHash}`,
    },
    credentials: {
      mem0ApiKey,
      mem0ApiUrl: (process.env.MEM0_API_URL || 'https://api.mem0.ai').trim(),
      googleApiKey,
      openaiApiKey,
      llmApiKey: llmApiKey || (llmProvider === 'google' ? googleApiKey : openaiApiKey),
      embedApiKey: embedApiKey || (embedProvider === 'google' ? googleApiKey : openaiApiKey),
    },
    providers: {
      embedProvider,
      embedModel,
      embedDimension,
      embedBaseUrl,
      llmProvider,
      llmModel,
      llmBaseUrl,
    },
    budgets,
    diagnostics() {
      return {
        mode,
        projectRoot: identity.projectRoot,
        agentId: identity.agentId,
        userId: identity.userId,
        branch: identity.branch,
        dataDir,
        embedProvider,
        embedModel,
        embedDimension,
        llmProvider,
        llmModel,
        keys: {
          MEM0_API_KEY: maskSecret(mem0ApiKey),
          GOOGLE_API_KEY: maskSecret(googleApiKey),
          OPENAI_API_KEY: maskSecret(openaiApiKey),
          MEM0_LLM_API_KEY: maskSecret(llmApiKey),
        },
        telemetryEnabled: String(process.env.MEM0_TELEMETRY || 'false').toLowerCase() !== 'false',
        budgets,
      };
    },
  };
}

module.exports = {
  MEMORY_CATEGORIES,
  CATEGORY_DESCRIPTIONS,
  loadLocalEnv,
  normalizeGitRemote,
  resolveProjectIdentity,
  resolveMem0Config,
};
