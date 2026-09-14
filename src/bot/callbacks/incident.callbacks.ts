import { SECTOR_LEASE_ACTION } from '../../work-queues/leases';
import { IncidentStatus, ResponsibleGroupKind, SessionType } from '@prisma/client';

import type { AppServices } from '../../app/container';
import { isUuid, type CallbackPayload } from '../../max/callback-payload';
import type { IncidentWithRelations } from '../../incidents/incident.repository';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors';
import { incidentLogFields, moduleLogger } from '../../utils/logger';
import { assertApprover, assertDispatcher, assertResponder, requirePermission } from '../middleware/authorize';
import {
  assignmentBranchKeyboard,
  assignmentGroupKeyboard,
  distributionTopicKeyboard,
  type AssignmentBranch,
} from '../keyboards';
import { codeLabel } from '../views/cards';
import type { ResolvedActor } from '../handlers/helpers';
import { ensureFreeSession } from '../handlers/session-guard';
import { startRejectionFlow, handleRejectionAction } from './rejection-flow';
import { startReviewEdit, handleReviewEditAction } from './review-edit-flow';
import { invitePersonalWork, withPersonalWorkLock } from '../../work-queues/private-workspace';

const log = moduleLogger('bot-incident');

export type IncidentCallbackContext = {
  services: AppServices;
  actor: ResolvedActor;
  chatId: bigint | undefined;
  messageId?: string;
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

  if (incident.status === 'DISTRIBUTION' && ['assign', 'assign-branch', 'assign-page', 'assign-group', 'reject', 'topic', 'topic-page', 'topic-set'].includes(payload.action)) {
    await services.distributionQueue.claim(actor, chatId, incident.id);
  }

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
    case 'personal':
      return withPersonalWorkLock(services, actor.maxUserId, () => invitePersonalWork(services, actor, chatId, incident.id));
    case 'review-take': {
      await reviewAnswerId(context, incident, payload.argument);
      await services.workQueues.claimReview(actor, chatId, incident.id);
      return `${incident.publicCode}: закреплено за ${actor.displayName} на 15 минут`;
    }
    case 'redistribute': {
      assertResponder(actor, incident, chatId);
      if (incident.assignedGroup?.maxChatId !== chatId || !['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(incident.status)) throw new ConflictError('Возврат доступен только в текущем профильном чате до отправки ответа.');
      if (!(await ensureFreeSession(services, actor, chatId, incident.id))) return;
      const own = await services.prisma.actionLock.findFirst({ where: { incidentId: incident.id, action: SECTOR_LEASE_ACTION, maxUserId: actor.maxUserId, lockedUntil: { gt: new Date() } } });
      if (!own) await services.sector.takeInWork(incident.id, actor);
      await services.sessions.start({ maxUserId: actor.maxUserId, chatId, type: SessionType.WAITING_REVISION_REASON, incidentId: incident.id,
        data: { redistribution: true, assignedGroupId: incident.assignedGroupId, assignmentCycle: incident.history?.[0]?.id ?? 'initial', leaseUntil: (await services.prisma.actionLock.findUniqueOrThrow({ where: { key: `sector-queue:${incident.id}` } })).lockedUntil.toISOString() } });
      await services.messages.send({ chatId }, { text: `${incident.publicCode}: укажите причину возврата на перераспределение одним сообщением (до 1000 символов).`,
        keyboard: [[{ type: 'callback', text: 'Отмена', payload: `incident:cancel:${incident.id}` }]] });
      return;
    }

    case 'topic':
    case 'topic-page': {
      assertDispatcher(services, actor, chatId);
      if (incident.status !== 'DISTRIBUTION') throw new ConflictError('Тему можно изменить только до распределения обращения.');
      const page = payload.action === 'topic' ? 0 : Number(payload.argument);
      if (!Number.isSafeInteger(page) || page < 0 || page > 100_000) throw new AppError('Некорректная страница.', 'BAD_PAYLOAD');
      const text = `${incident.publicCode}\nТекущая тема: ${incident.userSelectedCategory?.name ?? 'Иное'}\n\nВыберите правильную тему обращения:`;
      const keyboard = distributionTopicKeyboard(incident.id, await services.categories.listActive(), page);
      if (payload.action === 'topic-page' && context.messageId) await services.messages.editCardKeyboard(context.messageId, text, keyboard);
      else await services.messages.send({ chatId }, { text, keyboard });
      return undefined;
    }
    case 'topic-set': {
      assertDispatcher(services, actor, chatId);
      if (payload.argument !== 'none' && (!payload.argument || !isUuid(payload.argument))) throw new AppError('Тема не указана.', 'BAD_PAYLOAD');
      const updated = await services.distribution.changeTopic(incident.id, payload.argument === 'none' ? null : payload.argument, actor);
      const notice = `${updated.publicCode}: тема обращения — ${updated.userSelectedCategory?.name ?? 'Иное'}.`;
      if (context.messageId && context.messageId !== incident.distributionMessageId) await services.messages.finalizeCard(context.messageId, notice);
      return notice;
    }
    case 'repair-photo': {
      if (!payload.argument || !isUuid(payload.argument)) throw new ConflictError('Кнопка устарела.');
      await services.answers.reopenForPhotoReplacement(incident.id, payload.argument, actor, chatId);
      if (context.messageId) await services.messages.finalizeCard(context.messageId, `${incident.publicCode}: ответ возвращён на доработку. Прикрепите фотографии заново.`);
      return 'Ответ возвращён на доработку';
    }
    case 'clarify':
    case 'clarify-send':
    case 'clarify-cancel':
      return 'Запросы уточнений у жителей больше не используются. Продолжите работу с карточкой обращения.';
    case 'assign':
      return startAssignment(services, actor, chatId, incident);

    case 'assign-branch':
      return openAssignmentBranch(services, actor, chatId, context.messageId, incident, payload.argument);

    case 'assign-page':
      return pageAssignmentBranch(services, actor, chatId, context.messageId, incident, payload.argument);

    case 'assign-group':
      return completeAssignment(services, actor, chatId, context.messageId, incident, payload.argument);

    case 'assign-category':
      return 'Этот список устарел. Нажмите «Распределить» в карточке обращения ещё раз.';

    case 'reject':
      return startRejectionFlow(services, actor, chatId, incident);
    case 'reject-reason':
    case 'reject-edit':
    case 'reject-confirm':
    case 'reject-cancel':
      return handleRejectionAction(services, actor, chatId, incident, payload.action, payload.argument, context.messageId);

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
      return approve(services, actor, chatId, incident, await reviewAnswerId(context, incident, payload.argument));

    case 'review-edit':
      return startReviewEdit(services, actor, chatId, incident, await reviewAnswerId(context, incident, payload.argument));
    case 'review-edit-save':
    case 'review-edit-back':
    case 'review-edit-cancel':
      return handleReviewEditAction(services, actor, chatId, incident, payload.action, payload.argument, context.messageId);

    case 'revision': {
      const current = await services.sessions.find(actor.maxUserId, chatId);
      if ((current?.data as { reviewEdit?: boolean } | null)?.reviewEdit) throw new ConflictError('Сначала сохраните или отмените правку ответа.');
      return startRevision(services, actor, chatId, incident, await reviewAnswerId(context, incident, payload.argument));
    }

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
  const [{ groups: regionalGroups, hiddenCount }, recommendedGroup] = await Promise.all([
    services.distribution.assignmentOptions(ResponsibleGroupKind.REGIONAL),
    services.distribution.recommendedGroup(incident.problemMunicipalityCode),
  ]);
  const regionalGroup = regionalGroups[0] ?? null;

  await services.messages.send(
    { chatId },
    {
      text: [
        '🔴 НЕ РАСПРЕДЕЛЕНО',
        '',
        `Куда направить ${incident.publicCode}?`,
        ...(recommendedGroup ? ['', `⭐ Рекомендация по территории: ${recommendedGroup.name}.`] : []),
        ...(hiddenCount > 0 ? ['', `⚠️ Региональная группа временно недоступна: ${hiddenCount}.`] : []),
      ].join('\n'),
      keyboard: assignmentBranchKeyboard(incident.id, regionalGroup, recommendedGroup),
    },
  );
  return undefined;
}

async function openAssignmentBranch(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  messageId: string | undefined,
  incident: IncidentWithRelations,
  rawBranch: string | undefined,
): Promise<string | undefined> {
  assertDispatcher(services, actor, chatId);
  if (incident.status !== IncidentStatus.DISTRIBUTION) return `${incident.publicCode} уже обработано.`;
  const branch = requireAssignmentBranch(rawBranch);
  return sendAssignmentPage(services, incident, branch, 0, messageId);
}

async function pageAssignmentBranch(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  messageId: string | undefined,
  incident: IncidentWithRelations,
  raw: string | undefined,
): Promise<string | undefined> {
  assertDispatcher(services, actor, chatId);
  if (incident.status !== IncidentStatus.DISTRIBUTION) return `${incident.publicCode} уже обработано.`;
  const [branchToken, pageToken] = raw?.split('~') ?? [];
  const branch = requireAssignmentBranch(branchToken);
  const page = Number.parseInt(pageToken ?? '0', 10);
  return sendAssignmentPage(services, incident, branch, Number.isFinite(page) ? page : 0, messageId);
}

async function sendAssignmentPage(
  services: AppServices,
  incident: IncidentWithRelations,
  branch: AssignmentBranch,
  page: number,
  messageId?: string,
): Promise<string | undefined> {
  const kind =
    branch === 'local' ? ResponsibleGroupKind.LOCAL_GOVERNMENT : ResponsibleGroupKind.EXECUTIVE_AUTHORITY;
  const [{ groups, hiddenCount }, recommendation] = await Promise.all([
    services.distribution.assignmentOptions(kind),
    branch === 'local'
      ? services.distribution.recommendedGroup(incident.problemMunicipalityCode)
      : Promise.resolve(null),
  ]);
  if (groups.length === 0) return 'В этом разделе пока нет доступных профильных чатов.';
  const recommendedGroup = recommendation?.kind === kind ? recommendation : null;
  const title = branch === 'local' ? 'Органы местного самоуправления' : 'Органы исполнительной власти';
  const text = [
    '🔴 НЕ РАСПРЕДЕЛЕНО',
    '',
    `${title}: куда направить ${incident.publicCode}?`,
    ...(recommendedGroup ? ['', `⭐ Рекомендация: ${recommendedGroup.name}.`] : []),
    ...(hiddenCount > 0 ? ['', `⚠️ Скрыто групп без рабочего чата: ${hiddenCount}.`] : []),
  ].join('\n');
  const keyboard = assignmentGroupKeyboard(incident.id, branch, groups, page, recommendedGroup);
  if (messageId) {
    await services.messages.editCardKeyboard(messageId, text, keyboard);
  } else {
    await services.messages.send({ chatId: services.distribution.chatId() }, { text, keyboard });
  }
  return undefined;
}

function requireAssignmentBranch(raw: string | undefined): AssignmentBranch {
  if (raw === 'local' || raw === 'executive') return raw;
  throw new AppError('Раздел распределения не указан.', 'BAD_PAYLOAD');
}

async function completeAssignment(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  messageId: string | undefined,
  incident: IncidentWithRelations,
  groupId: string | undefined,
): Promise<string> {
  assertDispatcher(services, actor, chatId);
  if (!groupId) throw new AppError('Ответственная группа не указана.', 'BAD_PAYLOAD');
  const updated = await services.distribution.assign(incident.id, groupId, actor);

  // The picker is a separate MAX message from the original incident card.
  // Remove it: the original card already shows the final distribution state.
  if (messageId && messageId !== incident.distributionMessageId && updated.assignedGroup) {
    await services.messages.deleteCard(messageId);
  }
  return `${updated.publicCode} → ${updated.assignedGroup?.name ?? ''}`;
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
  if (incident.activeClarificationId) throw new ConflictError('Сначала дождитесь уточнения от жителя.');
  if (!['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(incident.status)) {
    throw new ConflictError(incident.status === 'RESOLVED'
      ? `${incident.publicCode}: ответ уже утверждён. Повторная подготовка не требуется.`
      : `${incident.publicCode}: подготовка ответа на текущем этапе недоступна. Проверьте статус через /today.`);
  }
  if (!(await ensureFreeSession(services, actor, chatId, incident.id))) return undefined;

  const own = await services.prisma.actionLock.findFirst({ where: { incidentId: incident.id, action: SECTOR_LEASE_ACTION, maxUserId: actor.maxUserId, lockedUntil: { gt: new Date() } } });
  if (!own) await services.sector.takeInWork(incident.id, actor);
  await services.sessions.start({
    maxUserId: actor.maxUserId,
    chatId,
    type: SessionType.WAITING_FOR_ANSWER,
    incidentId: incident.id,
    data: { ...(prefill ? { prefillText: prefill } : {}), assignmentCycle: incident.history?.[0]?.id ?? 'initial', leaseUntil: (await services.prisma.actionLock.findUniqueOrThrow({ where: { key: `sector-queue:${incident.id}` } })).lockedUntil.toISOString() },
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
  answerId: string,
): Promise<string> {
  assertApprover(services, actor, chatId);
  const updated = await services.review.approve(incident.id, actor, answerId);
  return updated.answers.some(a => a.deliveredAt)
    ? `${updated.publicCode}: ответ согласован и доставлен`
    : `${updated.publicCode}: ответ согласован, ожидает доставки`;
}

async function startRevision(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  incident: IncidentWithRelations,
  answerId: string,
): Promise<string | undefined> {
  assertApprover(services, actor, chatId);
  if (incident.status !== IncidentStatus.WAITING_REVIEW) {
    return `${incident.publicCode} сейчас не на согласовании.`;
  }
  await services.workQueues.claimReview(actor, chatId, incident.id);
  if (!(await ensureFreeSession(services, actor, chatId, incident.id))) return undefined;

  await services.sessions.start({
    maxUserId: actor.maxUserId,
    chatId,
    type: SessionType.WAITING_REVISION_REASON,
    data: { reviewAnswerId: answerId, leaseUntil: (await services.prisma.actionLock.findUniqueOrThrow({ where: { key: `review-queue:${incident.id}` } })).lockedUntil.toISOString() },
    incidentId: incident.id,
  });
  await services.messages.send(
    { chatId },
    { text: `Укажите причину возврата ответа ${incident.publicCode}.` },
  );
  return undefined;
}

/** Old cards are accepted only when durable delivery identifies their version. */
async function reviewAnswerId(context: IncidentCallbackContext, incident: IncidentWithRelations, argument?: string): Promise<string> {
  assertApprover(context.services, context.actor, context.chatId);
  const latest = incident.answers.at(-1);
  if (!latest) throw new ConflictError('Нет ответа для согласования.');
  if (argument === latest.id) return latest.id;
  if (!argument && context.messageId) {
    const delivery = await context.services.prisma.outboundMessage.findFirst({
      where: { incidentId: incident.id, answerId: latest.id, trackingType: 'REVIEW_CARD',
        firstMessageId: context.messageId, status: 'SENT' }, select: { id: true },
    });
    if (delivery) return latest.id;
  }
  throw new ConflictError('Эта карточка устарела. Откройте последнюю карточку согласования.');
}
