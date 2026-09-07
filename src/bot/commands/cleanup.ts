import type { CommandContext } from './index';
import { CLEANUP_PERIODS, parseCleanupRange } from '../../maintenance/cleanup-range';
import { cleanupPreviewText, type CleanupKind } from '../../maintenance/cleanup.service';
import { ValidationError } from '../../utils/errors';

const labels = ['Сегодня', '7 дней', '30 дней', '90 дней', 'Всё время'];
export async function cleanupCommand(context: CommandContext, kind: CleanupKind): Promise<void> {
  const { services, actor, chatId, isDialog, args } = context;
  await services.cleanup.authorize(actor, chatId, isDialog);
  if (args[0] === 'cancel') {
    if (args.length !== 1) throw new ValidationError('Для отмены отправьте команду с одним словом cancel.');
    await services.cleanup.cancel(actor, chatId);
    await services.messages.send({ chatId }, { text: 'Предварительная очистка отменена. Данные не удалены.' });
    return;
  }
  if (args[0] === 'confirm') {
    if (args.length !== 2 || !/^[0-9a-f]{16}$/.test(args[1]!)) throw new ValidationError('Скопируйте команду подтверждения из свежего предварительного подсчёта целиком.');
    await services.cleanup.confirm(kind, args[1]!, actor, chatId);
    await services.messages.send({ chatId }, { text: 'Подтверждение принято. Бот дождётся завершения текущих действий, проверит подсчёт и сообщит результат очистки здесь.' });
    return;
  }
  if (kind === 'data' && !args.length) {
    await services.messages.send({ chatId }, {
      text: 'Удаление обращений: выберите период по дате их создания. Следующий шаг — только подсчёт, без удаления.\n\nСохранённые данные жителей сбрасываются отдельно: /clear_users.',
      keyboard: [...CLEANUP_PERIODS.map((period, index) => [{ type: 'callback' as const, text: labels[index]!, payload: `cleanup:${period}` }]),
        [{ type: 'callback', text: 'Указать даты', payload: 'cleanup:custom' }]],
    });
    return;
  }
  if (kind === 'users' && args.length) throw new ValidationError('Для подсчёта всех сохранённых жителей отправьте /clear_users без дополнительных слов.');
  const plan = await services.cleanup.preview(kind, actor, chatId, kind === 'data' ? parseCleanupRange(args.join(' ')) : undefined);
  await services.messages.send({ chatId }, { text: cleanupPreviewText(plan) });
}
