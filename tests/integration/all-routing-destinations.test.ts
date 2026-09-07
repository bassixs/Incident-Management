import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { type PrismaClient, type ResponsibleGroup } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildServices, type AppServices } from '../../src/app/container';
import { handleCallbackUpdate } from '../../src/bot/callbacks';
import { assignmentBranchKeyboard, assignmentGroupKeyboard, assignmentPageCount } from '../../src/bot/keyboards';
import { incidentCallback, parseCallbackPayload } from '../../src/max/callback-payload';
import { MaxMessageService } from '../../src/max/max-message.service';
import type { Button, SendMessageExtra } from '../../src/max/max-types';
import { MediaService } from '../../src/media/media.service';
import { RESPONSIBLE_GROUPS } from '../../src/responsible-groups/catalog';
import { PROBLEM_MUNICIPALITIES } from '../../src/locations/problem-locations';
import { createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase } from '../helpers/integration';
import { TEST_CHATS } from '../helpers/setup-env';

// Optional production snapshot contains group configuration only, never incidents.
// Every write still uses the isolated TEST_DATABASE_URL and a simulated MAX client.
const snapshot = process.env.ROUTING_SNAPSHOT_PATH
  ? JSON.parse(readFileSync(process.env.ROUTING_SNAPSHOT_PATH, 'utf8')) as { groups: ResponsibleGroup[]; problems: string[] }
  : undefined;
type Sent = { target: bigint; text: string; extra?: SendMessageExtra; mid: string };

