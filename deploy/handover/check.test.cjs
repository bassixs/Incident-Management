const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, formatDiagnostic, Diagnostic } = require('./check.cjs');

const env = {
  NODE_ENV: 'production', BOT_MODE: 'webhook', WEBHOOK_AUTO_REGISTER: 'false',
  BOT_TOKEN: 'privateBotToken_DO_NOT_PRINT', WEBHOOK_SECRET: 'privateWebhookSecret_DO_NOT_PRINT',
  POSTGRES_USER: 'incident', POSTGRES_DB: 'incident', POSTGRES_PASSWORD: 'privateDatabasePassword_DO_NOT_PRINT',
  DATABASE_URL: 'postgresql://incident:privateDatabasePassword_DO_NOT_PRINT@postgres:5432/incident',
  PUBLIC_DOMAIN: 'test.invalid', WEBHOOK_URL: 'https://test.invalid/webhook/max',
  DISTRIBUTION_CHAT_ID: '-1', REVIEW_CHAT_ID: '-2', DELIVERY_ALERT_CHAT_ID: '-3',
};
const config = {
  ...env, MAX_API_BASE_URL: 'https://platform-api2.max.ru', WEBHOOK_PATH: '/webhook/max',
  MEDIA_STORAGE: 'local', mediaLocalAbsolutePath: '/app/data/uploads', LOG_PRETTY: false,
  DAILY_INCIDENT_LIMIT: 3, INCIDENT_MAX_LENGTH: 150, LEGAL_CONSENT_REQUIRED: false,
  LEGAL_DOCUMENTS_BASE_URL: 'https://test.invalid/documents',
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-check-unit-'));
fs.mkdirSync(path.join(root, 'config')); fs.mkdirSync(path.join(root, 'data'));
fs.writeFileSync(path.join(root, 'config/business-settings.env'), 'DISTRIBUTION_CHAT_ID=-1\nREVIEW_CHAT_ID=-2\nDELIVERY_ALERT_CHAT_ID=-3\n');
fs.writeFileSync(path.join(root, 'data/prepared-manifest.json'), JSON.stringify(Array.from({ length: 26 }, (_, i) => ({ schema: 'public', table: 'Table' + String.fromCharCode(65 + i), count: 0, digest: 'd41d8cd98f00b204e9800998ecf8427e' }))));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const dependencies = {
  require(name) {
    if (name === './dist/config') return { loadConfig: () => config };
    if (name === 'dotenv') return require('dotenv');
    throw new Error('Unexpected dependency ' + name);
  },
};
async function invoke(options = {}) {
  const lines = [];
  const code = await run({ env, packageRoot: root, dependencies, output: { log: s => lines.push(s), error: s => lines.push(s) }, ...options });
  const text = lines.join('\n');
  for (const key of ['BOT_TOKEN', 'WEBHOOK_SECRET', 'POSTGRES_PASSWORD', 'DATABASE_URL']) assert.ok(!text.includes(env[key]), key + ' leaked');
  return { code, text };
}

test('each mode setting reports actual and expected for all three keys', async () => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'development', BOT_MODE: 'polling', WEBHOOK_AUTO_REGISTER: 'true' })) {
    const r = await invoke({ env: { ...env, [key]: value } });
    assert.equal(r.code, 1); assert.match(r.text, /CONFIG_MODE_VALUES/);
    for (const name of ['NODE_ENV', 'BOT_MODE', 'WEBHOOK_AUTO_REGISTER']) assert.ok(r.text.includes(name + ': фактически'));
    assert.ok(r.text.includes(JSON.stringify(value)));
  }
});
test('sensitive value accidentally pasted into a nonsecret mode field is redacted', async () => {
  const r = await invoke({ env: { ...env, NODE_ENV: env.BOT_TOKEN } });
  assert.equal(r.code, 1); assert.match(r.text, /REDACTED/);
});
test('password policy and placeholders are rejected before loading dependencies', async () => {
  assert.match((await invoke({ env: { ...env, POSTGRES_PASSWORD: 'short' } })).text, /CONFIG_DB_PASSWORD/);
  assert.match((await invoke({ env: { ...env, BOT_TOKEN: 'REPLACE_WITH_TOKEN' } })).text, /CONFIG_PLACEHOLDER/);
});
test('empty restored DB has a concrete restore step and disconnects', async () => {
  let closed = false;
  const prisma = { $queryRawUnsafe: async q => q === 'SELECT 1' ? [{ ok: 1 }] : [], $disconnect: async () => { closed = true; } };
  const r = await invoke({ mode: 'database', dependencies: { ...dependencies, prisma } });
  assert.equal(r.code, 1); assert.match(r.text, /DB_EMPTY/); assert.match(r.text, /data\/database.dump/); assert.ok(closed);
});
test('partial schema is not treated as a safely overwritable empty database', async () => {
  const prisma = { $queryRawUnsafe: async q => q === 'SELECT 1' ? [] : [{ schemaname: 'public', tablename: 'TableA' }], $disconnect: async () => {} };
  const r = await invoke({ mode: 'database', dependencies: { ...dependencies, prisma } });
  assert.equal(r.code, 1); assert.match(r.text, /DB_TABLES_MISSING/); assert.match(r.text, /не повторяйте импорт/);
});
test('DB and MAX error codes never expose raw message, query, stack or response', () => {
  const cases = [
    ['database/connection', { errorCode: 'P1000' }, 'DB_AUTH'],
    ['database/connection', { code: 'P1001' }, 'DB_UNREACHABLE'],
    ['database/connection', { code: 'P1003' }, 'DB_NOT_FOUND'],
    ['database/schema', { code: 'P2010', meta: { code: '42P01' } }, 'DB_TABLES_MISSING'],
    ['database/data', { code: 'untrusted_secret_code' }, 'DB_ERROR'],
    ['MAX/identity', { status: 401 }, 'MAX_AUTH_401'],
    ['MAX/chat', { status: 403 }, 'MAX_ACCESS_403'],
    ['MAX/chat', { status: 503 }, 'MAX_TEMPORARY_503'],
    ['MAX/identity', { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }, 'MAX_TLS'],
    ['MAX/identity', {}, 'MAX_NETWORK'],
  ];
  for (const [stage, fields, expected] of cases) {
    const secret = Object.values(env).join(' ');
    const output = formatDiagnostic({ ...fields, message: secret, stack: secret, response: { data: secret } }, stage, env);
    assert.ok(output.includes(expected));
    for (const key of ['BOT_TOKEN', 'WEBHOOK_SECRET', 'POSTGRES_PASSWORD', 'DATABASE_URL']) assert.ok(!output.includes(env[key]));
    assert.ok(!output.includes('untrusted_secret_code'));
  }
});
test('actual MAX call failure through the checker is safe and names the step', async () => {
  const r = await invoke({ mode: 'identity', dependencies: { ...dependencies, max: { getMe: async () => { throw { status: 401, message: env.BOT_TOKEN }; } } } });
  assert.equal(r.code, 1); assert.match(r.text, /MAX\/identity.*MAX_AUTH_401/);
});
test('even controlled messages redact credential and encoded-credential values', () => {
  const text = formatDiagnostic(new Diagnostic('SAFE', env.DATABASE_URL + env.WEBHOOK_SECRET, encodeURIComponent(env.POSTGRES_PASSWORD)), 'configuration', env);
  for (const key of ['DATABASE_URL', 'WEBHOOK_SECRET', 'POSTGRES_PASSWORD']) assert.ok(!text.includes(env[key]));
});
test('Prisma initialization errors without structured codes classify fixed signatures without revealing text', () => {
  for (const [message, expected] of [
    ['Authentication failed against database server at postgres. ' + env.DATABASE_URL, 'DB_AUTH'],
    ["Can't reach database server at postgres. " + env.DATABASE_URL, 'DB_UNREACHABLE'],
  ]) {
    const output = formatDiagnostic(new Error(message), 'database/connection', env);
    assert.ok(output.includes(expected));
    assert.ok(!output.includes(env.DATABASE_URL));
    assert.ok(!output.includes(env.POSTGRES_PASSWORD));
  }
});
