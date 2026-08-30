import { SessionType } from '@prisma/client';

import type { AppServices } from '../../app/container';
import type { CallbackPayload } from '../../max/callback-payload';
import { PERIOD_TEMPLATE, rangeForPreset, type ReportPreset } from '../../reports/report-range';
import { requirePermission } from '../middleware/authorize';
import { ensureFreeSession } from '../handlers/session-guard';
import type { ResolvedActor } from '../handlers/helpers';
import { sendReport } from '../views/report';

export type ReportCallbackContext = {
  services: AppServices;
  actor: ResolvedActor;
  chatId: bigint | undefined;
};

/**
 * Period buttons under `/report` (§40).
 *
 * The permission is re-checked here rather than trusted from the fact that a
 * button exists — a card stays in the chat history and anyone can press it.
 */
export async function handleReportCallback(
  context: ReportCallbackContext,
  payload: Extract<CallbackPayload, { kind: 'report' }>,
): Promise<string | undefined> {
  const { services, actor, chatId } = context;
  requirePermission(actor, 'report.generate');
  if (chatId === undefined) return 'Отчёт доступен только в рабочем чате.';

  if (payload.action === 'custom') {
    if (!(await ensureFreeSession(services, actor, chatId))) return undefined;
    await services.sessions.start({
      maxUserId: actor.maxUserId,
      chatId,
      type: SessionType.WAITING_REPORT_PERIOD,
    });
    await services.messages.send(
      { chatId },
      {
        text: [
          'Отправьте период одним сообщением в формате:',
          '',
          PERIOD_TEMPLATE,
          '',
          'Можно указать и одну дату — отчёт будет за этот день.',
        ].join('\n'),
      },
    );
    return undefined;
  }

  const range = rangeForPreset(payload.action as ReportPreset);
  await sendReport(services, chatId, range, actor.maxUserId);
  return `Отчёт ${range.title}`;
}
