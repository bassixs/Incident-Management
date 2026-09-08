import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AppServices } from '../../app/container';
import type { Button } from '../../max/max-types';
import { hasPermission } from '../../users/roles';
import { ForbiddenError } from '../../utils/errors';
import { workingChatFor } from '../../users/working-chat';
import type { ResolvedActor } from '../handlers/helpers';
import { assertWorkingChat, requirePermission } from '../middleware/authorize';
import { chatInfoText } from './chat-info';

export async function sendChatInfo(services: AppServices, actor: ResolvedActor, chatId: bigint, dialog: boolean): Promise<void> {
  const working = !dialog && (actor.workingChat ?? await workingChatFor(services, chatId));
  const keyboard: Button[][] = [];
  if (dialog || working) keyboard.push([{ type: 'callback', text: '📖 Подробная инструкция (PDF)', payload: 'help:guide' }]);
  if ((dialog || working) && hasPermission(actor.roles, 'admin.manage')) keyboard.push([{ type: 'callback', text: '⚙️ Инструкция администратора (PDF)', payload: 'help:admin' }]);
  await services.messages.send(dialog ? { userId: actor.maxUserId } : { chatId }, {
    text: await chatInfoText(services, actor, chatId, dialog),
    ...(keyboard.length ? { keyboard } : {}),
  });
}

/** Select a fixed asset from the current chat; never accept a path from a callback. */
export async function sendChatGuide(services: AppServices, actor: ResolvedActor, chatId: bigint | undefined, dialog: boolean, action: 'guide' | 'admin'): Promise<void> {
  if (action === 'admin') requirePermission(actor, 'admin.manage');
  if (!dialog) await assertWorkingChat(services, chatId, false);
  const guides: Array<{ name: string; title: string }> = [];
  if (action === 'admin') guides.push({ name: 'admin', title: 'Администратор: настройки и служебные команды' });
  else if (dialog) guides.push({ name: 'resident', title: 'Житель: подача обращения и получение ответа' });
  else {
    // Reload configuration: even an old button must select the current chat's guide.
    const chat = await workingChatFor(services, chatId!);
    if (!chat) throw new ForbiddenError('Этот чат больше не настроен как рабочий.');
    if (chat.distribution) guides.push({ name: 'distribution', title: 'Распределение обращений' });
    if (chat.groups.some(group => !group.bypassReview)) guides.push({ name: 'profile', title: 'Профильный чат: подготовка ответа' });
    if (chat.groups.some(group => group.bypassReview)) guides.push({ name: 'profile-direct', title: 'Профильный чат: ответы без согласования' });
    if (chat.review) guides.push({ name: 'review', title: 'Согласование ответов' });
    if (chat.delivery) guides.push({ name: 'analytics', title: 'Аналитика: отчёты и проблемы доставки' });
  }
  const attachments = await Promise.all(guides.map(async guide => {
    const originalName = `iskra-${guide.name}-guide.pdf`;
    const body = await readFile(resolve(__dirname, '../../../output/pdf', originalName));
    return { type: 'FILE' as const, body, originalName };
  }));
  await services.messages.send(dialog ? { userId: actor.maxUserId } : { chatId: chatId! }, {
    text: `${guides.map(guide => guide.title).join('\n')}\n\nВ файле — действия для этого чата и примеры команд.`, attachments,
  });
}
