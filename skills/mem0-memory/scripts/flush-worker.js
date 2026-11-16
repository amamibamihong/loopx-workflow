'use strict';

if (!process.env.MEM0_TELEMETRY) {
  process.env.MEM0_TELEMETRY = 'false';
}

const fs = require('node:fs');
const path = require('node:path');
const { Mem0Service } = require('./engine');

async function processHandoff(handoffPath, serviceFactory = (cwd, dataDir) => new Mem0Service({ cwd, dataDir })) {
  if (!handoffPath || !fs.existsSync(handoffPath)) {
    return { ok: true, skipped: true, reason: 'missing_handoff' };
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
  } catch (err) {
    try {
      fs.unlinkSync(handoffPath);
    } catch (_) {}
    return { ok: false, error: `invalid handoff json: ${err.message}` };
  }

  const service = serviceFactory(payload.cwd, payload.dataDir);
  const res = await service.capture(payload.messages || [], {
    source: `codex_${payload.reason || 'session'}`,
    runId: payload.sessionId,
    curated: false,
    timeoutMs: 20000,
  });

  const logPath = path.join(service.config.dataDir, 'flush-worker.log');
  try {
    fs.mkdirSync(service.config.dataDir, { recursive: true });
    const line = `${new Date().toISOString()} session=${payload.sessionId} ok=${res.ok} ops=${(res.operations || []).map((o) => o.event).join(',') || 'none'}${res.error ? ` err=${res.error}` : ''}\n`;
    fs.appendFileSync(logPath, line);
  } catch (_) {}

  try {
    fs.unlinkSync(handoffPath);
  } catch (_) {}

  return res;
}

if (require.main === module) {
  const handoffPath = process.argv[2];
  processHandoff(handoffPath)
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}

module.exports = { processHandoff };
