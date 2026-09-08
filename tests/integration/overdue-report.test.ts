import { IncidentStatus, UserRole, type PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { sendReport } from '../../src/bot/views/report';
import { describeStatus } from '../../src/incidents/incident-state.service';
import { actorFor, createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

const NOW = new Date('2026-09-05T12:00:00Z');
const TODAY = { from: new Date('2026-09-04T21:00:00Z'), to: new Date('2026-09-05T21:00:00Z'), title: 'за сегодня', slug: 'today' };
const HOUR = 3_600_000;

describeIntegration('Excel overdue worksheet', () => {
  let prisma: PrismaClient;
  let h: TestHarness;
  let requesterId: string;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedCategories(prisma);
    h = await createHarness(prisma);
    requesterId = (await actorFor(prisma, TEST_USERS.requesterA, 'Иванов Иван', [UserRole.REQUESTER])).userId;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => prisma.$disconnect());

  async function create(code: string, status: IncidentStatus, deadline: Date, isOverdue = false) {
    return prisma.incident.create({ data: {
      publicCode: code, requesterId, requesterMaxUserId: TEST_USERS.requesterA, requesterName: 'Иванов Иван',
      requesterPhone: '+7 900 123-45-67', text: `Описание ${code}`, status,
      createdAt: new Date(deadline.getTime() - 72 * HOUR), deadlineAt: deadline, isOverdue,
    } });
  }

  it('puts all currently expired open statuses on sheet two, independent of period and cached overdue flags', async () => {
    const active = [IncidentStatus.NEW, IncidentStatus.DISTRIBUTION, IncidentStatus.ASSIGNED,
      IncidentStatus.IN_PROGRESS, IncidentStatus.WAITING_REVIEW, IncidentStatus.REVISION_REQUIRED];
    for (const [index, status] of active.entries()) {
      await create(`OLD-${index}`, status, new Date(NOW.getTime() - (24 - index) * HOUR));
    }
    await create('EXACT-DEADLINE', IncidentStatus.IN_PROGRESS, NOW);
    await create('NOT-YET', IncidentStatus.IN_PROGRESS, new Date(NOW.getTime() + 1), true);
    await create('RESOLVED', IncidentStatus.RESOLVED, new Date(NOW.getTime() - HOUR), true);
    await create('REJECTED', IncidentStatus.REJECTED, new Date(NOW.getTime() - HOUR), true);
    await create('TODAY', IncidentStatus.DISTRIBUTION, new Date(NOW.getTime() + 72 * HOUR));

    const result = await h.services.reports.build(TODAY, NOW);
    expect(result.rows).toBe(1);
    expect(result.overdueRows).toBe(7);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.buffer as never);
    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['Обращения', 'Просроченные']);
    expect(workbook.worksheets[0]!.getCell(2, 3).value).toBe('TODAY');
    const sheet = workbook.worksheets[1]!;
    expect(sheet.getCell(1, 1).value).toContain('05.09.2026 15:00');
    expect(sheet.getCell(2, 1).value).toContain('Всего: 7');
    expect(sheet.getCell(3, 5).value).toBe('Просрочка, ч');
    expect(sheet.getRow(4).values).toEqual(expect.arrayContaining(['OLD-0', 24, 'Не назначена', 'Иванов Иван']));
    const codes = Array.from({ length: result.overdueRows }, (_, index) => sheet.getCell(index + 4, 1).value);
    expect(codes).toEqual(['OLD-0', 'OLD-1', 'OLD-2', 'OLD-3', 'OLD-4', 'OLD-5', 'EXACT-DEADLINE']);
    for (const [index, status] of active.entries()) expect(sheet.getCell(index + 4, 6).value).toBe(describeStatus(status));
    expect(sheet.getCell(10, 5).value).toBe(0);
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 3 });
    expect(sheet.autoFilter).toBeTruthy();
  });

  it('keeps the second sheet with an explicit empty state when no open incidents are overdue', async () => {
    await create('TODAY', IncidentStatus.DISTRIBUTION, new Date(NOW.getTime() + 72 * HOUR));
    const result = await h.services.reports.build(TODAY, NOW);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.buffer as never);
    expect(result.overdueRows).toBe(0);
    expect(workbook.worksheets[1]!.getCell(4, 1).value).toBe('Нерешённых обращений с истекшим сроком нет.');
  });

  it('shows the resident selected topic next to the overdue number and uses Иное on both sheets for no selection', async () => {
    const category = await prisma.category.findFirstOrThrow({ where: { isActive: true } });
    const selected = await create('TOPIC', IncidentStatus.ASSIGNED, new Date(NOW.getTime() - 2 * HOUR));
    await prisma.incident.update({ where: { id: selected.id }, data: { userSelectedCategoryId: category.id } });
    await create('OTHER', IncidentStatus.DISTRIBUTION, new Date(NOW.getTime() - HOUR));
    const report = await h.services.reports.build({ ...TODAY, from: new Date(NOW.getTime() - 7 * 24 * HOUR) }, NOW);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(report.buffer as never);
    const overdue = workbook.getWorksheet('Просроченные')!;
    expect(overdue.getCell(3, 2).value).toBe('Тематика жителя');
    expect(overdue.getCell(4, 2).value).toBe(category.name);
    expect(overdue.getCell(5, 2).value).toBe('Иное');
    expect(overdue.getColumn(5).numFmt).toBe('0.0');
    const all = workbook.getWorksheet('Обращения')!;
    expect(all.getCell(1, 7).value).toBe('Тематика жителя');
    const topics = [all.getCell(2, 7).value, all.getCell(3, 7).value];
    expect(topics).toEqual(expect.arrayContaining([category.name, 'Иное']));
  });

  it('sends a workbook when the period is empty but there is an older overdue incident', async () => {
    await create('OLD', IncidentStatus.WAITING_REVIEW, new Date(NOW.getTime() - HOUR));
    const build = h.services.reports.build.bind(h.services.reports);
    vi.spyOn(h.services.reports, 'build').mockImplementation(range => build(range, NOW));
    await sendReport(h.services, TEST_CHATS.distribution, TODAY, TEST_USERS.admin);
    const delivered = h.messages.toChat(TEST_CHATS.distribution).find(entry => entry.message.attachments?.length);
    expect(delivered?.message.text).toContain('Обращений за период: 0');
    expect(delivered?.message.text).toContain('Текущих просроченных: 1');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(delivered!.message.attachments![0]!.body as never);
    expect(workbook.worksheets[1]!.getCell(4, 1).value).toBe('OLD');
  });
});
