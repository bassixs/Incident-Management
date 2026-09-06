import { AnswerStatus } from '@prisma/client';
import ExcelJS from 'exceljs';

import { describeStatus } from '../incidents/incident-state.service';
import type { IncidentRepository, IncidentWithRelations } from '../incidents/incident.repository';
import { formatDateTime } from '../utils/datetime';
import { moduleLogger } from '../utils/logger';
import { reportFileName, type ReportRange } from './report-range';

const log = moduleLogger('reports');

type Column = {
  header: string;
  width: number;
  value: (incident: IncidentWithRelations) => string | number;
};

/** One incident = one row (§39). Required columns come first. */
const COLUMNS: Column[] = [
  { header: 'Дата обращения', width: 20, value: (incident) => formatDateTime(incident.createdAt) },
  {
    header: 'Дата ответа',
    width: 20,
    value: (incident) => (incident.answeredAt ? formatDateTime(incident.answeredAt) : ''),
  },
  { header: 'Уникальный номер', width: 22, value: (incident) => incident.publicCode },
  { header: 'Обращение', width: 60, value: (incident) => incident.text },
  { header: 'Ответ', width: 60, value: (incident) => finalAnswerText(incident) },
  {
    header: 'Оценка ответа (1–5)',
    width: 20,
    value: (incident) => incident.responseRating ?? '',
  },
  {
    header: 'Категория пользователя',
    width: 24,
    value: (incident) => incident.userSelectedCategory?.name ?? 'Не знаю',
  },
  {
    header: 'Округ или город проблемы',
    width: 30,
    value: (incident) => incident.problemMunicipalityName ?? '',
  },
  {
    header: 'Населённый пункт',
    width: 24,
    value: (incident) => incident.problemLocality ?? '',
  },
  {
    header: 'Ответственная группа',
    width: 34,
    value: (incident) => incident.assignedGroup?.name ?? '',
  },
  {
    header: 'Статус',
    width: 22,
    value: (incident) => incident.slaPausedAt ? 'Ожидаем уточнение от жителя' : describeStatus(incident.status, false),
  },
  { header: 'Количество доработок', width: 20, value: (incident) => incident.revisionCount },
  { header: 'Дедлайн', width: 20, value: (incident) => incident.slaPausedAt ? 'Срок приостановлен' : formatDateTime(incident.deadlineAt) },
  { header: 'Просрочено', width: 12, value: (incident) => (incident.slaPausedAt ? 'пауза' : incident.isOverdue ? 'да' : 'нет') },
  { header: 'Пользователь', width: 28, value: (incident) => incident.requesterName },
  { header: 'Телефон', width: 20, value: (incident) => incident.requesterPhone ?? '' },
  {
    header: 'MAX ID пользователя',
    width: 20,
    value: (incident) => incident.requesterMaxUserId.toString(),
  },
  {
    header: 'Ответственный',
    width: 28,
    value: (incident) => incident.currentResponder?.displayName ?? '',
  },
  {
    header: 'Распределил',
    width: 28,
    value: (incident) => incident.assignedBy?.displayName ?? '',
  },
  {
    header: 'Согласовал',
    width: 28,
    value: (incident) => incident.approvedBy?.displayName ?? '',
  },
  {
    header: 'Причина отклонения',
    width: 40,
    value: (incident) => incident.rejectionReason ?? '',
  },
];

function finalAnswerText(incident: IncidentWithRelations): string {
  const approved = [...incident.answers].reverse().find((answer) => answer.status === AnswerStatus.APPROVED);
  return (approved ?? incident.answers.at(-1))?.text ?? '';
}

function overdueColumns(now: Date): Column[] {
  return [
    { header: 'Уникальный номер', width: 24, value: incident => incident.publicCode },
    { header: 'Дата обращения', width: 21, value: incident => formatDateTime(incident.createdAt) },
    { header: 'Дедлайн', width: 21, value: incident => formatDateTime(incident.deadlineAt) },
    { header: 'Просрочка, ч', width: 16, value: incident =>
      Math.round((now.getTime() - incident.deadlineAt.getTime()) / 360_000) / 10 },
    { header: 'Статус', width: 26, value: incident => describeStatus(incident.status, false) },
    { header: 'Ответственная группа', width: 36, value: incident => incident.assignedGroup?.name ?? 'Не назначена' },
    { header: 'Ответственный', width: 28, value: incident => incident.currentResponder?.displayName ?? 'Не назначен' },
    { header: 'Обращение', width: 60, value: incident => incident.text },
    { header: 'Категория пользователя', width: 24, value: incident => incident.userSelectedCategory?.name ?? 'Не знаю' },
    { header: 'Округ или город проблемы', width: 30, value: incident => incident.problemMunicipalityName ?? '' },
    { header: 'Населённый пункт', width: 24, value: incident => incident.problemLocality ?? '' },
    { header: 'Пользователь', width: 28, value: incident => incident.requesterName },
    { header: 'Телефон', width: 20, value: incident => incident.requesterPhone ?? '' },
  ];
}

function addIncidentSheet(workbook: ExcelJS.Workbook, name: string, columns: Column[], incidents: IncidentWithRelations[], headerRow = 1): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: headerRow }] });
  sheet.columns = columns.map(column => ({ width: column.width }));
  const header = sheet.getRow(headerRow);
  header.values = columns.map(column => column.header);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 30;
  for (const incident of incidents) {
    const row = sheet.addRow(columns.map(column => column.value(incident)));
    row.alignment = { vertical: 'top', wrapText: true };
  }
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: Math.max(headerRow, sheet.rowCount), column: columns.length } };
  return sheet;
}

export class ExcelReportService {
  constructor(private readonly repository: IncidentRepository) {}

  async build(range: ReportRange, now = new Date()): Promise<{ buffer: Buffer; fileName: string; rows: number; overdueRows: number }> {
    const [incidents, overdue] = await Promise.all([
      this.repository.listForReport({ from: range.from, to: range.to }),
      this.repository.listOverdueForReport(now),
    ]);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'MAX Incident Bot';
    workbook.created = now;
    addIncidentSheet(workbook, 'Обращения', COLUMNS, incidents);

    const columns = overdueColumns(now);
    const sheet = addIncidentSheet(workbook, 'Просроченные', columns, overdue, 3);
    sheet.mergeCells(1, 1, 1, columns.length);
    sheet.getCell(1, 1).value = `Нерешённые обращения с истекшим сроком — на ${formatDateTime(now)}`;
    sheet.getRow(1).font = { bold: true, size: 14, color: { argb: 'FF9C0006' } };
    sheet.getRow(1).height = 26;
    sheet.mergeCells(2, 1, 2, columns.length);
    sheet.getCell(2, 1).value = `Все текущие просроченные обращения независимо от выбранного периода. Всего: ${overdue.length}.`;
    sheet.getRow(2).height = 22;
    sheet.getColumn(4).numFmt = '0.0';
    if (overdue.length === 0) {
      sheet.mergeCells(4, 1, 4, columns.length);
      sheet.getCell(4, 1).value = 'Нерешённых обращений с истекшим сроком нет.';
    }

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const fileName = reportFileName(range);
    log.info({ rows: incidents.length, overdueRows: overdue.length, fileName }, 'excel report generated');
    return { buffer, fileName, rows: incidents.length, overdueRows: overdue.length };
  }
}
