import { IncidentStatus, SessionType } from '@prisma/client';

import type { AppServices } from '../../app/container';
import type { CallbackPayload } from '../../max/callback-payload';
import type { IncidentWithRelations } from '../../incidents/incident.repository';
import { AppError, ForbiddenError, NotFoundError } from '../../utils/errors';
import { incidentLogFields, moduleLogger } from '../../utils/logger';
import { assertApprover, assertDispatcher, assertResponder, requirePermission } from '../middleware/authorize';
import { assignCategoryKeyboard } from '../keyboards';
import { codeLabel } from '../views/cards';
import type { ResolvedActor } from '../handlers/helpers';
import { ensureFreeSession } from '../handlers/session-guard';

const log = moduleLogger('bot-incident');

export type IncidentCallbackContext = {
  services: AppServices;
  actor: ResolvedActor;
  chatId: bigint | undefined;
};

/**
 * Staff buttons. Every branch follows the same shape:
 * load the incident from the DB → check role and chat → call a service.
 * Nothing is trusted from the callback payload beyond the incident id.
 */
export async function handleIncidentCallback(
  context: IncidentCallbackContext,
  payload: Extract<CallbackPayload, { kind: 'incident' }>,
): Promise<string | undefined> {
  const { services, actor, chatId } = context;

  const incident = await services.repository.findById(payload.incidentId);
  if (!incident) throw new NotFoundError('Обращение не найдено.');
  if (chatId === undefined) throw new ForbiddenError('Действие недоступно в этом чате.');

  log.debug(
    incidentLogFields({
      incidentId: incident.id,
      publicCode: incident.publicCode,
      maxUserId: actor.maxUserId,
      chatId,
      action: payload.action,
    }),
    'incident callback received',
  );

  switch (payload.action) {
    case 'assign':
      return startAssignment(services, actor, chatId, incident);

    case 'assign-category':
      return completeAssignment(services, actor, chatId, incident, payload.argument);

    case 'reject':
      return startRejection(services, actor, chatId, incident);

    case 'ban':
      return startBan(services, actor, chatId, incident);

    case 'take':
      return takeInWork(services, actor, chatId, incident);

    case 'answer':
    case 'fix':
      return startAnswer(services, actor, chatId, incident);

    case 'template':
      return startTemplateAnswer(services, actor, chatId, incident);

    case 'approve':
      return approve(services, actor, chatId, incident);

    case 'revision':
      return startRevision(services, actor, chatId, incident);

    case 'cancel': {
      await services.sessions.clear(actor.maxUserId, chatId);
      return 'Действие отменено';
    }

    default:
      return undefined;
  }
}

async function startAssignment(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  incident: IncidentWithRelations,
): Promise<string | undefined> {
  assertDispatcher(services, actor, chatId);
  if (incident.status !== IncidentStatus.DISTRIBUTION) {
    return `${incident.publicCode} уже обработано.`;
  }
  const { categories, hiddenCount } = await services.distribution.assignmentOptions();
  if (categories.length === 0) {
    return 'Ни для одной сферы не настроен рабочий чат.';
  }

  await services.messages.send(
    { chatId },
    {
      text: [
        `Куда направить ${incident.publicCode}?`,
        ...(hiddenCount > 0
          ? ['', `⚠️ Скрыто сфер без рабочего чата: ${hiddenCount}. Список — /categories.`]
          : []),
      ].join('\n'),
      keyboard: assignCategoryKeyboard(incident.id, categories),
    },
  );
  return undefined;
}

async function completeAssignment(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  incident: IncidentWithRelations,
  categoryId: string | undefined,
): Promise<string> {
  assertDispatcher(services, actor, chatId);
  if (!categoryId) throw new AppError('Сфера не указана.', 'BAD_PAYLOAD');
  const updated = await services.distribution.assign(incident.id, categoryId, actor);
  return `${updated.publicCode} → ${updated.assignedCategory?.name ?? ''}`;
}

