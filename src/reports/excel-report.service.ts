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
    header: 'Категория пользователя',
    width: 24,
    value: (incident) => incident.userSelectedCategory?.name ?? 'Не знаю',
  },
  {
    header: 'Итоговая категория',
    width: 24,
    value: (incident) => incident.assignedCategory?.name ?? '',
  },
  {
    header: 'Статус',
    width: 22,
    value: (incident) => describeStatus(incident.status, false),
  },
  { header: 'Количество доработок', width: 20, value: (incident) => incident.revisionCount },
  { header: 'Дедлайн', width: 20, value: (incident) => formatDateTime(incident.deadlineAt) },
  { header: 'Просрочено', width: 12, value: (incident) => (incident.isOverdue ? 'да' : 'нет') },
  { header: 'Пользователь', width: 28, value: (incident) => incident.requesterName },
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

export class ExcelReportService {
  constructor(private readonly repository: IncidentRepository) {}

  async build(range: ReportRange): Promise<{ buffer: Buffer; fileName: string; rows: number }> {
    const incidents = await this.repository.listForReport({ from: range.from, to: range.to });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'MAX Incident Bot';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Обращения', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    sheet.columns = COLUMNS.map((column) => ({ header: column.header, width: column.width }));

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: 'middle' };

    for (const incident of incidents) {
      const row = sheet.addRow(COLUMNS.map((column) => column.value(incident)));
      row.alignment = { vertical: 'top', wrapText: true };
    }

    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: COLUMNS.length },
    };

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const fileName = reportFileName(range);
    log.info({ rows: incidents.length, fileName }, 'excel report generated');
    return { buffer, fileName, rows: incidents.length };
  }
}
