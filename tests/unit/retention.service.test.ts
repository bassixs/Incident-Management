import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { MediaStorage } from '../../src/media/media-storage.interface';
import { INCIDENT_RETENTION_DAYS, RetentionService } from '../../src/retention/retention.service';

const NOW = new Date('2026-09-03T12:00:00.000Z');
const OLD_COMPLETION = new Date('2026-05-01T12:00:00.000Z');

function candidate() {
  return {
    id: 'incident-old',
    publicCode: 'INC-20260501-0001',
    requesterId: 'requester-old',
    answeredAt: OLD_COMPLETION,
    attachments: [{ storageKey: 'incident/photo.jpg', size: 150 }],
    answers: [
      {
        id: 'answer-old',
        attachments: [{ storageKey: 'answer/result.pdf', size: 350 }],
      },
    ],
  };
}

function fakePrisma(options: { locked?: boolean } = {}) {
  const calls = {
    deletedIncidents: 0,
    deletedOutbound: 0,
    deletedActionLocks: 0,
    releasedLocks: 0,
  };
  const journal = new Map<string, string>();
  const prisma = {
    incident: {
      findMany: vi.fn(async () => [candidate()]),
      findFirst: vi.fn(async () => (await prisma.incident.findMany())[0]),
      count: vi.fn(async () => 0),
      deleteMany: vi.fn(async () => {
        calls.deletedIncidents += 1;
        return { count: 1 };
      }),
    },
    outboundMessage: {
      count: vi.fn(async () => 2),
      deleteMany: vi.fn(async () => {
        calls.deletedOutbound += 1;
        return { count: 2 };
      }),
    },
    actionLock: {
      deleteMany: vi.fn(async () => {
        calls.deletedActionLocks += 1;
        return { count: 1 };
      }),
    },
    operatorSession: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      count: vi.fn(async () => 0),
    },
    user: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    $queryRaw: vi.fn(async () => [{ present: false }]),
    $executeRawUnsafe: vi.fn(async () => 0),
    systemSetting: {
      upsert: vi.fn(async ({ create }: any) => { journal.set(create.key, create.value); return create; }),
      findMany: vi.fn(async () => [...journal].filter(([key]) => key.startsWith('retention.file-delete.v1:')).map(([key, value]) => ({ key, value }))),
      findUnique: vi.fn(async ({ where }: any) => journal.has(where.key) ? ({ key: where.key, value: journal.get(where.key) }) : null),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async ({ where }: any) => {
        if (where.key.startsWith('retention.file-')) journal.delete(where.key);
        else calls.releasedLocks += 1;
        return { count: 1 };
      }),
    },
    $queryRawUnsafe: vi.fn(async () => (options.locked ? [] : [{ key: 'maintenance.incident-retention' }])),
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => operation(prisma)),
  };
  return { prisma: prisma as unknown as PrismaClient, calls };
}

function fakeStorage(remove: (key: string) => Promise<void>): MediaStorage {
  return {
    save: vi.fn(),
    load: vi.fn(),
    exists: vi.fn(),
    remove: vi.fn(remove),
  } as unknown as MediaStorage;
}

describe('RetentionService', () => {
  it('uses an exact 90-day cutoff and previews both sides attachments', async () => {
    const { prisma } = fakePrisma();
    const service = new RetentionService(prisma, fakeStorage(async () => undefined));

    expect((NOW.getTime() - service.cutoff(NOW).getTime()) / 86_400_000).toBe(INCIDENT_RETENTION_DAYS);
    const preview = await service.preview(NOW);
    expect(preview).toMatchObject({ incidents: 1, files: 2, bytes: 500, outboundMessages: 2 });
  });

  it('removes requester and answer files after committing the database deletion', async () => {
    const removed: string[] = [];
    const { prisma, calls } = fakePrisma();
    const service = new RetentionService(prisma, fakeStorage(async (key) => { expect(calls.deletedIncidents).toBe(1); removed.push(key); }));

    const result = await service.run(NOW);

    expect(removed).toEqual(['incident/photo.jpg', 'answer/result.pdf']);
    expect(calls).toMatchObject({ deletedIncidents: 1, deletedOutbound: 1, deletedActionLocks: 1, releasedLocks: 1 });
    expect(result).toMatchObject({ deletedIncidents: 1, deletedFiles: 2, deletedBytes: 500, failures: [] });
  });

  it('drops MAX references with the database record without deleting or counting them as local files', async () => {
    const { prisma } = fakePrisma();
    const item = candidate();
    item.attachments = [{ storageKey: 'max-photo:opaque-token', size: 0 }];
    vi.mocked(prisma.incident.findMany).mockResolvedValue([item] as never);
    const removed: string[] = [];
    const result = await new RetentionService(prisma, fakeStorage(async key => { removed.push(key); })).run(NOW);
    expect(removed).toEqual(['answer/result.pdf']);
    expect(result).toMatchObject({ deletedIncidents: 1, deletedFiles: 1, deletedBytes: 350, failures: [] });
  });

  it('keeps a durable file deletion intent when post-commit removal fails', async () => {
    const { prisma, calls } = fakePrisma();
    const service = new RetentionService(
      prisma,
      fakeStorage(async (key) => {
        if (key.startsWith('answer/')) throw new Error('storage unavailable');
      }),
    );

    const result = await service.run(NOW);

    expect(calls.deletedIncidents).toBe(1);
    expect(result.deletedIncidents).toBe(1);
    expect(result.failures).toEqual([{ publicCode: 'INC-20260501-0001', error: expect.stringContaining('FILE_DELETION_PENDING') }]);
    expect(await prisma.systemSetting.findMany()).toHaveLength(1);
  });

  it('does not start a second cleanup while the maintenance lock is held', async () => {
    const { prisma, calls } = fakePrisma({ locked: true });
    const service = new RetentionService(prisma, fakeStorage(async () => undefined));

    const result = await service.run(NOW);

    expect(result.skippedBecauseLocked).toBe(true);
    expect(calls.deletedIncidents).toBe(0);
    expect(calls.releasedLocks).toBe(0);
  });
});
