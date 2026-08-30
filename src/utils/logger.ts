import pino, { type Logger } from 'pino';

import { getConfig } from '../config';

/**
 * Values that must never reach the log stream, whatever wraps them.
 * Pino redaction is path-based, so we also strip anything token-shaped
 * from serialised errors below.
 */
const REDACT_PATHS = [
  'BOT_TOKEN',
  'token',
  'accessToken',
  'access_token',
  'secret',
  'WEBHOOK_SECRET',
  'AI_API_KEY',
  'apiKey',
  'authorization',
  'Authorization',
  '*.token',
  '*.secret',
  'req.headers.authorization',
  'req.headers["x-max-bot-api-secret"]',
];

let rootLogger: Logger | undefined;

type LoggerSettings = { level: string; env: string; pretty: boolean };

/**
 * The logger must survive a broken configuration — otherwise a missing
 * BOT_TOKEN surfaces as a stack trace inside pino instead of the readable
 * "Invalid configuration" report the config module produces.
 */
function settings(): LoggerSettings {
  try {
    const config = getConfig();
    return { level: config.LOG_LEVEL, env: config.NODE_ENV, pretty: config.LOG_PRETTY };
  } catch {
    return { level: 'info', env: 'unknown', pretty: false };
  }
}

function build(): Logger {
  const config = settings();
  return pino({
    level: config.level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'max-incident-bot', env: config.env },
    // BigInt ids (maxUserId, chatId) are common in this codebase and would
    // otherwise throw inside JSON.stringify.
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
    formatters: {
      log: (object) => normaliseBigInts(object) as Record<string, unknown>,
    },
    transport: config.pretty
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
  });
}

function normaliseBigInts(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => normaliseBigInts(item, depth + 1));
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = normaliseBigInts(item, depth + 1);
    }
    return out;
  }
  return value;
}

export function logger(): Logger {
  rootLogger ??= build();
  return rootLogger;
}

/** Child logger for one subsystem, e.g. `moduleLogger('sla')`. */
export function moduleLogger(name: string): Logger {
  return logger().child({ module: name });
}

/**
 * Standard business-process log fields. Every incident-related log line should
 * carry these so an operator can grep one publicCode end to end.
 */
export type IncidentLogContext = {
  incidentId?: string;
  publicCode?: string;
  maxUserId?: bigint | number | string;
  chatId?: bigint | number | string;
  action?: string;
};

export function incidentLogFields(context: IncidentLogContext): Record<string, unknown> {
  return {
    incidentId: context.incidentId,
    publicCode: context.publicCode,
    maxUserId: context.maxUserId?.toString(),
    chatId: context.chatId?.toString(),
    action: context.action,
  };
}
