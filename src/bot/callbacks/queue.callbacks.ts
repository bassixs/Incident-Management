import type { AppServices } from '../../app/container';
import type { CallbackPayload } from '../../max/callback-payload';
import type { ResolvedActor } from '../handlers/helpers';
import { ForbiddenError } from '../../utils/errors';

export async function handleQueueCallback(services: AppServices, actor: ResolvedActor, chatId: bigint | undefined,
  payload: Extract<CallbackPayload, { kind: 'queue' }>): Promise<string> {
  services.distributionQueue.authorize(actor, chatId);
  if (chatId === undefined) throw new ForbiddenError('Откройте чат распределения.');
  switch (payload.action) {
    case 'next':
    case 'open': {
      const incident = await services.distributionQueue.claim(actor, chatId, payload.action === 'open' ? payload.argument : undefined, true);
      await services.distributionQueue.refresh();
      return incident ? `${incident.publicCode}: закреплено за вами` : 'Свободных обращений нет. Ожидающие обращения могут быть у других операторов.';
    }
    case 'release':
      await services.distributionQueue.release(actor, chatId, payload.argument!);
      await services.distributionQueue.refresh();
      return 'Обращение снова доступно другим операторам';
    case 'list':
      await services.distributionQueue.list(actor, chatId, Number(payload.argument));
      return 'Список обновлён';
    case 'refresh':
      await services.distributionQueue.refresh();
      await services.messages.flush();
      return 'Обновление панели запрошено';
  }
}
