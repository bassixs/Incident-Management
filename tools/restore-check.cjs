// Run on the Linux deployment host from /opt/incident-bot. Never restores production.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const project = '/opt/incident-bot';
const name = 'iskra-restore-check-20260909';
const evidence = path.join(project, 'backups', 'pilot-readiness-20260909');
if (process.platform !== 'linux' || process.argv[2] !== '--run-isolated') throw Error('Use --run-isolated on the deployment host');
function docker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...options });
  if (result.status !== 0) throw Error('Docker operation failed: ' + args.slice(0, 3).join(' '));
  return result.stdout;
}
const tableSQL = table => `SELECT count(*)::int AS count, md5(coalesce(string_agg(h, '' ORDER BY h), '')) AS digest FROM (SELECT md5(row_to_json(t)::text) AS h FROM "${table.replaceAll('"', '""')}" t) s`;
const env = require('dotenv').parse(fs.readFileSync(path.join(project, '.env')));
const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
let created = false;
(async () => {
  if (fs.existsSync(evidence)) throw Error('Evidence directory already exists; preserve it and use a new dated drill');
  if (spawnSync('docker', ['inspect', name], { stdio: 'ignore' }).status === 0) throw Error('Test container already exists');
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const dump = path.join(evidence, 'database.dump');
  const baseline = await prisma.$transaction(async tx => {
    const [{ snapshot }] = await tx.$queryRawUnsafe('SELECT pg_export_snapshot() AS snapshot');
    const tables = await tx.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    const counts = [];
    for (const { tablename } of tables) counts.push({ table: tablename, ...(await tx.$queryRawUnsafe(tableSQL(tablename)))[0] });
    const fd = fs.openSync(dump, 'wx', 0o600);
    try {
      docker(['exec', 'incident-bot-postgres-1', 'sh', '-c', 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --snapshot="$1" -Fc', 'sh', snapshot], { stdio: ['ignore', fd, 'pipe'] });
    } finally { fs.closeSync(fd); }
    return counts;
  }, { isolationLevel: 'RepeatableRead', timeout: 120_000 });
  fs.writeFileSync(path.join(evidence, 'source-manifest.json'), JSON.stringify(baseline, null, 2), { mode: 0o600 });
  docker(['run', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=incident_restore_check', 'postgres:16-alpine']);
  created = true;
  const deadline = Date.now() + 30_000;
  while (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'incident_restore_check'], { stdio: 'ignore' }).status !== 0) {
    if (Date.now() > deadline) throw Error('Isolated PostgreSQL did not start');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const start = Date.now();
  const fd = fs.openSync(dump, 'r');
  try { docker(['exec', '-i', name, 'pg_restore', '-U', 'postgres', '-d', 'incident_restore_check', '--no-owner', '--no-privileges', '--exit-on-error'], { stdio: [fd, 'pipe', 'pipe'] }); }
  finally { fs.closeSync(fd); }
  const restored = [];
  for (const row of baseline) {
    const value = docker(['exec', name, 'psql', '-XAt', '-U', 'postgres', '-d', 'incident_restore_check', '-c', `SELECT row_to_json(x) FROM (${tableSQL(row.table)}) x`]);
    restored.push({ table: row.table, ...JSON.parse(value) });
  }
  const mismatches = baseline.filter((row, i) => row.count !== restored[i].count || row.digest !== restored[i].digest).map(r => r.table);
  const result = { snapshotConsistent: true, checkedTables: baseline.length, totalRows: baseline.reduce((n, r) => n + r.count, 0),
    mismatches, restoreMs: Date.now() - start, database: 'incident_restore_check', network: 'none',
    dumpSha256: crypto.createHash('sha256').update(fs.readFileSync(dump)).digest('hex') };
  fs.writeFileSync(path.join(evidence, 'restore-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (mismatches.length) throw Error('Restored content mismatch');
  // A separate, empty database is reserved for process-level integration probes.
  docker(['exec', name, 'createdb', '-U', 'postgres', 'incident_test']);
  console.log('RESTORE_CHECK_OK; isolated container retained for the restart drill');
})().catch(error => { console.error(error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[database]')); process.exitCode = 1;
  if (created) docker(['rm', '-f', name]);
}).finally(() => prisma.$disconnect());
