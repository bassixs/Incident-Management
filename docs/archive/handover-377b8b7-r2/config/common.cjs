'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const req = require('node:module').createRequire(path.resolve(process.cwd(), 'package.json'));
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v);
const hash = value => crypto.createHash('sha256').update(json(value)).digest('hex');
function save(file, value) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, json(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
async function api(method, suffix) {
  const base = (process.env.MAX_API_BASE_URL || 'https://platform-api2.max.ru').replace(/\/$/, '');
  const response = await fetch(base + suffix, { method, headers: { Authorization: process.env.BOT_TOKEN }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Object.assign(new Error('MAX request failed'), { safeCode: `MAX_HTTP_${response.status}` });
  const result = await response.json();
  if (result.success === false) throw Object.assign(new Error('MAX refused operation'), { safeCode: 'MAX_REFUSED' });
  return result;
}
function safeError(e) { return /^MAX_HTTP_\d+$|^MAX_REFUSED$/.test(e?.safeCode || '') ? e.safeCode : 'CHECK_FAILED'; }
const panel = row => /^(distribution-panel|work-panel):/.test(row.key);
module.exports = { fs, path, req, json, hash, save, api, safeError, panel };
