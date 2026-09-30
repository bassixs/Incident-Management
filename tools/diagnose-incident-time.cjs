// Read-only diagnostic. Run in the app working directory:
// dc exec -T app node < diagnose-incident-time.cjs
// No bootstrap, MAX API calls, message bodies, contacts or credentials.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const req = createRequire(path.join(process.cwd(), 'package.json'));
const { PrismaClient } = req('@prisma/client');
const prisma = new PrismaClient({ log: [] });
const publicCode = process.env.TIME_DIAGNOSTIC_CODE || 'INC-000164';
if (!/^INC-\d{6}$/.test(publicCode)) throw new Error('Expected INC-000000 format');

async function main() {
  const config = req('./dist/config').getConfig();
  const leases = req('./dist/work-queues/leases');
  const { CLAIM_MINUTES } = req('./dist/distribution/queue-state');
  const settings = Object.fromEntries(['APP_TIMEZONE', 'SESSION_TTL_MINUTES', 'INCIDENT_SLA_WORKDAYS',
    'SLA_CHECK_INTERVAL_MINUTES', 'SLA_ENABLED', 'WORKDAY_START', 'WORKDAY_END'].map(key => [key, config[key]]));
  const files = ['dist/work-queues/leases.js', 'dist/sector/sector.service.js',
    'dist/utils/datetime.js', 'dist/work-queues/work-queue.service.js'];
  const hashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const databaseClock = await tx.$queryRaw`
      SELECT current_setting('TimeZone') AS timezone,
        to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "nowUtc",
        extract(epoch FROM clock_timestamp())::double precision AS "epochSeconds"`;
    const incident = await tx.incident.findUnique({ where: { publicCode }, select: {
      publicCode: true, status: true, createdAt: true, updatedAt: true, assignedAt: true,
      deadlineAt: true, answeredAt: true, distributionClaimUntil: true, isOverdue: true,
      slaPausedAt: true, slaReminder24SentAt: true, slaWarn24SentAt: true,
      slaWarn6SentAt: true, overdueNotifiedAt: true,
    } });
    const locks = await tx.$queryRaw`
      SELECT a.action, a."createdAt"::text AS "createdAtStored", a."lockedUntil"::text AS "lockedUntilStored"
      FROM "ActionLock" a JOIN "Incident" i ON i.id = a."incidentId"
      WHERE i."publicCode" = ${publicCode} ORDER BY a."createdAt"`;
    const history = await tx.$queryRaw`
      SELECT h.action, h."createdAt"::text AS "createdAtStored",
        CASE WHEN h.metadata->>'until' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
          THEN h.metadata->>'until' ELSE NULL END AS "untilUtc"
      FROM "IncidentHistory" h JOIN "Incident" i ON i.id = h."incidentId"
      WHERE i."publicCode" = ${publicCode} AND h.action IN
        ('TAKEN_IN_WORK', 'SECTOR_LEASE_EXPIRED', 'SECTOR_RELEASED', 'REVIEW_CLAIMED',
         'REVIEW_RELEASED', 'DISTRIBUTION_CLAIMED', 'SLA_REMINDER_24H', 'ASSIGNED', 'ANSWER_SUBMITTED')
      ORDER BY h."createdAt" LIMIT 100`;
    const delivery = await tx.$queryRaw`
      SELECT o."trackingType", o.status, o."createdAt"::text AS "createdAtStored",
        o."sentAt"::text AS "sentAtStored", o."nextAttemptAt"::text AS "nextAttemptAtStored",
        substring(o.payload->>'text' FROM 'До ([0-9]{2}[.][0-9]{2}[.][0-9]{4} [0-9]{2}:[0-9]{2})') AS "renderedLeaseTime"
      FROM "OutboundMessage" o JOIN "Incident" i ON i.id = o."incidentId"
      WHERE i."publicCode" = ${publicCode} ORDER BY o."createdAt" LIMIT 100`;
    const columnTypes = await tx.$queryRaw`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND
        ((table_name = 'ActionLock' AND column_name IN ('lockedUntil', 'createdAt')) OR
         (table_name = 'Incident' AND column_name IN ('deadlineAt', 'distributionClaimUntil', 'createdAt'))) `;
    return { databaseClock, incident, locks, history, delivery, columnTypes };
  });
  console.log(JSON.stringify({ publicCode, capturedAtUtc: new Date().toISOString(),
    runtimeTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, TZ: process.env.TZ ?? '(unset)',
    settings, sectorAndReviewLeaseMinutes: leases.LEASE_MS / 60_000, distributionClaimMinutes: CLAIM_MINUTES,
    fixture: { takeAtUtc: '2026-09-30T13:41:00.000Z',
      calculatedUntilUtc: new Date(Date.parse('2026-09-30T13:41:00.000Z') + leases.LEASE_MS).toISOString(),
      rendered: leases.leaseText({ name: 'TEST', until: new Date('2026-09-30T13:56:00.000Z') }) },
    compiledFileSha256: hashes, ...result }, null, 2));
}
main().catch(error => {
  // Never print raw Prisma errors: they may contain connection credentials.
  const code = typeof error.code === 'string' && /^P\d{4}$/.test(error.code) ? error.code : 'DIAGNOSTIC_FAILED';
  console.error(code + ': read-only time diagnostic did not complete; no raw error printed.');
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
