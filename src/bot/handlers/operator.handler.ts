import { type OperatorSession, SessionType } from '@prisma/client';

import type { AppServices } from '../../app/container';
import { HistoryAction } from '../../incidents/incident-history.service';
import type { Message } from '../../max/max-types';
import { classifyAttachments } from '../../media/media.service';
import { AppError, ValidationError } from '../../utils/errors';
import { incidentLogFields, moduleLogger } from '../../utils/logger';
import { isBlank } from '../../utils/text';
import { parseReportRange } from '../../reports/report-range';
import { assertApprover, assertDispatcher, assertResponder, requirePermission } from '../middleware/authorize';
import { sendReport } from '../views/report';
import { codeLabel } from '../views/cards';
import type { ResolvedActor } from './helpers';

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
): Promise<void> {
  const text = (message.body.text ?? '').trim();
  const media = classifyAttachments(message.body.attachments);

  try {
    switch (session.type) {
      case SessionType.WAITING_REJECTION_REASON:
        await applyRejection(services, actor, chatId, session, text);
        break;
      case SessionType.WAITING_REVISION_REASON:
        await applyRevision(services, actor, chatId, session, text);
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
    await services.messages.send(
      { chatId },
      { text: error instanceof AppError ? error.message : 'Не удалось выполнить действие. Попробуйте ещё раз.' },
    );
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

async function applyRejection(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  session: OperatorSession,
  reason: string,
): Promise<void> {
  assertDispatcher(services, actor, chatId);
  if (isBlank(reason)) throw new ValidationError('Причина отклонения не может быть пустой.');

  const incidentId = requireIncidentId(session);
  const incident = await services.distribution.reject(incidentId, reason, actor);
  await services.sessions.clear(actor.maxUserId, chatId);
  await services.messages.send(
    { chatId },
    { text: `❌ ${incident.publicCode} отклонено. Пользователь уведомлён.`, label: codeLabel(incident) },
  );
}

async function applyRevision(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  session: OperatorSession,
  reason: string,
): Promise<void> {
  assertApprover(services, actor, chatId);
  if (isBlank(reason)) throw new ValidationError('Причина возврата не может быть пустой.');

  const incidentId = requireIncidentId(session);
  const incident = await services.review.requestRevision(incidentId, reason, actor);
  await services.sessions.clear(actor.maxUserId, chatId);
  await services.messages.send(
    { chatId },
    {
      text: `↩️ ${incident.publicCode} возвращено на доработку.\n\n⚠️ Дедлайн НЕ изменён.`,
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

  const { answer } = await services.answers.submit(incidentId, actor, text, media);
  await services.sessions.clear(actor.maxUserId, chatId);
  await services.messages.send(
    { chatId },
    {
      text: `📝 ${incident.publicCode}: ответ (версия ${answer.version}) отправлен на согласование.`,
      label: codeLabel(incident),
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
  await services.sessions.clear(actor.maxUserId, chatId);
  await sendReport(services, chatId, range, actor.maxUserId);
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
  await services.sessions.clear(actor.maxUserId, chatId);
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
