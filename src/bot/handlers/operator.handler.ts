import { answerDeliveredNotice } from '../../delivery/delivery-status';
import { type OperatorSession, SessionType } from '@prisma/client';

import type { AppServices } from '../../app/container';
import { HistoryAction } from '../../incidents/incident-history.service';
import type { Message } from '../../max/max-types';
import { classifyAttachments } from '../../media/media.service';
import { AppError, ValidationError, reportActionError } from '../../utils/errors';
import { incidentLogFields, moduleLogger } from '../../utils/logger';
import { isBlank } from '../../utils/text';
import { parseReportRange } from '../../reports/report-range';
import { assertApprover, assertDispatcher, assertResponder, assertWorkingChat, requirePermission } from '../middleware/authorize';
import { sendReport } from '../views/report';
import { codeLabel } from '../views/cards';
import type { ResolvedActor } from './helpers';
import { discardObsoleteSession } from './session-guard';
import { acceptRejectionText } from '../callbacks/rejection-flow';
import { acceptReviewEditText } from '../callbacks/review-edit-flow';
import { prepareInputConfirmation, pendingConfirmation } from '../callbacks/staff-confirmation';

const log = moduleLogger('bot-operator');

/**
 * §19, §20, §23, §32 — the text an operator sends after pressing a button.
 *
 * The message is bound to an incident *only* through the persisted session for
 * (maxUserId, chatId). Nothing here looks at "the most recent incident" or at
 * message text, so two operators typing in the same chat at the same time can
 * never have their input attached to each other's incident.
 */
