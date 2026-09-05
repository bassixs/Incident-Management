import type { AppServices } from '../../app/container';
import type { ReportRange } from '../../reports/report-range';
import { moduleLogger } from '../../utils/logger';
import { assertWorkingChat } from '../middleware/authorize';

const log = moduleLogger('bot-report');

/**
 * Build the XLSX and deliver it into the chat that asked for it.
 *
 * Shared by the `/report` command and the period buttons so both paths
 * produce exactly the same file and the same messages.
 */
export async function sendReport(
  services: AppServices,
  chatId: bigint,
  range: ReportRange,
  actorMaxUserId: bigint,
): Promise<void> {
  await assertWorkingChat(services, chatId);
  await services.messages.send({ chatId }, { text: `Готовлю отчёт ${range.title}…` });

  const { buffer, fileName, rows, overdueRows } = await services.reports.build(range);

  if (rows === 0 && overdueRows === 0) {
    await services.messages.send(
      { chatId },
      { text: `За этот период обращений нет (${range.title}), текущих просроченных тоже нет. Файл не формировался.` },
    );
    return;
  }

  await services.messages.send(
    { chatId },
    {
      text: `📊 Отчёт ${range.title}\nОбращений за период: ${rows}\nТекущих просроченных: ${overdueRows} — на втором листе`,
      attachments: [{ type: 'FILE', body: buffer, originalName: fileName }],
    },
  );

  log.info(
    { fileName, rows, overdueRows, chatId: chatId.toString(), maxUserId: actorMaxUserId.toString() },
    'report delivered',
  );
}
