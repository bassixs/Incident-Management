import * as path from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/** `1, 2 ,3` -> [1n, 2n, 3n]; empty/undefined -> []. */
const bigIntList = z
  .string()
  .optional()
  .transform((raw) =>
    (raw ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => {
        try {
          return BigInt(part);
        } catch {
          throw new Error(`Not a valid MAX id in list: "${part}"`);
        }
      }),
  );

const optionalBigInt = z
  .string()
  .optional()
  .transform((raw) => {
    const trimmed = (raw ?? '').trim();
    if (trimmed === '') return undefined;
    try {
      return BigInt(trimmed);
    } catch {
      throw new Error(`Not a valid MAX chat id: "${trimmed}"`);
    }
  });

const boolean = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      const trimmed = (raw ?? '').trim().toLowerCase();
      if (trimmed === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(trimmed);
    });

const int = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw.trim() === '' ? defaultValue : Number(raw)))
    .pipe(z.number().int());

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_PRETTY: boolean(false),

    BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
    MAX_API_BASE_URL: z.string().url().default('https://platform-api2.max.ru'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    APP_TIMEZONE: z.string().default('Europe/Moscow'),

    /** `webhook` is mandatory in production; `polling` is a development aid. */
    BOT_MODE: z.enum(['webhook', 'polling']).default('webhook'),
    WEBHOOK_URL: z.string().optional(),
    WEBHOOK_SECRET: z.string().optional(),
    WEBHOOK_PATH: z.string().default('/webhook/max'),
    /** Register the subscription with MAX on boot when WEBHOOK_URL is set. */
    WEBHOOK_AUTO_REGISTER: boolean(true),
    HTTP_HOST: z.string().default('0.0.0.0'),
    HTTP_PORT: int(3000),

    DISTRIBUTION_CHAT_ID: optionalBigInt,
    REVIEW_CHAT_ID: optionalBigInt,
    DELIVERY_ALERT_CHAT_ID: optionalBigInt,

    DAILY_INCIDENT_LIMIT: int(2),
    INCIDENT_MAX_LENGTH: int(150),
    INCIDENT_SLA_HOURS: int(72),
    SLA_CHECK_INTERVAL_MINUTES: int(10),
    SLA_ENABLED: boolean(true),
    SESSION_TTL_MINUTES: int(10),
    MY_INCIDENTS_LIMIT: int(10),

    /** Legal gate stays off until the operator details and publication date are final. */
    LEGAL_CONSENT_REQUIRED: boolean(false),
    LEGAL_DOCUMENTS_BASE_URL: z.string().url().optional(),
    LEGAL_DOCUMENT_VERSION: z.string().trim().min(1).default('1.0'),
    LEGAL_USER_AGREEMENT_SHA256: z.string().trim().regex(/^[a-fA-F0-9]{64}$/).optional(),
    LEGAL_PRIVACY_POLICY_SHA256: z.string().trim().regex(/^[a-fA-F0-9]{64}$/).optional(),
    LEGAL_PERSONAL_DATA_CONSENT_SHA256: z.string().trim().regex(/^[a-fA-F0-9]{64}$/).optional(),

    MEDIA_STORAGE: z.enum(['local', 's3']).default('local'),
    MEDIA_LOCAL_PATH: z.string().default('./data/uploads'),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: boolean(true),

    ADMINS: bigIntList,
    DISPATCHERS: bigIntList,
    APPROVERS: bigIntList,
    RESPONDERS: bigIntList,
  })
  .superRefine((value, ctx) => {
    if (value.BOT_MODE === 'polling' && value.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BOT_MODE'],
        message: 'Long polling is only allowed outside production. Use BOT_MODE=webhook.',
      });
    }
    if (value.BOT_MODE === 'webhook') {
      if (!value.WEBHOOK_SECRET || value.WEBHOOK_SECRET.length < 5) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBHOOK_SECRET'],
          message: 'WEBHOOK_SECRET (5-256 chars) is required in webhook mode.',
        });
      }
      if (value.NODE_ENV === 'production' && !value.WEBHOOK_URL?.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBHOOK_URL'],
          message: 'WEBHOOK_URL must be an https:// URL in production.',
        });
      }
    }
    if (value.MEDIA_STORAGE === 's3') {
      for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!value[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when MEDIA_STORAGE=s3.`,
          });
        }
      }
    }
    if (value.LEGAL_CONSENT_REQUIRED) {
      for (const key of [
        'LEGAL_DOCUMENTS_BASE_URL',
        'LEGAL_USER_AGREEMENT_SHA256',
        'LEGAL_PRIVACY_POLICY_SHA256',
        'LEGAL_PERSONAL_DATA_CONSENT_SHA256',
      ] as const) {
        if (!value[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when LEGAL_CONSENT_REQUIRED=true.`,
          });
        }
      }
    }
    try {
      new Intl.DateTimeFormat('ru-RU', { timeZone: value.APP_TIMEZONE });
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_TIMEZONE'],
        message: `Unknown IANA timezone: "${value.APP_TIMEZONE}".`,
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema> & {
  mediaLocalAbsolutePath: string;
};

let cached: AppConfig | undefined;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  return {
    ...parsed.data,
    mediaLocalAbsolutePath: path.resolve(process.cwd(), parsed.data.MEDIA_LOCAL_PATH),
    LEGAL_DOCUMENTS_BASE_URL: parsed.data.LEGAL_DOCUMENTS_BASE_URL?.replace(/\/+$/, ''),
  };
}

/** Process-wide config, parsed once on first access. */
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test helper: drop the memoised config so a new env can be parsed. */
export function resetConfigCache(): void {
  cached = undefined;
}
