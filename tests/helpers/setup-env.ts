/**
 * Deterministic environment for the test run.
 *
 * Loaded by vitest before any module, so `getConfig()` memoises these values
 * instead of whatever happens to sit in the developer's .env.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.LOG_PRETTY = 'false';

process.env.BOT_TOKEN = process.env.BOT_TOKEN ?? 'test-token';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://incident:incident@localhost:5432/incident_test?schema=public';

process.env.APP_TIMEZONE = 'Europe/Moscow';

process.env.BOT_MODE = 'webhook';
process.env.WEBHOOK_SECRET = 'test-webhook-secret';
process.env.WEBHOOK_URL = 'https://example.test/webhook/max';
process.env.WEBHOOK_AUTO_REGISTER = 'false';

process.env.DISTRIBUTION_CHAT_ID = '-1001';
process.env.REVIEW_CHAT_ID = '-1002';
process.env.DELIVERY_ALERT_CHAT_ID = '-1005';

process.env.DAILY_INCIDENT_LIMIT = '2';
process.env.INCIDENT_MAX_LENGTH = '150';
process.env.INCIDENT_SLA_HOURS = '72';
process.env.SLA_ENABLED = 'false';
process.env.SESSION_TTL_MINUTES = '10';

process.env.MEDIA_STORAGE = 'local';
process.env.MEDIA_LOCAL_PATH = './data/test-uploads';


process.env.ADMINS = '9001';
process.env.DISPATCHERS = '9002';
process.env.APPROVERS = '9003';
process.env.RESPONDERS = '9004';

/** Chat ids used consistently across the suite. */
export const TEST_CHATS = {
  distribution: -1001n,
  review: -1002n,
  sector: -1010n,
  otherSector: -1011n,
  regional: -1012n,
};

export const TEST_USERS = {
  admin: 9001n,
  dispatcher: 9002n,
  approver: 9003n,
  responder: 9004n,
  requesterA: 5001n,
  requesterB: 5002n,
};
