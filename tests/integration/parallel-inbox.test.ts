import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { UpdateDispatcher, updatePartition } from '../../src/server/update-dispatcher';
import type { Update } from '../../src/max/max-types';
import { createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase } from '../helpers/integration';

const update = (user: number, mid: string): Update => ({ update_type: 'message_created', timestamp: 1,
  message: { sender: { user_id: user, name: 'Test' }, recipient: { chat_id: user, chat_type: 'dialog' }, body: { mid, text: 'Test' } },
}) as unknown as Update;
describeIntegration('bounded parallel inbox', () => {
  let prisma: PrismaClient;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(() => resetDatabase(prisma));
  afterAll(() => prisma.$disconnect());
  afterEach(() => vi.restoreAllMocks());

  it('serializes persistence of one user even when the first database insert is slow', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const insert = prisma.inboundUpdate.create.bind(prisma.inboundUpdate);
    const create = vi.fn((args: Parameters<typeof insert>[0]) => insert(args));
    create.mockImplementationOnce(args => blocked.then(() => insert(args)) as ReturnType<typeof insert>);
    // Wrap Prisma instead of spying on its dynamic delegate proxy.
    const wrapped = { processedUpdate: prisma.processedUpdate, inboundUpdate: { create } };
    const worker = new UpdateDispatcher(wrapped as never, { dispatch: async () => undefined } as never, 2);
    const first = worker.reserve(update(1, 'first-reservation'));
    const second = worker.reserve(update(1, 'second-reservation'));
    try {
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(await prisma.inboundUpdate.count()).toBe(0);
    } finally { release(); await Promise.all([first, second]); }
    const rows = await prisma.inboundUpdate.findMany({ orderBy: { sequence: 'asc' } });
    expect(rows.map(row => row.externalUpdateKey)).toEqual(['message_created:first-reservation', 'message_created:second-reservation']);
  });

  it('a slow user does not block another; the slow user’s next event waits in the database', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const events: string[] = [];
    const max = { dispatch: async (event: Update) => {
      const id = (event as ReturnType<typeof update> & { message: { body: { mid: string } } }).message.body.mid;
      events.push(id);
      if (id === 'a1') await blocked;
    } };
    const worker = new UpdateDispatcher(prisma, max as never, 2);
    for (const event of [update(1, 'a1'), update(1, 'a2'), update(2, 'b1')]) await worker.reserve(event);
    const work = worker.kick();
    try {
      await vi.waitFor(() => {
        expect(events).toHaveLength(2);
        expect(events).toEqual(expect.arrayContaining(['a1', 'b1']));
      });
      expect(await prisma.inboundUpdate.count({ where: { partitionKey: 'user:1', status: 'PENDING' } })).toBe(1);
    } finally { release(); await work; }
    expect(events).toHaveLength(3);
    expect(events.filter(id => id.startsWith('a'))).toEqual(['a1', 'a2']);
    expect(events.at(-1)).toBe('a2');
    expect(await prisma.inboundUpdate.count({ where: { status: 'PROCESSED' } })).toBe(3);
  });

  it('processes a 100-event burst within the configured cap, without overlap per user or duplicates', async () => {
    let concurrent = 0; let peak = 0;
    const active = new Set<string>(); const completed: string[] = [];
    const worker = new UpdateDispatcher(prisma, { dispatch: async (event: Update) => {
      const key = updatePartition(event);
      expect(active.has(key)).toBe(false); active.add(key);
      peak = Math.max(peak, ++concurrent);
      await new Promise(resolve => setTimeout(resolve, 15));
      active.delete(key); concurrent--; completed.push(key);
    } } as never, 4);
    for (let i = 0; i < 100; i++) await worker.reserve(update(i % 20, `burst-${i}`));
    await Promise.all([worker.kick(), worker.kick()]);
    expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(4);
    expect(completed).toHaveLength(100);
    expect(await prisma.inboundUpdate.count({ where: { status: 'PROCESSED' } })).toBe(100);
    expect(await prisma.inboundUpdate.count({ where: { status: 'FAILED' } })).toBe(0);
  });

  it('keeps callbacks in their author’s lane instead of the bot sender’s lane', () => {
    expect(updatePartition({ ...update(999, 'bot-message'), update_type: 'message_callback', callback: { user: { user_id: 12 } } } as unknown as Update)).toBe('user:12');
  });
});
