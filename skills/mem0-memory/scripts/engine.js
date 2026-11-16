'use strict';

// 必须在加载 mem0ai 前关闭默认 PostHog 遥测，保护研发隐私
if (!process.env.MEM0_TELEMETRY) {
  process.env.MEM0_TELEMETRY = 'false';
}

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  MEMORY_CATEGORIES,
  CATEGORY_DESCRIPTIONS,
  resolveMem0Config,
} = require('./config');
const {
  redactSecrets,
  estimateTokens,
  truncateToTokenBudget,
  isNoisyContent,
  boundedRedacted,
} = require('./redact');

function normalizeForHash(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[。.!！?？;；,，]+$/g, '')
    .trim();
}

function hashMemoryText(text) {
  return crypto.createHash('sha256').update(normalizeForHash(text)).digest('hex').slice(0, 24);
}

const STOP_TOKENS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'how', 'what',
  'why', 'when', 'where', 'can', 'does', 'are', 'was', 'were', 'will', 'not',
  '如何', '怎么', '怎样', '什么', '为什么', '请帮', '帮我', '请问', '可以', '一下',
  '是否', '需要', '进行', '以及', '或者', '如果', '这个', '那个', '我们', '你们',
]);

function extractLexicalTerms(text) {
  const lower = String(text || '').toLowerCase();
  const terms = new Set();
  const asciiMatches = lower.match(/[a-z0-9_.-]{2,}/g) || [];
  for (const w of asciiMatches) {
    if (!STOP_TOKENS.has(w)) terms.add(w);
  }
  const cjkRuns = lower.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i <= run.length - 2; i++) {
      const bg = run.slice(i, i + 2);
      if (!STOP_TOKENS.has(bg) && !/[的了和与在是有对把被为及或请帮我这那吗呢么]/.test(bg)) {
        terms.add(bg);
      }
    }
  }
  return terms;
}

function computeLexicalOverlap(query, memoryText) {
  const qTerms = extractLexicalTerms(query);
  if (qTerms.size === 0) return 0;
  const mTerms = extractLexicalTerms(memoryText);
  if (mTerms.size === 0) return 0;
  let hits = 0;
  for (const t of qTerms) {
    if (mTerms.has(t)) hits += 1;
  }
  return hits / Math.min(qTerms.size, 6);
}

function normalizeCategory(cat) {
  const cleaned = String(cat || '').trim().toLowerCase();
  if (MEMORY_CATEGORIES.includes(cleaned)) return cleaned;
  if (/arch|struct|module|component|架构|模块/.test(cleaned)) return 'architecture';
  if (/decis|adr|tradeoff|choice|决策|取舍/.test(cleaned)) return 'decisions';
  if (/conv|style|lint|rule|norm|规范|约定/.test(cleaned)) return 'conventions';
  if (/biz|business|req|gate|workflow|业务|规则|门禁/.test(cleaned)) return 'business_rules';
  if (/fix|bug|issue|trouble|error|solut|排错|修复|故障|问题/.test(cleaned)) return 'troubleshooting';
  return 'decisions';
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(stripped);
  } catch (_) {
    const firstBrace = stripped.indexOf('{');
    const lastBrace = stripped.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

async function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'operation'} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

async function withRateLimitRetry(fn, { allowRetry = false, maxRetries = 2 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err?.message || err || '');
      const isRateLimit = err?.status === 429 || /429|RESOURCE_EXHAUSTED|rate[- ]?limit/i.test(msg);
      if (!allowRetry || !isRateLimit || attempt >= maxRetries) {
        throw err;
      }
      const waitMs = 3000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, waitMs));
      attempt += 1;
    }
  }
}