async function startRejection(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  incident: IncidentWithRelations,
): Promise<string | undefined> {
  assertDispatcher(services, actor, chatId);
  if (incident.status !== IncidentStatus.DISTRIBUTION) {
    return `${incident.publicCode} уже обработано.`;
  }
  if (!(await ensureFreeSession(services, actor, chatId, incident.id))) return undefined;

  await services.sessions.start({
    maxUserId: actor.maxUserId,
    chatId,
    type: SessionType.WAITING_REJECTION_REASON,
    incidentId: incident.id,
  });
  await services.messages.send(
    { chatId },
    { text: `Укажите причину отклонения ${incident.publicCode} одним сообщением.` },
  );
  return undefined;
}

async function startBan(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  incident: IncidentWithRelations,
): Promise<string | undefined> {
  requirePermission(actor, 'user.ban');
  assertDispatcher(services, actor, chatId);
  if (!(await ensureFreeSession(services, actor, chatId, incident.id))) return undefined;

  await services.sessions.start({
    maxUserId: actor.maxUserId,
    chatId,
    type: SessionType.WAITING_BAN_REASON,
    incidentId: incident.id,
    data: { targetMaxUserId: incident.requesterMaxUserId.toString() },
  });
  await services.messages.send(
    { chatId },
    {
      text: [
        `Укажите причину блокировки автора ${incident.publicCode} одним сообщением.`,
        '',
        `Автор: ${incident.requesterName}`,
      ].join('\n'),
    },
  );
  return undefined;
}

async function takeInWork(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  incident: IncidentWithRelations,
): Promise<string> {
  assertResponder(actor, incident, chatId);
  const updated = await services.sector.takeInWork(incident.id, actor);
  return `${updated.publicCode}: в работе у ${actor.displayName}`;
}

async function startAnswer(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  incident: IncidentWithRelations,
  prefill?: string,
): Promise<string | undefined> {
  assertResponder(actor, incident, chatId);
  if (!(await ensureFreeSession(services, actor, chatId, incident.id))) return undefined;

  await services.sessions.start({
    maxUserId: actor.maxUserId,
    chatId,
    type: SessionType.WAITING_FOR_ANSWER,
    incidentId: incident.id,
    ...(prefill ? { data: { prefillText: prefill } } : {}),
  });

  await services.messages.send(
    { chatId },
    {
      text: [
        'Подготовьте ответ для:',
        '',
        incident.publicCode,
        '',
        'Следующим сообщением отправьте текст ответа.',
        '',
        'Можно приложить фотографию или файл.',
        'Видео запрещено.',
      ].join('\n'),
    },
  );
  return undefined;
}

async function startTemplateAnswer(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  incident: IncidentWithRelations,
): Promise<string | undefined> {
  assertResponder(actor, incident, chatId);
  const template = services.answers.templateFor(incident);
  if (!template) return 'Для этой сферы шаблон не задан.';

  const started = await startAnswer(services, actor, chatId, incident, template);
  await services.messages.send(
    { chatId },
    {
      text: ['📄 Шаблон ответа:', '', template].join('\n'),
      label: codeLabel(incident),
    },
  );
  return started;
}

async function approve(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  incident: IncidentWithRelations,
): Promise<string> {
  assertApprover(services, actor, chatId);
  const updated = await services.review.approve(incident.id, actor);
  return `${updated.publicCode}: ответ согласован и отправлен`;
}

async function startRevision(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  incident: IncidentWithRelations,
): Promise<string | undefined> {
  assertApprover(services, actor, chatId);
  if (incident.status !== IncidentStatus.WAITING_REVIEW) {
    return `${incident.publicCode} сейчас не на согласовании.`;
  }
  if (!(await ensureFreeSession(services, actor, chatId, incident.id))) return undefined;

  await services.sessions.start({
    maxUserId: actor.maxUserId,
    chatId,
    type: SessionType.WAITING_REVISION_REASON,
    incidentId: incident.id,
  });
  await services.messages.send(
    { chatId },
    { text: `Укажите причину возврата ответа ${incident.publicCode}.` },
  );
  return undefined;
}
