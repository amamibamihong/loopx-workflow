'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { redactSecrets, boundedRedacted } = require('./redact');

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function readManifest(manifestPath) {
  try {
    if (!fs.existsSync(manifestPath)) return { files: {} };
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return data && typeof data === 'object' && data.files ? data : { files: {} };
  } catch (_) {
    return { files: {} };
  }
}

function writeManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, manifestPath);
}

/**
 * 按 Markdown 章节切分文档为紧致知识块（控制单块长度，减少无效 Token 提取）。
 * @param {string} content
 * @param {number} [maxChunkChars=2800]
 */
function splitMarkdownSections(content, maxChunkChars = 2800) {
  const cleaned = redactSecrets(content).trim();
  if (!cleaned) return [];
  const lines = cleaned.split(/\r?\n/);
  const rawSections = [];
  let currentHeading = '';
  let buffer = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body.length < 40) return;
    const text = currentHeading ? `${currentHeading}\n${body}` : body;
    rawSections.push(boundedRedacted(text, maxChunkChars));
  };

  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line) && buffer.length > 0) {
      flush();
      currentHeading = line.trim();
      buffer = [];
    } else if (/^#{1,3}\s+/.test(line) && !currentHeading) {
      currentHeading = line.trim();
    } else {
      buffer.push(line);
    }
  }
  flush();

  // 合并相邻小章节以显著降低 LLM 提取和 Embedding 调用次数
  const merged = [];
  let current = '';
  for (const sec of rawSections) {
    if (!current) {
      current = sec;
    } else if (current.length + sec.length + 2 <= maxChunkChars) {
      current = `${current}\n\n${sec}`;
    } else {
      merged.push(current);
      current = sec;
    }
  }
  if (current) merged.push(current);
  return merged;
}

/**
 * 收集仓库核心知识源文件及对应 mem0 类别。
 * @param {string} projectRoot
 * @param {{ includeCapsules?: boolean }} [opts]
 */
function collectKnowledgeSources(projectRoot, opts = {}) {
  const entries = [];
  const addIfExists = (relPath, category, feature) => {
    const absPath = path.join(projectRoot, relPath);
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      entries.push({ relPath, absPath, category, feature });
    }
  };

  addIfExists('AGENTS.md', 'conventions');
  addIfExists('docs/prd/loopx-workflow.md', 'business_rules');
  addIfExists('docs/design/loopx-workflow-design.md', 'architecture');

  const adrDir = path.join(projectRoot, 'docs', 'adr');
  if (fs.existsSync(adrDir)) {
    for (const name of fs.readdirSync(adrDir).sort()) {
      if (/^\d{4}-.*\.md$/.test(name)) {
        addIfExists(path.join('docs', 'adr', name), 'decisions');
      }
    }
  }

  if (opts.includeCapsules) {
    for (const bucket of ['features', 'archive']) {
      const dir = path.join(projectRoot, 'specs', bucket);
      if (!fs.existsSync(dir)) continue;
      for (const feat of fs.readdirSync(dir).sort()) {
        if (feat.startsWith('.') || feat.includes("'") || feat.startsWith('cq-isolated-')) continue;
        const featDir = path.join(dir, feat);
        try {
          if (!fs.statSync(featDir).isDirectory()) continue;
        } catch (_) {
          continue;
        }
        addIfExists(path.join('specs', bucket, feat, '01-decisions.md'), 'decisions', feat);
        addIfExists(path.join('specs', bucket, feat, '05-evidence.md'), 'troubleshooting', feat);
      }
    }
  }

  return entries;
}

/**
 * 增量同步仓库文档与历史交付经验到 mem0（未改动的文件直接跳过）。
 */
async function syncRepositoryKnowledge(service, opts = {}) {
  const projectRoot = service.config.identity.projectRoot;
  const manifestPath = service.config.storage.manifestPath;
  const manifest = opts.force ? { files: {} } : readManifest(manifestPath);
  const sources = Array.isArray(opts.files) && opts.files.length > 0
    ? opts.files.map((f) => ({
        relPath: f.relPath || f,
        absPath: path.isAbsolute(f.absPath || f) ? (f.absPath || f) : path.join(projectRoot, f.relPath || f),
        category: f.category || 'decisions',
        feature: f.feature,
      })).filter((x) => fs.existsSync(x.absPath))
    : collectKnowledgeSources(projectRoot, { includeCapsules: Boolean(opts.includeCapsules) });

  const summary = {
    ok: true,
    scanned: sources.length,
    syncedFiles: [],
    skippedUnchanged: 0,
    operations: [],
    errors: [],
  };

  for (const src of sources) {
    try {
      const content = fs.readFileSync(src.absPath, 'utf8');
      const fileHash = sha256(content);
      if (!opts.force && manifest.files[src.relPath]?.hash === fileHash) {
        summary.skippedUnchanged += 1;
        continue;
      }

      const chunks = splitMarkdownSections(content).slice(0, 3);
      let fileHadError = false;
      for (const chunk of chunks) {
        const promptInput = `[文件来源: ${src.relPath}${src.feature ? ` | feature: ${src.feature}` : ''}]\n${chunk}`;
        const res = await service.capture(promptInput, {
          category: src.category,
          feature: src.feature,
          docPath: src.relPath,
          source: 'repo_sync',
          curated: false,
          timeoutMs: 15000,
        });
        if (!res.ok) {
          fileHadError = true;
          summary.errors.push({ file: src.relPath, error: res.error });
          break;
        }
        summary.operations.push(...res.operations);
      }

      if (!fileHadError) {
        manifest.files[src.relPath] = {
          hash: fileHash,
          category: src.category,
          syncedAt: new Date().toISOString(),
        };
        summary.syncedFiles.push(src.relPath);
        writeManifest(manifestPath, manifest);
      }
    } catch (err) {
      summary.errors.push({ file: src.relPath, error: err.message || String(err) });
    }
  }

  writeManifest(manifestPath, manifest);
  if (summary.errors.length > 0 && summary.syncedFiles.length === 0 && summary.skippedUnchanged === 0) {
    summary.ok = false;
  }
  return summary;
}

/**
 * 在 loopx-flow approve / check / merge 时轻量捕获特征胶囊关键决策与问题解决结论。
 */
async function syncFeatureCapsule(service, feature, stage = 'approve') {
  if (!feature) return { ok: true, skipped: true };
  const root = service.config.identity.projectRoot;
  const baseDir = fs.existsSync(path.join(root, 'specs', 'features', feature))
    ? path.join('specs', 'features', feature)
    : path.join('specs', 'archive', feature);

  const targets = [];
  if (stage === 'approve') {
    targets.push({ relPath: path.join(baseDir, '01-decisions.md'), category: 'decisions', feature });
    targets.push({ relPath: path.join(baseDir, '04-contract.md'), category: 'business_rules', feature });
  } else if (stage === 'check' || stage === 'merge') {
    targets.push({ relPath: path.join(baseDir, '01-decisions.md'), category: 'decisions', feature });
    targets.push({ relPath: path.join(baseDir, '05-evidence.md'), category: 'troubleshooting', feature });
  }
  return syncRepositoryKnowledge(service, { files: targets });
}

module.exports = {
  readManifest,
  writeManifest,
  splitMarkdownSections,
  collectKnowledgeSources,
  syncRepositoryKnowledge,
  syncFeatureCapsule,
};