function buildExtractionPrompt(messagesText, contextMeta = {}) {
  const catGuide = MEMORY_CATEGORIES.map((c) => `- ${c}: ${CATEGORY_DESCRIPTIONS[c]}`).join('\n');
  const systemPrompt = `你是研发工程长期记忆提炼器。请从输入的工程对话或文档片段中提取真正值得跨任务长期复用的高价值事实，避免提取临时寒暄、原始堆栈或一次性指令。

必须将每条记忆归入以下 5 类之一：
${catGuide}

规则：
1. 每条记忆必须自包含、简洁准确（建议 20~180 字），保留关键文件路径、命令、REQ/ADR 编号或约束条件。
2. 严禁包含密钥、Token、密码或临时调试噪音。
3. 最多提取 6 条高信息密度记忆；若无长期价值则返回空数组 {"facts": []}。
4. 只输出严格 JSON 对象，格式为：
{"facts":[{"text":"...","category":"architecture|decisions|conventions|business_rules|troubleshooting","importance":"high|normal"}]}`;

  const userPrompt = `项目上下文: repo=${contextMeta.repoSlug || 'unknown'}, branch=${contextMeta.branch || 'unknown'}${contextMeta.feature ? `, feature=${contextMeta.feature}` : ''}

待提取内容：
${messagesText}`;
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

function buildReconcilePrompt(candidateFact, neighbors) {
  const existingList = neighbors.map((n, idx) => ({
    idx: String(idx),
    category: n.metadata?.category || 'unknown',
    text: n.memory,
  }));
  const systemPrompt = `你是长期记忆去重与更新仲裁器。请对比新候选事实与最相近的历史记忆，决定执行以下哪种操作：
- NONE：新事实已被现有某条记忆完整覆盖或语义重复，无需写入。
- UPDATE：新事实修正、补充、更新或取代了现有某条记忆（例如版本号、默认行为、架构路径或规则变更），保留其 idx 并输出合并后的最新完整陈述。
- DELETE：新事实明确推翻/作废了某条旧记忆（targetIdx），且需要删除旧记忆（可选提供 replacementText 写入新记忆）。
- ADD：新事实与现有记忆不重复也不冲突，应作为新记忆写入。

只输出严格 JSON：
{"action":"ADD|UPDATE|DELETE|NONE","targetIdx":"0","text":"更新或新增后的完整陈述","reason":"简短原因"}`;

  const userPrompt = `现有相似记忆：
${JSON.stringify(existingList, null, 2)}

新候选事实 (${candidateFact.category})：
${candidateFact.text}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * 适配 mem0ai/oss (Memory) 为统一底层后端接口。
 */
function createOssBackend(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const { Memory } = require('mem0ai/oss');

  const llmConfig =
    config.providers.llmProvider === 'google'
      ? {
          provider: 'google',
          config: {
            apiKey: config.credentials.llmApiKey,
            model: config.providers.llmModel,
          },
        }
      : {
          provider: 'openai',
          config: {
            apiKey: config.credentials.llmApiKey,
            model: config.providers.llmModel,
            ...(config.providers.llmBaseUrl ? { baseURL: config.providers.llmBaseUrl } : {}),
          },
        };

  const embedderConfig =
    config.providers.embedProvider === 'google'
      ? {
          provider: 'google',
          config: {
            apiKey: config.credentials.embedApiKey,
            model: config.providers.embedModel,
            embeddingDims: config.providers.embedDimension,
          },
        }
      : {
          provider: 'openai',
          config: {
            apiKey: config.credentials.embedApiKey,
            model: config.providers.embedModel,
            embeddingDims: config.providers.embedDimension,
            ...(config.providers.embedBaseUrl ? { baseURL: config.providers.embedBaseUrl } : {}),
          },
        };

  const memory = new Memory({
    version: 'v1.1',
    embedder: embedderConfig,
    llm: llmConfig,
    vectorStore: {
      provider: 'memory',
      config: {
        collectionName: config.storage.collectionName,
        dimension: config.providers.embedDimension,
        dbPath: config.storage.vectorDbPath,
      },
    },
    historyStore: {
      provider: 'sqlite',
      config: {
        historyDbPath: config.storage.historyDbPath,
      },
    },
  });

  return {
    kind: 'oss',
    raw: memory,
    async add(text, options) {
      const res = await memory.add(text, {
        agentId: options.agentId,
        userId: options.userId,
        runId: options.runId,
        metadata: options.metadata,
        infer: options.infer ?? false,
      });
      return res.results || [];
    },
    async search(query, options) {
      const filters = {};
      if (options.agentId) filters.agent_id = options.agentId;
      if (options.userId) filters.user_id = options.userId;
      if (options.runId) filters.run_id = options.runId;
      if (options.category) filters.category = options.category;
      if (options.feature) filters.feature = options.feature;
      const res = await memory.search(query, {
        filters,
        topK: options.topK,
        threshold: options.threshold,
        explain: true,
      });
      return (res.results || []).map((item) => ({
        ...item,
        semanticScore: item.scoreDetails?.semanticScore ?? item.score ?? 0,
      }));
    },
    async update(memoryId, text, metadata) {
      return memory.update(memoryId, { text, metadata });
    },
    async delete(memoryId) {
      return memory.delete(memoryId);
    },
    async getAll(options) {
      const filters = {};
      if (options.agentId) filters.agent_id = options.agentId;
      if (options.userId) filters.user_id = options.userId;
      const res = await memory.getAll({ filters, limit: options.limit || 200 });
      return res.results || [];
    },
    async history(memoryId) {
      return memory.history(memoryId);
    },
    async completeJson(messages) {
      if (!memory.llm || typeof memory.llm.generateResponse !== 'function') {
        return null;
      }
      const out = await memory.llm.generateResponse(messages, { type: 'json_object' });
      const text = typeof out === 'string' ? out : out?.content || '';
      return extractJsonObject(text);
    },
  };
}

/**
 * 适配 Mem0 Cloud Platform (MemoryClient) 为统一底层后端接口。
 */
function createPlatformBackend(config) {
  const { MemoryClient } = require('mem0ai');
  const client = new MemoryClient({
    apiKey: config.credentials.mem0ApiKey,
    host: config.credentials.mem0ApiUrl,
  });

  return {
    kind: 'platform',
    raw: client,
    async add(text, options) {
      const res = await client.add([{ role: 'user', content: text }], {
        agent_id: options.agentId,
        user_id: options.userId,
        run_id: options.runId,
        metadata: options.metadata,
        infer: options.infer ?? true,
        version: 'v2',
      });
      return Array.isArray(res) ? res : res?.results || [];
    },
    async search(query, options) {
      const filters = {
        ...(options.agentId ? { agent_id: options.agentId } : {}),
        ...(options.userId ? { user_id: options.userId } : {}),
      };
      const res = await client.search(query, {
        filters,
        top_k: options.topK,
        threshold: options.threshold,
        version: 'v2',
      });
      const items = Array.isArray(res) ? res : res?.results || [];
      return items.map((item) => ({
        ...item,
        semanticScore: item.score ?? 0,
      }));
    },
    async update(memoryId, text, metadata) {
      return client.update(memoryId, { text, metadata });
    },
    async delete(memoryId) {
      return client.delete(memoryId);
    },
    async getAll(options) {
      const filters = {
        ...(options.agentId ? { agent_id: options.agentId } : {}),
        ...(options.userId ? { user_id: options.userId } : {}),
      };
      const res = await client.getAll({ filters, page_size: options.limit || 100, version: 'v2' });
      return Array.isArray(res) ? res : res?.results || [];
    },
    async history(memoryId) {
      return client.history(memoryId);
    },
    async completeJson() {
      return null;
    },
  };
}

class Mem0Service {
  /**
   * @param {{ cwd?: string; dataDir?: string; mode?: string; backend?: any }} [opts]
   */
  constructor(opts = {}) {
    this.config = resolveMem0Config(opts);
    this._injectedBackend = opts.backend || null;
    this._backend = null;
  }

  _validateCredentials() {
    if (this._injectedBackend) return { ok: true };
    if (this.config.mode === 'platform') {
      if (!this.config.credentials.mem0ApiKey) {
        return { ok: false, code: 'MISSING_MEM0_API_KEY', message: '未设置 MEM0_API_KEY，无法连接 Mem0 Platform。' };
      }
      return { ok: true };
    }
    const { embedProvider, llmProvider } = this.config.providers;
    if (embedProvider === 'none' || !this.config.credentials.embedApiKey) {
      return {
        ok: false,
        code: 'MISSING_EMBED_API_KEY',
        message: '未检测到可用的 Embedding API Key（GOOGLE_API_KEY 或 OPENAI_API_KEY）。请配置环境变量或设置 MEM0_API_KEY。',
      };
    }
    if (llmProvider === 'none' || !this.config.credentials.llmApiKey) {
      return {
        ok: false,
        code: 'MISSING_LLM_API_KEY',
        message: '未检测到可用的 LLM API Key（GOOGLE_API_KEY / OPENAI_API_KEY / MEM0_LLM_API_KEY）。',
      };
    }
    return { ok: true };
  }

  _getBackend() {
    if (this._backend) return this._backend;
    if (this._injectedBackend) {
      this._backend = this._injectedBackend;
      return this._backend;
    }
    const credCheck = this._validateCredentials();
    if (!credCheck.ok) {
      const err = new Error(credCheck.message);
      err.code = credCheck.code;
      throw err;
    }
    this._backend =
      this.config.mode === 'platform'
        ? createPlatformBackend(this.config)
        : createOssBackend(this.config);
    return this._backend;
  }

  _resolveScope(scope = 'repo') {
    const { agentId, userId } = this.config.identity;
    if (scope === 'mine') return { userId };
    if (scope === 'all') return { agentId };
    return { agentId };
  }

  /**
   * 检索相关记忆，并在返回前执行相关性阈值过滤、去重和严格 Token 预算裁剪。
   */
  async search(query, opts = {}) {
    const cleanQuery = redactSecrets(query).trim();
    if (!cleanQuery) {
      return { ok: true, results: [], formatted: '', tokens: 0, filteredOut: 0 };
    }

    try {
      const backend = this._getBackend();
      const topK = Math.min(
        Math.max(1, Number(opts.topK) || this.config.budgets.topK),
        this.config.budgets.maxTopK
      );
      const minSemanticScore =
        opts.minSemanticScore !== undefined
          ? Number(opts.minSemanticScore)
          : this.config.budgets.minSemanticScore;
      const maxContextTokens =
        opts.maxContextTokens !== undefined
          ? Number(opts.maxContextTokens)
          : this.config.budgets.maxContextTokens;
      const timeoutMs = opts.timeoutMs !== undefined ? Number(opts.timeoutMs) : 5000;
      const scopeIds = this._resolveScope(opts.scope || 'repo');

      const rawItems = await withTimeout(
        backend.search(cleanQuery, {
          ...scopeIds,
          category: opts.category ? normalizeCategory(opts.category) : undefined,
          feature: opts.feature || undefined,
          topK: Math.min(topK * 2, 20),
          threshold: Math.max(0.1, minSemanticScore * 0.8),
        }),
        timeoutMs,
        'mem0.search'
      );

      const seenHashes = new Set();
      const accepted = [];
      let filteredOut = 0;
      const highSemanticBypass = opts.highSemanticBypass !== undefined ? Number(opts.highSemanticBypass) : 0.65;

      for (const item of rawItems || []) {
        const text = redactSecrets(item.memory || '').trim();
        if (!text) continue;
        const semantic = Number(item.semanticScore ?? item.score ?? 0);
        if (semantic < minSemanticScore) {
          filteredOut += 1;
          continue;
        }
        const lexicalOverlap = computeLexicalOverlap(cleanQuery, text);
        if (semantic < highSemanticBypass && lexicalOverlap <= 0) {
          filteredOut += 1;
          continue;
        }
        if (opts.category && item.metadata?.category && item.metadata.category !== normalizeCategory(opts.category)) {
          filteredOut += 1;
          continue;
        }
        const h = hashMemoryText(text);
        if (seenHashes.has(h)) {
          filteredOut += 1;
          continue;
        }
        seenHashes.add(h);
        const rankScore = semantic + 0.15 * Math.min(lexicalOverlap, 1);
        accepted.push({
          id: item.id,
          memory: text,
          score: Number(rankScore.toFixed(4)),
          semanticScore: Number(semantic.toFixed(4)),
          lexicalOverlap: Number(lexicalOverlap.toFixed(3)),
          category: item.metadata?.category || 'general',
          source: item.metadata?.source || 'mem0',
          feature: item.metadata?.feature || undefined,
          updatedAt: item.updatedAt || item.createdAt,
          metadata: item.metadata || {},
        });
      }

      accepted.sort((a, b) => b.score - a.score);
      const topAccepted = accepted.slice(0, topK);

      const { formatted, included, tokens } = this.formatRecallContext(topAccepted, {
        maxContextTokens,
        maxItemChars: this.config.budgets.maxItemChars,
      });

      return {
        ok: true,
        results: included,
        formatted,
        tokens,
        filteredOut,
      };
    } catch (error) {
      return {
        ok: false,
        degraded: true,
        code: error.code || 'MEM0_SEARCH_ERROR',
        error: error.message || String(error),
        results: [],
        formatted: '',
        tokens: 0,
        filteredOut: 0,
      };
    }
  }

  /**
   * 在严格 Token 预算内格式化召回上下文，防止无关内容撑爆上下文窗口。
   */
  formatRecallContext(items, opts = {}) {
    const maxContextTokens = opts.maxContextTokens ?? this.config.budgets.maxContextTokens;
    const maxItemChars = opts.maxItemChars ?? this.config.budgets.maxItemChars;
    if (!items || items.length === 0) {
      return { formatted: '', included: [], tokens: 0 };
    }

    const header = '以下是来自 mem0 长期记忆的项目历史经验（仅作高相关上下文参考）：';
    let usedTokens = estimateTokens(header);
    const lines = [header];
    const included = [];

    for (const item of items) {
      const cleanText = item.memory.length > maxItemChars
        ? `${item.memory.slice(0, maxItemChars - 3)}...`
        : item.memory;
      const tag = `[${item.category}${item.feature ? `/${item.feature}` : ''}]`;
      const line = `- ${tag} ${cleanText}`;
      const lineTokens = estimateTokens(line);
      if (usedTokens + lineTokens > maxContextTokens) {
        if (included.length === 0) {
          const budgetLeft = Math.max(40, maxContextTokens - usedTokens);
          const trimmed = truncateToTokenBudget(line, budgetLeft);
          if (trimmed) {
            lines.push(trimmed);
            included.push(item);
            usedTokens += estimateTokens(trimmed);
          }
        }
        break;
      }
      lines.push(line);
      included.push(item);
      usedTokens += lineTokens;
    }

    const formatted = included.length > 0 ? lines.join('\n') : '';
    return {
      formatted,
      included,
      tokens: formatted ? estimateTokens(formatted) : 0,
    };
  }

  /**
   * 写入并自动去重/更新/作废冲突记忆（ADD / UPDATE / DELETE / NONE）。
   */
  async capture(input, opts = {}) {
    const rawText = Array.isArray(input)
      ? input.map((m) => `${m.role || 'user'}: ${m.content || ''}`).join('\n')
      : String(input || '');
    const cleanText = boundedRedacted(rawText, this.config.budgets.maxExtractionChars);

    if (isNoisyContent(cleanText, opts.curated ? 6 : this.config.budgets.minPromptChars)) {
      return { ok: true, operations: [], skippedReason: 'noisy_or_too_short' };
    }

    try {
      const backend = this._getBackend();
      const scopeIds = this._resolveScope(opts.scope || 'repo');
      const defaultCategory = normalizeCategory(opts.category || 'decisions');
      const timeoutMs = opts.timeoutMs !== undefined ? Number(opts.timeoutMs) : 15000;

      let candidates = [];
      if (opts.curated) {
        candidates = [
          {
            text: cleanText,
            category: defaultCategory,
            importance: opts.importance === 'high' ? 'high' : 'normal',
          },
        ];
      } else {
        let extracted = null;
        try {
          const messages = buildExtractionPrompt(cleanText, {
            repoSlug: this.config.identity.repoSlug,
            branch: this.config.identity.branch,
            feature: opts.feature,
          });
          extracted = await withTimeout(backend.completeJson(messages), timeoutMs, 'mem0.extract');
        } catch (_) {
          extracted = null;
        }

        if (extracted && Array.isArray(extracted.facts)) {
          candidates = extracted.facts
            .filter((f) => f && typeof f.text === 'string' && !isNoisyContent(f.text, 10))
            .slice(0, 6)
            .map((f) => ({
              text: redactSecrets(f.text).trim(),
              category: normalizeCategory(f.category || defaultCategory),
              importance: f.importance === 'high' ? 'high' : 'normal',
            }));
        } else if (backend.kind === 'platform') {
          const added = await withTimeout(
            backend.add(cleanText, {
              ...scopeIds,
              runId: opts.runId,
              infer: true,
              metadata: {
                category: defaultCategory,
                source: opts.source || 'auto_capture',
                repo: this.config.identity.repoRemote,
                branch: this.config.identity.branch,
                ...(opts.feature ? { feature: opts.feature } : {}),
              },
            }),
            timeoutMs,
            'mem0.platform_add'
          );
          return {
            ok: true,
            operations: added.map((a) => ({ event: a.metadata?.event || 'ADD', id: a.id, memory: a.memory })),
          };
        }
      }

      if (candidates.length === 0) {
        return { ok: true, operations: [], skippedReason: 'no_extractable_facts' };
      }

      let existingAll = [];
      try {
        existingAll = await withTimeout(backend.getAll({ ...scopeIds, limit: 300 }), 5000, 'mem0.getAll');
      } catch (_) {
        existingAll = [];
      }
      const existingHashes = new Set();
      for (const item of existingAll) {
        const h = item.metadata?.content_hash || hashMemoryText(item.memory || '');
        if (h) existingHashes.add(h);
      }

      const operations = [];
      for (const fact of candidates) {
        const contentHash = hashMemoryText(fact.text);
        if (existingHashes.has(contentHash)) {
          operations.push({ event: 'NONE', reason: 'exact_hash_duplicate', memory: fact.text, category: fact.category });
          continue;
        }

        let neighbors = [];
        try {
          neighbors = await withTimeout(
            backend.search(fact.text, {
              ...scopeIds,
              topK: 5,
              threshold: Math.min(0.55, this.config.budgets.dedupUpdateThreshold),
            }),
            timeoutMs,
            'mem0.neighbor_search'
          );
        } catch (_) {
          neighbors = [];
        }

        const topMatch = neighbors[0];
        const topSemantic = Number(topMatch?.semanticScore ?? topMatch?.score ?? 0);

        if (topMatch && topSemantic >= this.config.budgets.dedupSkipThreshold) {
          operations.push({
            event: 'NONE',
            reason: 'semantic_duplicate',
            matchedId: topMatch.id,
            similarity: topSemantic,
            memory: fact.text,
            category: fact.category,
          });
          continue;
        }

        let decided = { action: 'ADD', text: fact.text };
        if (topMatch && topSemantic >= this.config.budgets.dedupUpdateThreshold) {
          try {
            const reconciled = await withTimeout(
              backend.completeJson(buildReconcilePrompt(fact, neighbors.slice(0, 4))),
              timeoutMs,
              'mem0.reconcile'
            );
            if (reconciled && typeof reconciled.action === 'string') {
              const act = reconciled.action.toUpperCase();
              const idx = Number(reconciled.targetIdx);
              const target = Number.isInteger(idx) && neighbors[idx] ? neighbors[idx] : topMatch;
              if (act === 'NONE') {
                decided = { action: 'NONE', reason: reconciled.reason || 'llm_dedup' };
              } else if (act === 'UPDATE' && target?.id) {
                decided = {
                  action: 'UPDATE',
                  targetId: target.id,
                  text: redactSecrets(reconciled.text || fact.text).trim(),
                  reason: reconciled.reason,
                };
              } else if (act === 'DELETE' && target?.id) {
                decided = {
                  action: 'DELETE',
                  targetId: target.id,
                  text: reconciled.text ? redactSecrets(reconciled.text).trim() : '',
                  reason: reconciled.reason,
                };
              }
            }
          } catch (_) {
            // LLM 仲裁失败时保守退化为 ADD
          }
        }

        const baseMetadata = {
          category: fact.category,
          importance: fact.importance,
          source: opts.source || 'auto_capture',
          repo: this.config.identity.repoRemote,
          branch: this.config.identity.branch,
          content_hash: hashMemoryText(decided.text || fact.text),
          ...(opts.feature ? { feature: opts.feature } : {}),
          ...(opts.docPath ? { doc_path: opts.docPath } : {}),
        };

        if (decided.action === 'NONE') {
          operations.push({ event: 'NONE', reason: decided.reason || 'dedup', memory: fact.text, category: fact.category });
          continue;
        }

        if (decided.action === 'UPDATE' && decided.targetId) {
          await withRateLimitRetry(
            () => withTimeout(backend.update(decided.targetId, decided.text, baseMetadata), timeoutMs, 'mem0.update'),
            { allowRetry: opts.retryOnRateLimit !== false }
          );
          existingHashes.add(baseMetadata.content_hash);
          operations.push({
            event: 'UPDATE',
            id: decided.targetId,
            memory: decided.text,
            category: fact.category,
            reason: decided.reason,
          });
          continue;
        }

        if (decided.action === 'DELETE' && decided.targetId) {
          await withRateLimitRetry(
            () => withTimeout(backend.delete(decided.targetId), timeoutMs, 'mem0.delete'),
            { allowRetry: opts.retryOnRateLimit !== false }
          );
          operations.push({
            event: 'DELETE',
            id: decided.targetId,
            reason: decided.reason,
          });
          if (decided.text && !isNoisyContent(decided.text, 8)) {
            const added = await withRateLimitRetry(
              () => withTimeout(
                backend.add(decided.text, {
                  ...scopeIds,
                  runId: opts.runId,
                  infer: false,
                  metadata: baseMetadata,
                }),
                timeoutMs,
                'mem0.add_after_delete'
              ),
              { allowRetry: opts.retryOnRateLimit !== false }
            );
            existingHashes.add(baseMetadata.content_hash);
            for (const a of added) {
              operations.push({ event: 'ADD', id: a.id, memory: a.memory || decided.text, category: fact.category });
            }
          }
          continue;
        }

        const added = await withRateLimitRetry(
          () => withTimeout(
            backend.add(fact.text, {
                ...scopeIds,
                runId: opts.runId,
                infer: false,
                metadata: baseMetadata,
              }),
            timeoutMs,
            'mem0.add'
          ),
          { allowRetry: opts.retryOnRateLimit !== false }
        );
            existingHashes.add(baseMetadata.content_hash);
            for (const a of added) {
              operations.push({ event: 'ADD', id: a.id, memory: a.memory || fact.text, category: fact.category });
            }
      }

      return { ok: true, operations };
    } catch (error) {
      return {
        ok: false,
        degraded: true,
        code: error.code || 'MEM0_CAPTURE_ERROR',
        error: error.message || String(error),
        operations: [],
      };
    }
  }

  async update(memoryId, text, metadata = {}) {
    const cleanText = redactSecrets(text).trim();
    if (!memoryId || !cleanText) {
      return { ok: false, error: 'memoryId 与 text 不能为空' };
    }
    try {
      const backend = this._getBackend();
      const nextMeta = {
        ...metadata,
        ...(metadata.category ? { category: normalizeCategory(metadata.category) } : {}),
        content_hash: hashMemoryText(cleanText),
      };
      const res = await backend.update(memoryId, cleanText, nextMeta);
      return { ok: true, id: memoryId, memory: cleanText, result: res };
    } catch (error) {
      return { ok: false, code: error.code || 'MEM0_UPDATE_ERROR', error: error.message || String(error) };
    }
  }

  async delete(memoryId) {
    if (!memoryId) return { ok: false, error: 'memoryId 不能为空' };
    try {
      const backend = this._getBackend();
      const res = await backend.delete(memoryId);
      return { ok: true, id: memoryId, result: res };
    } catch (error) {
      return { ok: false, code: error.code || 'MEM0_DELETE_ERROR', error: error.message || String(error) };
    }
  }

  async list(opts = {}) {
    try {
      const backend = this._getBackend();
      const scopeIds = this._resolveScope(opts.scope || 'repo');
      const items = await backend.getAll({ ...scopeIds, limit: opts.limit || 200 });
      const cat = opts.category ? normalizeCategory(opts.category) : null;
      const filtered = cat ? items.filter((i) => i.metadata?.category === cat) : items;
      return {
        ok: true,
        total: filtered.length,
        results: filtered.slice(0, opts.limit || 50).map((item) => ({
          id: item.id,
          memory: redactSecrets(item.memory || ''),
          category: item.metadata?.category || 'general',
          source: item.metadata?.source || 'mem0',
          feature: item.metadata?.feature,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })),
      };
    } catch (error) {
      return { ok: false, code: error.code || 'MEM0_LIST_ERROR', error: error.message || String(error), results: [] };
    }
  }

  async history(memoryId) {
    try {
      const backend = this._getBackend();
      const items = await backend.history(memoryId);
      return { ok: true, history: items || [] };
    } catch (error) {
      return { ok: false, code: error.code || 'MEM0_HISTORY_ERROR', error: error.message || String(error), history: [] };
    }
  }

  async stats() {
    const listed = await this.list({ limit: 1000 });
    if (!listed.ok) return listed;
    const byCategory = {};
    for (const c of MEMORY_CATEGORIES) byCategory[c] = 0;
    for (const item of listed.results) {
      const c = item.category || 'general';
      byCategory[c] = (byCategory[c] || 0) + 1;
    }
    return {
      ok: true,
      total: listed.total,
      byCategory,
      mode: this.config.mode,
      dataDir: this.config.dataDir,
    };
  }

  async doctor({ live = false } = {}) {
    const diag = this.config.diagnostics();
    const cred = this._validateCredentials();
    let storageWritable = false;
    try {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
      const probeFile = path.join(this.config.dataDir, `.probe-${process.pid}`);
      fs.writeFileSync(probeFile, 'ok');
      fs.unlinkSync(probeFile);
      storageWritable = true;
    } catch (_) {
      storageWritable = false;
    }

    let liveProbe = null;
    if (live && cred.ok) {
      try {
        const backend = this._getBackend();
        await withTimeout(backend.getAll({ ...this._resolveScope('repo'), limit: 1 }), 5000, 'doctor.live');
        liveProbe = { ok: true };
      } catch (e) {
        liveProbe = { ok: false, error: e.message || String(e) };
      }
    }

    return {
      ok: cred.ok && storageWritable && (liveProbe ? liveProbe.ok : true),
      credentials: cred,
      storageWritable,
      liveProbe,
      diagnostics: diag,
    };
  }
}

module.exports = {
  Mem0Service,
  normalizeCategory,
  hashMemoryText,
  extractJsonObject,
  buildExtractionPrompt,
  buildReconcilePrompt,
};
