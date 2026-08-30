import { Prisma, PrismaClient } from '@prisma/client';

import { moduleLogger } from '../utils/logger';

const log = moduleLogger('database');

let client: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  client ??= new PrismaClient({
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });
  return client;
}

export async function connectDatabase(): Promise<PrismaClient> {
  const prisma = getPrisma();
  prisma.$on('warn' as never, (event: Prisma.LogEvent) => log.warn({ event }, 'prisma warning'));
  prisma.$on('error' as never, (event: Prisma.LogEvent) => log.error({ event }, 'prisma error'));
  await prisma.$connect();
  log.info('database connected');
  return prisma;
}

export async function disconnectDatabase(): Promise<void> {
  if (!client) return;
  await client.$disconnect();
  client = undefined;
}

/** Transaction client type accepted by every repository method. */
export type Tx = Prisma.TransactionClient;
export type PrismaLike = PrismaClient | Tx;

/**
 * Options for the interactive transactions that guard incident creation and
 * answer submission.
 *
 * Prisma defaults to maxWait = 2s, which is the time a request may spend
 * queueing for a pooled connection. Measured on the target server, a burst of
 * 500 simultaneous registrations exhausted that budget and about a third of
 * them failed with "Unable to start a transaction in the given time" — even
 * though the work itself takes ~60 ms. For a bot, waiting is strictly better
 * than failing: MAX already has its 200 OK and the person is simply waiting
 * for the confirmation message. `timeout` bounds the transaction itself, which
 * is short by design, so it only ever fires if the database is truly stuck.
 */
export const TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 20_000 } as const;

export const UNIQUE_VIOLATION = 'P2002';

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION;
}

/**
 * Serialise concurrent work for one logical key inside a transaction.
 *
 * Postgres advisory locks are held until the surrounding transaction ends,
 * which is exactly what the daily-limit check needs: two parallel "create
 * incident" requests from the same user must not both observe count = 1.
 */
export async function acquireAdvisoryLock(tx: Tx, namespace: string, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${namespace}:${key}`}))`;
}
