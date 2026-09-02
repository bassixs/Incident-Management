import { Prisma, type PrismaClient } from '@prisma/client';

import { getConfig } from '../config';

export const AuditAction = {
  USER_BANNED: 'USER_BANNED',
  USER_UNBANNED: 'USER_UNBANNED',
  ROLES_SET: 'ROLES_SET',
  CATEGORY_CREATED: 'CATEGORY_CREATED',
  CATEGORY_CHAT_SET: 'CATEGORY_CHAT_SET',
  CATEGORY_ENABLED: 'CATEGORY_ENABLED',
  CATEGORY_DISABLED: 'CATEGORY_DISABLED',
  CATEGORY_RENAMED: 'CATEGORY_RENAMED',
  CATEGORY_AUTHORITY_SET: 'CATEGORY_AUTHORITY_SET',
  CATEGORY_TEMPLATE_SET: 'CATEGORY_TEMPLATE_SET',
  SLA_SWEEP: 'SLA_SWEEP',
  DELIVERY_RETRIED: 'DELIVERY_RETRIED',
} as const;

export type AuditEntry = {
  action: (typeof AuditAction)[keyof typeof AuditAction] | string;
  actorMaxUserId: bigint;
  actorName: string;
  targetType?: string | undefined;
  targetId?: string | undefined;
  summary: string;
  metadata?: Record<string, unknown> | undefined;
};

/** Durable, append-only journal for successful ADMIN commands. */
export class AdminAuditService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: AuditEntry): Promise<void> {
    const secrets = configuredSecrets();
    await this.prisma.adminAuditLog.create({
      data: {
        action: entry.action,
        actorMaxUserId: entry.actorMaxUserId,
        actorName: entry.actorName,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        summary: redactText(entry.summary, secrets),
        metadata: entry.metadata
          ? (sanitizeValue(entry.metadata, secrets) as Prisma.InputJsonValue)
          : undefined,
      },
    });
  }

  async recent(limit = 20) {
    return this.prisma.adminAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(limit, 50)),
    });
  }
}

function configuredSecrets(): string[] {
  const config = getConfig();
  const values = [
    config.BOT_TOKEN,
    config.WEBHOOK_SECRET,
    config.S3_ACCESS_KEY_ID,
    config.S3_SECRET_ACCESS_KEY,
    config.DATABASE_URL,
  ];
  try {
    values.push(new URL(config.DATABASE_URL).password);
  } catch {
    // Configuration validation reports an invalid URL elsewhere.
  }
  return values.filter((value): value is string => Boolean(value && value.length >= 4));
}

function sanitizeValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /(authorization|token|password|secret|api.?key)/i.test(key)
          ? '[скрыто]'
          : sanitizeValue(item, secrets),
      ]),
    );
  }
  return value;
}

function redactText(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets) {
    result = result.replace(new RegExp(escapeRegExp(secret), 'g'), '[скрыто]');
  }
  return result.replace(/\b(authorization|token|password|secret)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[скрыто]');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
