import type { AppServices } from '../app/container';
import type { SessionData } from '../sessions/operator-session.service';
import { PHONE_INPUT_PROMPT } from '../privacy/optional-contact';

export async function sendPhoneInputPrompt(services: AppServices, maxUserId: bigint, data: SessionData, text = PHONE_INPUT_PROMPT): Promise<void> {
  await services.messages.send({ userId: maxUserId }, {
    text,
    keyboard: [[{ type: 'callback', text: data.requesterPhone ? 'Вернуться без изменения номера' : 'Продолжить без номера', payload: `user:draft-phone-back:${data.previewToken}` }],
      [{ type: 'callback', text: 'Отмена', payload: `user:draft-cancel:${data.previewToken}` }]],
    immediatePreview: true,
  });
}
