import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AppServices } from '../../app/container';
import type { Button } from '../../max/max-types';
import { hasPermission } from '../../users/roles';
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
  const audience = action === 'admin' ? 'admin' : dialog ? 'resident' : 'staff';
  const originalName = `iskra-${audience}-guide.pdf`;
  const body = await readFile(resolve(__dirname, '../../../output/pdf', originalName));
  const text = audience === 'admin'
    ? 'Инструкция администратора: настройка групп, права и служебные команды с примерами.'
    : audience === 'resident'
      ? 'Как подать обращение, уточнить детали и посмотреть ответ. Откройте PDF ниже.'
      : 'Подробная инструкция: распределение — стр. 2; профильный чат — стр. 3–4; согласование — стр. 5; отчёты — стр. 6; проблемы доставки — стр. 7. Общие команды — стр. 1.';
  await services.messages.send(dialog ? { userId: actor.maxUserId } : { chatId: chatId! }, {
    text, attachments: [{ type: 'FILE', body, originalName }],
  });
}