export async function handleOperatorMessage(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  message: Message,
  session: OperatorSession,
  options: { confirmed?: boolean } = {},
): Promise<void> {
  const text = (message.body.text ?? '').trim();
  const media = classifyAttachments(message.body.attachments);

  try {
    await assertWorkingChat(services, chatId);
    if (await discardObsoleteSession(services, session)) throw new ValidationError('Обращение уже перешло на другой этап. Незавершённое действие сброшено. Откройте актуальную карточку через /queue или проверьте статус через /today.');
    if (!options.confirmed && pendingConfirmation(session)) throw new ValidationError('Бот ждёт подтверждения кнопкой. Нажмите «Подтвердить», «Исправить» или «Отмена» в предварительном просмотре.');
    if (!options.confirmed && ['WAITING_FOR_ANSWER', 'WAITING_REVISION_REASON', 'WAITING_BAN_REASON'].includes(session.type) && !(session.data as { reviewEdit?: boolean } | null)?.reviewEdit) {
      await prepareInputConfirmation(services, actor, chatId, session, message); return;
    }
    switch (session.type) {
      case SessionType.WAITING_CLARIFICATION_QUESTION:
      case SessionType.WAITING_CLARIFICATION_REPLY:
        await services.prisma.operatorSession.deleteMany({ where: { id: session.id } });
        throw new ValidationError('Запросы уточнений у жителей больше не используются. Продолжите работу с карточкой обращения.');
      case SessionType.WAITING_REJECTION_REASON:
        await acceptRejectionText(services, actor, chatId, session, text);
        break;
      case SessionType.WAITING_REVISION_REASON:
        if ((session.data as { reviewEdit?: boolean } | null)?.reviewEdit) {
          if (media.length) throw new ValidationError('Для правки нужен только текст. Уже приложенные фото и файлы сохранятся.');
          await acceptReviewEditText(services, actor, chatId, session, text);
        } else await applyRevision(services, actor, chatId, session, text);
        break;
      case SessionType.WAITING_FOR_ANSWER:
        await applyAnswer(services, actor, chatId, session, text, media);
        break;
      case SessionType.WAITING_BAN_REASON:
        await applyBan(services, actor, chatId, session, text);
        break;
      case SessionType.WAITING_REPORT_PERIOD:
        await applyReportPeriod(services, actor, chatId, text);
        break;
      case SessionType.WAITING_INCIDENT_TEXT:
      case SessionType.WAITING_CUSTOM_LOCALITY:
      case SessionType.WAITING_REQUESTER_NAME:
      case SessionType.WAITING_REQUESTER_PHONE:
      case SessionType.WAITING_INCIDENT_SELECTION:
      case SessionType.WAITING_INCIDENT_CONFIRMATION:
      case SessionType.WAITING_INCIDENT_EDIT_SELECTION:
      case SessionType.WAITING_INCIDENT_EDIT_VALUE:
        // A requester draft leaking into a working chat: ignore it.
        await services.sessions.clear(actor.maxUserId, chatId);
        break;
    }
  } catch (error) {
    // The session is intentionally left in place so the operator can retry
    // without pressing the button again.
    log.warn(
      incidentLogFields({
        incidentId: session.incidentId ?? undefined,
        maxUserId: actor.maxUserId,
        chatId,
        action: session.type,
      }),
      `operator action failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await reportActionError(error, () => services.messages.send(
      { chatId },
      { text: error instanceof AppError ? error.message : 'Не удалось выполнить действие. Попробуйте ещё раз.' },
    ));
  }
}

function requireIncidentId(session: OperatorSession): string {
  if (!session.incidentId) throw new AppError('Действие не привязано к обращению.', 'SESSION_BROKEN');
  return session.incidentId;
}

async function loadIncident(services: AppServices, incidentId: string) {
  const incident = await services.repository.findById(incidentId);
  if (!incident) throw new AppError('Обращение не найдено.', 'NOT_FOUND');
  return incident;
}

async function applyRevision(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  session: OperatorSession,
  reason: string,
): Promise<void> {
  const returnData = session.data as { redistribution?: boolean; assignedGroupId?: string } | null;
  if (returnData?.redistribution) {
    await services.sector.returnToDistribution(requireIncidentId(session), actor, chatId, reason, returnData.assignedGroupId);
    await services.prisma.operatorSession.deleteMany({ where: { id: session.id } });
    await services.messages.send({ chatId }, { text: '↩️ Обращение возвращено в очередь распределения. Причина сохранена, срок ответа не изменён.' });
    return;
  }
  assertApprover(services, actor, chatId);
  if (isBlank(reason)) throw new ValidationError('Причина возврата не может быть пустой.');

  const incidentId = requireIncidentId(session);
  const data = session.data as { reviewAnswerId?: string } | null;
  if (!data?.reviewAnswerId) {
    await services.sessions.clear(actor.maxUserId, chatId);
    throw new ValidationError('Действие устарело. Нажмите «На доработку» в актуальной карточке ответа.');
  }
  const incident = await services.review.requestRevision(incidentId, reason, actor, data.reviewAnswerId);
  await services.prisma.operatorSession.deleteMany({ where: { id: session.id } });
  await services.messages.send(
    { chatId },
    {
      text: `↩️ ${incident.publicCode} возвращено на доработку.\n\n⚠️ Срок ответа НЕ изменён.`,
      label: codeLabel(incident),
    },
  );
}

async function applyAnswer(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  session: OperatorSession,
  text: string,
  media: ReturnType<typeof classifyAttachments>,
): Promise<void> {
  const incidentId = requireIncidentId(session);
  const incident = await loadIncident(services, incidentId);
  assertResponder(actor, incident, chatId);

  const { answer, sentDirectly, deliveryFailed, deliveryQueued } = await services.answers.submit(incidentId, actor, text, media);
  await services.prisma.operatorSession.deleteMany({ where: { id: session.id } });
  await services.messages.send(
    { chatId },
    {
      text: deliveryFailed
        ? `⚠️ ${incident.publicCode}: ответ сохранён, но не доставлен. Повторите командой /resend ${incident.publicCode}.`
        : deliveryQueued
        ? `⏳ ${incident.publicCode}: ответ (версия ${answer.version}) сохранён, ожидает доставки пользователю.`
        : sentDirectly
        ? answerDeliveredNotice(incident, answer)
        : `📝 ${incident.publicCode}: ответ (версия ${answer.version}) отправлен на согласование.`,
      label: codeLabel(incident),
      ...(sentDirectly && !deliveryFailed && !deliveryQueued ? { delivery: { dedupeKey: `answer-delivered:${answer.id}:sector` } } : {}),
    },
  );
}

/**
 * §40 — the period typed after "📅 Указать период".
 *
 * A malformed period keeps the session open, so the operator can simply
 * retype it instead of pressing the button again.
 */
async function applyReportPeriod(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  text: string,
): Promise<void> {
  requirePermission(actor, 'report.generate');
  const range = parseReportRange(text);
  await sendReport(services, chatId, range, actor.maxUserId);
  await services.sessions.clear(actor.maxUserId, chatId);
}

async function applyBan(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  session: OperatorSession,
  reason: string,
): Promise<void> {
  requirePermission(actor, 'user.ban');
  assertDispatcher(services, actor, chatId);
  if (isBlank(reason)) throw new ValidationError('Причина блокировки не может быть пустой.');

  const incidentId = requireIncidentId(session);
  const incident = await loadIncident(services, incidentId);

  await services.bans.ban({
    maxUserId: incident.requesterMaxUserId,
    reason,
    createdById: actor.userId,
  });
  await services.history.record({
    incidentId,
    action: HistoryAction.USER_BANNED,
    actorMaxUserId: actor.maxUserId,
    actorRole: actor.role,
    metadata: { targetMaxUserId: incident.requesterMaxUserId.toString(), reason },
  });
  await services.prisma.operatorSession.deleteMany({ where: { id: session.id } });
  await services.messages.send(
    { chatId },
    {
      text: [
        `🚫 Автор ${incident.publicCode} заблокирован.`,
        '',
        `Пользователь: ${incident.requesterName} (${incident.requesterMaxUserId.toString()})`,
        '',
        'Причина:',
        reason,
      ].join('\n'),
    },
  );
}
