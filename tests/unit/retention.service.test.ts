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
  const prisma = {
    incident: {
      findMany: vi.fn(async () => [candidate()]),
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
    systemSetting: {
      deleteMany: vi.fn(async () => {
        calls.releasedLocks += 1;
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

  it('removes requester and answer files before cascading the database row', async () => {
    const removed: string[] = [];
    const { prisma, calls } = fakePrisma();
    const service = new RetentionService(prisma, fakeStorage(async (key) => void removed.push(key)));

    const result = await service.run(NOW);

    expect(removed).toEqual(['incident/photo.jpg', 'answer/result.pdf']);
    expect(calls).toMatchObject({ deletedIncidents: 1, deletedOutbound: 1, deletedActionLocks: 1, releasedLocks: 1 });
    expect(result).toMatchObject({ deletedIncidents: 1, deletedFiles: 2, deletedBytes: 500, failures: [] });
  });

  it('keeps the database row when a physical file cannot be removed', async () => {
    const { prisma, calls } = fakePrisma();
    const service = new RetentionService(
      prisma,
      fakeStorage(async (key) => {
        if (key.startsWith('answer/')) throw new Error('storage unavailable');
      }),
    );

    const result = await service.run(NOW);

    expect(calls.deletedIncidents).toBe(0);
    expect(result.deletedIncidents).toBe(0);
    expect(result.failures).toEqual([{ publicCode: 'INC-20260501-0001', error: 'storage unavailable' }]);
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