describeIntegration('all 50 configured routing destinations', () => {
  let prisma: PrismaClient; let services: AppServices; let messages: MaxMessageService;
  let groups: ResponsibleGroup[]; let sent: Sent[]; let rejectTarget: bigint | undefined;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => {
    await resetDatabase(prisma);
    if (snapshot) expect(snapshot.problems).toEqual([]);
    const source = snapshot?.groups ?? RESPONSIBLE_GROUPS;
    await prisma.responsibleGroup.createMany({ data: source.map((g, i) => ({
      id: 'id' in g ? g.id : randomUUID(), code: g.code, name: g.name, kind: g.kind,
      maxChatId: BigInt(g.maxChatId!), municipalityCode: g.municipalityCode ?? null,
      authorityName: g.authorityName ?? g.name, bypassReview: g.bypassReview ?? false,
      isActive: 'isActive' in g ? g.isActive : true, sortOrder: 'sortOrder' in g ? g.sortOrder : i,
      answerTemplate: 'answerTemplate' in g ? g.answerTemplate : null,
    })) });
    groups = await prisma.responsibleGroup.findMany({ orderBy: { sortOrder: 'asc' } });
    sent = []; rejectTarget = undefined;
    const send = async (target: bigint, text: string, extra?: SendMessageExtra) => {
      if (target === rejectTarget) throw new Error('Simulated unavailable destination');
      const mid = randomUUID(); sent.push({ target, text, ...(extra ? { extra } : {}), mid });
      return { body: { mid } };
    };
    const max = { sendToChat: vi.fn(send), sendToUser: vi.fn(send), editMessage: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined), answerCallback: vi.fn(async () => undefined),
      api: { getPinnedMessage: vi.fn(async () => ({ message: null })), pinMessage: vi.fn(async () => ({})) } };
    const storage = { load: vi.fn().mockRejectedValue(new Error('Unexpected local photo read')), save: vi.fn(), remove: vi.fn() };
    messages = new MaxMessageService(max as never, { prisma, storage: storage as never });
    services = buildServices(prisma, { messages, media: new MediaService(storage as never, max as never), storage: storage as never });
    services.max = max as never;
  });

  function pickerButtons(incidentId: string, recommendation: ResponsibleGroup | null = null) {
    const buttons = assignmentBranchKeyboard(incidentId, groups.find(g => g.kind === 'REGIONAL')!, recommendation).flat();
    for (const [branch, kind] of [['local', 'LOCAL_GOVERNMENT'], ['executive', 'EXECUTIVE_AUTHORITY']] as const) {
      const subset = groups.filter(g => g.kind === kind && g.isActive);
      const recommended = recommendation?.kind === kind ? recommendation : null;
      for (let page = 0; page < assignmentPageCount(subset.length); page++) {
        buttons.push(...assignmentGroupKeyboard(incidentId, branch, subset, page, recommended).flat());
      }
    }
    return buttons.filter((b): b is Extract<Button, { type: 'callback' }> => {
      if (b.type !== 'callback') return false;
      const p = parseCallbackPayload(b.payload); return p?.kind === 'incident' && p.action === 'assign-group';
    });
  }
  async function create(index: number) {
    return services.incidents.create({
      requester: { maxUserId: BigInt(88000 + index), name: 'Тест маршрута', phone: '+79001112233' },
      text: `Проверка направления ${index}`,
      media: [{ kind: 'IMAGE', token: `route-${index}-a` }, { kind: 'IMAGE', token: `route-${index}-b` }],
    });
  }
  async function click(payload: string, index: number, chatId = TEST_CHATS.distribution) {
    await handleCallbackUpdate(services, { update: { update_type: 'message_callback', timestamp: Date.now(),
      callback: { callback_id: randomUUID(), user: { user_id: 89000 + index, name: 'Оператор', is_bot: false }, payload },
      message: { sender: { user_id: 999, name: 'Бот', is_bot: true }, recipient: { chat_id: Number(chatId), chat_type: 'chat' }, body: { mid: randomUUID() } },
    } } as never);
  }

  it('covers every destination exactly once across pages and recommends the correct group for all 27 territories', async () => {
    expect(groups).toHaveLength(50); expect(new Set(groups.map(g => g.maxChatId)).size).toBe(50);
    const id = randomUUID(); const buttons = pickerButtons(id);
    expect(buttons).toHaveLength(50);
    const ids = buttons.map(b => { const p = parseCallbackPayload(b.payload); return p?.kind === 'incident' ? p.argument : null; });
    expect(new Set(ids).size).toBe(50);
    for (const g of groups) {
      const b = buttons.find(b => b.payload === incidentCallback('assign-group', id, g.id));
      expect(b?.text, g.code).toContain(g.name);
      const expected = RESPONSIBLE_GROUPS.find(e => e.code === g.code)!;
      expect(g.maxChatId, g.code).toBe(expected.maxChatId); expect(g.name, g.code).toBe(expected.name);
    }
    for (const municipality of PROBLEM_MUNICIPALITIES) {
      const recommendation = await services.distribution.recommendedGroup(municipality.code);
      expect(recommendation?.municipalityCode, municipality.code).toBe(municipality.code);
      const recommended = pickerButtons(id, recommendation).filter(b => b.text.startsWith('⭐'));
      expect(recommended, municipality.code).toHaveLength(1);
      expect(recommended[0]!.payload).toBe(incidentCallback('assign-group', id, recommendation!.id));
    }
  });

  it('routes 50 incidents with 100 photos through actual button handlers/outbox to their own chats, including concurrent clicks', async () => {
    const cases = [];
    for (const [index, group] of groups.entries()) {
      const incident = await create(index);
      const button = pickerButtons(incident.id).find(b => b.payload === incidentCallback('assign-group', incident.id, group.id))!;
      cases.push({ incident, group, index, button });
    }
    for (let start = 0; start < cases.length; start += 8) {
      await Promise.all(cases.slice(start, start + 8).map(c => click(c.button.payload, c.index)));
    }
    await messages.flush();
    for (const c of cases) {
      const row = await prisma.incident.findUniqueOrThrow({ where: { id: c.incident.id } });
      expect(row.status, c.group.code).toBe('ASSIGNED'); expect(row.assignedGroupId, c.group.code).toBe(c.group.id);
      const jobs = await prisma.outboundMessage.findMany({ where: { incidentId: row.id, trackingType: 'SECTOR_CARD' } });
      expect(jobs, c.group.code).toHaveLength(1); expect(jobs[0]!.status, c.group.code).toBe('SENT');
      expect(jobs[0]!.targetId, c.group.code).toBe(c.group.maxChatId);
      const deliveries = sent.filter(m => m.text.includes(row.publicCode) && groups.some(g => g.maxChatId === m.target));
      expect(deliveries, c.group.code).toHaveLength(1);
      expect(deliveries[0]!.target, c.group.code).toBe(c.group.maxChatId);
      expect(row.sectorMessageId, c.group.code).toBe(deliveries[0]!.mid);
      const tokens = deliveries[0]!.extra?.attachments?.flatMap(a => a.type === 'image' ? [a.payload.token] : []);
      expect(tokens, c.group.code).toEqual([`route-${c.index}-a`, `route-${c.index}-b`]);
      await click(c.button.payload, c.index);
    }
    await messages.flush();
    expect(await prisma.incidentHistory.count({ where: { action: 'ASSIGNED' } })).toBe(50);
    expect(await prisma.outboundMessage.count({ where: { trackingType: 'SECTOR_CARD' } })).toBe(50);
    expect(sent.filter(m => groups.some(g => g.maxChatId === m.target))).toHaveLength(50);
    expect(await prisma.outboundMessage.count({ where: { status: { not: 'SENT' } } })).toBe(0);
  }, 120_000);

  it('keeps a failed delivery at its selected destination and rejects a copied distribution button in another chat', async () => {
    const group = groups[1]!; const other = groups[2]!; const a = await create(0); const b = await create(1);
    const payload = incidentCallback('assign-group', a.id, group.id);
    await click(payload, 0, other.maxChatId!);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('DISTRIBUTION');
    rejectTarget = group.maxChatId!;
    await click(payload, 0); await click(incidentCallback('assign-group', b.id, other.id), 1); await messages.flush();
    const failed = await prisma.outboundMessage.findFirstOrThrow({ where: { incidentId: a.id, trackingType: 'SECTOR_CARD' } });
    expect(failed.status).toBe('PENDING'); expect(failed.targetId).toBe(group.maxChatId);
    expect(sent.filter(m => m.text.includes(a.publicCode) && groups.some(g => g.maxChatId === m.target))).toHaveLength(0);
    expect(sent.filter(m => m.text.includes(b.publicCode) && m.target === other.maxChatId)).toHaveLength(1);
    rejectTarget = undefined;
    await prisma.outboundMessage.update({ where: { id: failed.id }, data: { nextAttemptAt: new Date(0) } });
    await messages.flush();
    expect(sent.filter(m => m.text.includes(a.publicCode) && m.target === group.maxChatId)).toHaveLength(1);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe('SENT');
  });
});
