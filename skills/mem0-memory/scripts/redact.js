'use strict';

/**
 * 隐私保护、密钥脱敏、噪声过滤与 Token 预算控制工具。
 * 所有文本在写入本地缓冲、发送给 Embedding/LLM 或注入 Codex 上下文前必须经过本模块处理。
 */

const SECRET_PATTERNS = [
  // Authorization / Bearer headers
  { re: /((?:authorization|x-api-key|x-openai-actor-authorization)\s*[:=]\s*(?:bearer|token|basic)?\s*)[^\s"']+/gi, repl: '$1[REDACTED]' },
  // Common API keys & tokens (OpenAI, Mem0, Google AIza, GitHub, AWS, Slack, Stripe, etc.)
  { re: /\b(?:sk|m0|mem0_sk|psk)-[A-Za-z0-9_\-]{12,}\b/g, repl: '[REDACTED]' },
  { re: /\bAIza[0-9A-Za-z_\-]{20,}\b/g, repl: '[REDACTED]' },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{12,}\b/g, repl: '[REDACTED]' },
  { re: /\b(?:ASIA|AKIA)[A-Z0-9]{12,}\b/g, repl: '[REDACTED]' },
  { re: /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g, repl: '[REDACTED]' },
  // PEM private keys
  { re: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, repl: '[REDACTED_PRIVATE_KEY]' },
  // JSON key-value secrets
  { re: /("(?:api[_-]?key|password|secret(?:[_-]?access[_-]?key)?|(?:access|refresh|session)[_-]?token|token|authorization|credential|experimental_bearer_token)"\s*:\s*")((?:\\.|[^"\\])*)(")/gi, repl: '$1[REDACTED]$3' },
  // Env / key=value assignments for sensitive keys
  { re: /^(\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*)(['"]?)[^\r\n'"]+\2/gm, repl: '$1[REDACTED]' },
  // URL query secrets (?key=..., &token=...)
  { re: /([?&](?:key|api_key|token|access_token|secret)=)[^&\s"']+/gi, repl: '$1[REDACTED]' },
];

const TRIVIAL_NOISE_RE = /^(?:ok|okay|yes|no|sure|thanks|thank you|got it|done|hi|hello|hey|pong|继续|好的|收到|谢谢|明白|行|嗯+|哈哈+)\.?$/i;

/**
 * 对任意输入执行密钥与敏感凭据脱敏。
 * @param {unknown} value
 * @returns {string}
 */
function redactSecrets(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (!text) return '';
  for (const { re, repl } of SECRET_PATTERNS) {
    text = text.replace(re, repl);
  }
  return text;
}

/**
 * 对敏感值做安全掩码预览（仅用于 doctor / 日志诊断）。
 * @param {string | undefined | null} value
 * @returns {string}
 */
function maskSecret(value) {
  if (!value || typeof value !== 'string') return '<unset>';
  const trimmed = value.trim();
  if (!trimmed) return '<unset>';
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/**
 * 估算中英文混排文本的 Token 数量（偏保守，避免超预算）。
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (!text) return 0;
  let cjkCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjkCount += 1;
    }
  }
  const nonCjkCount = text.length - cjkCount;
  return Math.ceil(cjkCount / 1.4 + nonCjkCount / 3.8);
}

/**
 * 在 Token 预算内截断文本。
 * @param {string} text
 * @param {number} maxTokens
 * @returns {string}
 */
function truncateToTokenBudget(text, maxTokens) {
  const clean = String(text || '').trim();
  if (!clean || maxTokens <= 0) return '';
  if (estimateTokens(clean) <= maxTokens) return clean;

  let low = 0;
  let high = clean.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(clean.slice(0, mid)) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const slice = clean.slice(0, Math.max(0, low)).trimEnd();
  return slice.length < clean.length ? `${slice}...` : slice;
}

/**
 * 判定文本是否属于无需写入长期记忆的噪声/寒暄/空内容。
 * @param {string} text
 * @param {number} [minChars=15]
 * @returns {boolean}
 */
function isNoisyContent(text, minChars = 15) {
  const clean = String(text || '').trim();
  if (!clean) return true;
  if (clean.length < minChars) return true;
  if (TRIVIAL_NOISE_RE.test(clean)) return true;
  // 纯栈追踪或纯哈希无语义信息
  if (/^(?:[a-f0-9]{32,64}|at\s+\S+\s+\([^)]+\)\s*)+$/i.test(clean)) return true;
  return false;
}

/**
 * 对文本先脱敏再按最大字符数截断（用于写入提取前控制成本）。
 * @param {unknown} value
 * @param {number} maxChars
 * @returns {string}
 */
function boundedRedacted(value, maxChars) {
  const clean = redactSecrets(value).trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}\n...[truncated ${clean.length - maxChars} chars]`;
}

module.exports = {
  SECRET_PATTERNS,
  redactSecrets,
  maskSecret,
  estimateTokens,
  truncateToTokenBudget,
  isNoisyContent,
  boundedRedacted,
};
