// Isolated clean-install acceptance. No production config, DB or MAX API access.
// node tools/handover-smoke.cjs /absolute/r2.zip /absolute/new-test-directory
// Docker/Compose required. All created names use a unique handover-smoke-* prefix.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const [archive, work] = process.argv.slice(2);
if (!archive || !work || !path.isAbsolute(archive) || !path.isAbsolute(work) || fs.existsSync(work)) throw Error('Supply archive and a NEW absolute test directory');
const projectName = 'handover-smoke-' + Date.now();
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const secrets = ['testBotSecret_' + crypto.randomBytes(16).toString('hex'), 'testWebhookSecret_' + crypto.randomBytes(16).toString('hex'), 'testDatabaseSecret_' + crypto.randomBytes(16).toString('hex'), 'wrongPassword_' + crypto.randomBytes(16).toString('hex')];
const results = [];
let composeArgs, packageRoot, started = false;
function command(bin, args, options = {}) {
  const result = cp.spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw Error('Command unavailable: ' + bin);
  return result;
}
function ok(bin, args, options) {
  const result = command(bin, args, options);
  if (result.status !== 0) throw Error('Operation failed: ' + bin + ' ' + args.slice(0, 2).join(' ') + '; details retained only in isolated test directory');
  return result.stdout;
}
function dc(args, options) { return command('docker', [...composeArgs, ...args], options); }
function dcOk(args, options) {
  const r = dc(args, options);
  if (r.status !== 0) throw Error('Test Compose operation failed: ' + args.slice(0, 2).join(' '));
  return r.stdout;
}
function check(label, mode, expectedCode, overrides = {}) {
  const flags = Object.entries(overrides).flatMap(([key, value]) => ['-e', key + '=' + value]);
  const result = dc(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', '-v', packageRoot + ':/handover:ro', ...flags, 'app', '/handover/config/check.cjs', mode]);
  const output = result.stdout + result.stderr;
  if (secrets.some(secret => output.includes(secret) || output.includes(encodeURIComponent(secret)))) throw Error('Secret leak detected in ' + label);
  if ((expectedCode ? result.status === 0 : result.status !== 0) || (expectedCode && !output.includes(expectedCode))) {
    fs.writeFileSync(path.join(work, 'last-failed-check.txt'), output, { mode: 0o600 });
    throw Error('Unexpected result for ' + label + '; raw output not printed');
  }
  results.push({ test: label, passed: true, expectedCode: expectedCode || 'OK', secretLeak: false });
  console.log('PASS ' + label + ': ' + (expectedCode || 'OK'));
  return output;
}
function sql(query) {
  return dcOk(['exec', '-T', 'postgres', 'sh', '-c', 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'], { input: query });
}

(async () => {
  fs.mkdirSync(work, { mode: 0o700 });
  // Python extracts only regular ZIP files with a validated prefix/path.
  ok('python3', ['-c', "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert all(n.startswith('Na-svyazi-region40/') and '..' not in n.split('/') for n in z.namelist());z.extractall(sys.argv[2])", archive, work]);
  packageRoot = path.join(work, 'Na-svyazi-region40');
  const project = path.join(packageRoot, 'project');
  ok('sha256sum', ['-c', path.join(packageRoot, 'SHA256SUMS')], { cwd: packageRoot });
  const revision = fs.readFileSync(path.join(packageRoot, 'verification/source-revision.txt'), 'utf8').trim();
  let environment = fs.readFileSync(path.join(packageRoot, 'config/.env.mincifra.example'), 'utf8');
  const values = { BOT_TOKEN: secrets[0], WEBHOOK_SECRET: secrets[1], POSTGRES_USER: 'incident', POSTGRES_DB: 'incident', POSTGRES_PASSWORD: secrets[2], PUBLIC_DOMAIN: 'smoke.invalid', WEBHOOK_URL: 'https://smoke.invalid/webhook/max', LEGAL_DOCUMENTS_BASE_URL: 'https://smoke.invalid/documents', DATABASE_URL: `postgresql://incident:${secrets[2]}@postgres:5432/incident?schema=public&connection_limit=20&pool_timeout=20` };
  for (const [key, value] of Object.entries(values)) environment = environment.replace(new RegExp('^' + key + '=.*$', 'm'), key + '=' + value);
  const envFile = path.join(project, '.env'); fs.writeFileSync(envFile, environment, { mode: 0o600 });
  // No published ports. Runtime network has no route to MAX or the Internet.
  const isolation = path.join(work, 'isolation.yml');
  fs.writeFileSync(isolation, 'services:\n  postgres:\n    ports: !reset []\n  app:\n    ports: !reset []\nnetworks:\n  default:\n    internal: true\n');
  composeArgs = ['compose', '-p', projectName, '--project-directory', project, '--env-file', envFile, '-f', path.join(project, 'docker-compose.yml'), '-f', isolation];
  dcOk(['config', '--quiet']);
  console.log('Building application image from packaged project/ (workers will not start)');
  const log = fs.openSync(path.join(work, 'build.log'), 'wx', 0o600);
  try {
    const built = dc(['build', 'app'], { stdio: ['ignore', log, log] });
    if (built.status !== 0) throw Error('Docker build failed; see isolated build.log');
  } finally { fs.closeSync(log); }
  results.push({ test: 'docker-build-from-packaged-source', passed: true });
  check('installation-template', 'env');
  for (const [key, value] of Object.entries({ NODE_ENV: 'development', BOT_MODE: 'polling', WEBHOOK_AUTO_REGISTER: 'true' })) {
    const output = check('wrong-' + key, 'env', 'CONFIG_MODE_VALUES', { [key]: value });
    for (const name of ['NODE_ENV', 'BOT_MODE', 'WEBHOOK_AUTO_REGISTER']) if (!output.includes(name + ': фактически')) throw Error('Incomplete mode diagnostics');
    if (!output.includes(JSON.stringify(value))) throw Error('Actual value missing');
  }
  check('short-password', 'env', 'CONFIG_DB_PASSWORD', { POSTGRES_PASSWORD: 'short' });
  check('placeholder-token', 'env', 'CONFIG_PLACEHOLDER', { BOT_TOKEN: 'REPLACE_WITH_TOKEN' });
  check('placeholder-in-nonsecret-field', 'env', 'CONFIG_MODE_VALUES', { NODE_ENV: secrets[0] });
  started = true;
  dcOk(['up', '-d', '--wait', 'postgres']);
  const network = JSON.parse(ok('docker', ['network', 'inspect', projectName + '_default']))[0];
  if (!network.Internal || network.Labels['com.docker.compose.project'] !== projectName) throw Error('Network is not isolated');
  check('TCP-authenticated-connection', 'connection');
  check('empty-database', 'database', 'DB_EMPTY');
  sql("DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')) THEN RAISE EXCEPTION 'Database not empty'; END IF; END $$;");
  const dump = path.join(packageRoot, 'data/database.dump');
  const fd = fs.openSync(dump, 'r');
  try { dcOk(['exec', '-T', 'postgres', 'sh', '-c', 'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error --single-transaction'], { stdio: [fd, 'pipe', 'pipe'] }); }
  finally { fs.closeSync(fd); }
  const uploads = fs.openSync(path.join(packageRoot, 'data/uploads.tar.gz'), 'r');
  try { dcOk(['run', '--rm', '--no-deps', '-T', '--user', 'root', '--entrypoint', 'sh', 'app', '-c', 'mkdir -p /app/data/uploads && tar -xzf - -C /app/data/uploads && chown -R node:node /app/data/uploads'], { stdio: [uploads, 'pipe', 'pipe'] }); }
  finally { fs.closeSync(uploads); }
  check('restored-packaged-database', 'database');
  const migrationStatus = dcOk(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'npx', 'app', 'prisma', 'migrate', 'status']);
  if (!migrationStatus.includes('Database schema is up to date')) throw Error('Migration check not confirmed');
  results.push({ test: 'prisma-migrate-status', passed: true });
  check('wrong-existing-database-password', 'connection', 'DB_AUTH', { POSTGRES_PASSWORD: secrets[3], DATABASE_URL: `postgresql://incident:${secrets[3]}@postgres:5432/incident?schema=public` });
  sql('ALTER TABLE "ActionLock" RENAME TO "smoke_hidden_action_lock";');
  check('partial-schema', 'database', 'DB_TABLES_MISSING');
  sql('ALTER TABLE "smoke_hidden_action_lock" RENAME TO "ActionLock";');
  sql("UPDATE \"IncidentCounter\" SET \"lastNumber\"=\"lastNumber\"+1 WHERE day='global';");
  check('changed-restored-data', 'database', 'DB_DATA_MISMATCH');
  sql("UPDATE \"IncidentCounter\" SET \"lastNumber\"=\"lastNumber\"-1 WHERE day='global';");
  check('restored-database-after-negative-tests', 'database');
  dcOk(['stop', 'postgres']);
  check('unreachable-database', 'connection', 'DB_UNREACHABLE', { DATABASE_URL: values.DATABASE_URL + '&connect_timeout=2' });
  const result = { passed: true, checkedAt: new Date().toISOString(), sourceRevision: revision, archiveTestedSha256: sha(fs.readFileSync(archive)), dumpSha256: sha(fs.readFileSync(dump)), checkSha256: sha(fs.readFileSync(path.join(packageRoot, 'config/check.cjs'))), tests: results, maxMessagesSent: 0, webhooksRegistered: false, applicationWorkersStarted: false, liveMAXChecked: false, actualTCPAuthenticationChecked: true, testNetworkInternal: true, freshDockerBuild: true, registryPullFromEmptyCache: false, note: 'Only isolated postgres and one-off check/restore containers; no app/index or Caddy started. Base images/build cache may be reused.' };
  fs.writeFileSync(path.join(work, 'acceptance-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ result: path.join(work, 'acceptance-result.json'), tests: results.length, passed: true }));
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => {
  // Only this invocation's unique test project; never production resources.
  if (composeArgs) {
    if (!/^handover-smoke-\d+$/.test(projectName)) throw Error('Cleanup scope rejected');
    const containers = dcOk(['ps', '-a', '-q']).trim().split('\n').filter(Boolean);
    for (const id of containers) {
      const item = JSON.parse(ok('docker', ['inspect', id]))[0];
      if (item.Config.Labels['com.docker.compose.project'] !== projectName) throw Error('Foreign container; cleanup aborted');
    }
    dcOk(['down', '--volumes', '--remove-orphans']);
  }
});
