import { expect, it } from 'vitest';

import { formatDeliveryProblems } from '../../src/bot/commands';
import { getConfig } from '../../src/config';

it('shows admin-visible delivery context but redacts actual secrets', () => {
  const config = getConfig();
  const text = formatDeliveryProblems(
    [
      {
        id: 'abcdef01-0000-4000-8000-000000000001',
        reference: 'abcdef01',
        direction: 'outbound',
        occurredAt: new Date('2026-09-02T13:00:00.000Z'),
        description: 'ответ заявителю',
        attempts: 12,
        targetType: 'user',
        targetId: 9001n,
        textPreview: 'Ответ для Ивана, телефон +7 900 000-00-00',
        error: `token=${config.BOT_TOKEN}; password=database-pass`,
      },
    ],
    config,
  );

  expect(text).toContain('Ошибка abcdef01');
  expect(text).toContain('пользователь 9001');
  expect(text).toContain('Ивана, телефон +7 900 000-00-00');
  expect(text).toContain('/delivery_retry abcdef01');
  expect(text).not.toContain(config.BOT_TOKEN);
  expect(text).not.toContain('database-pass');
  expect(text).toContain('[скрыто]');
});
