import { IncidentStatus, ResponsibleGroupKind, SessionType } from '@prisma/client';

import type { AppServices } from '../../app/container';
import type { CallbackPayload } from '../../max/callback-payload';
import type { IncidentWithRelations } from '../../incidents/incident.repository';
import { AppError, ForbiddenError, NotFoundError } from '../../utils/errors';
import { incidentLogFields, moduleLogger } from '../../utils/logger';
import { assertApprover, assertDispatcher, assertResponder, requirePermission } from '../middleware/authorize';
import {
  assignmentBranchKeyboard,
  assignmentGroupKeyboard,
  type AssignmentBranch,
} from '../keyboards';
import { codeLabel } from '../views/cards';
import type { ResolvedActor } from '../handlers/helpers';
import { ensureFreeSession } from '../handlers/session-guard';

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

    case 'assign-branch':
      return openAssignmentBranch(services, actor, chatId, context.messageId, incident, payload.argument);

    case 'assign-page':
      return pageAssignmentBranch(services, actor, chatId, context.messageId, incident, payload.argument);

    case 'assign-group':
      return completeAssignment(services, actor, chatId, context.messageId, incident, payload.argument);

    case 'assign-category':
      return 'Этот список устарел. Нажмите «Распределить» в карточке обращения ещё раз.';

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
