import { beforeEach, describe, expect, it } from 'vitest';

import { RequesterDeliveryService } from '../../src/delivery/requester-delivery.service';
import { NotFoundError } from '../../src/utils/errors';
import { FakeHistoryService, FakeMediaService, FakeMessageService } from '../helpers/fakes';
import { TEST_USERS } from '../helpers/setup-env';

/**
 * §60 — the acceptance-critical property.
 *
 * Two people, two incidents, two different answers: each answer must reach the
 * requester of its own incident and nobody else, no matter who or what
 * triggered the delivery.
 */

type FakeAnswer = { id: string; version: number; text: string; deliveredAt: Date | null; attachments: [] };
type FakeIncident = {
  id: string;
  publicCode: string;
  requesterMaxUserId: bigint;
  requester: { maxUserId: bigint; displayName: string };
  answers: FakeAnswer[];
};

function incident(id: string, code: string, requesterMaxUserId: bigint, answers: FakeAnswer[]): FakeIncident {
  return {
    id,
    publicCode: code,
    requesterMaxUserId,
    requester: { maxUserId: requesterMaxUserId, displayName: `User ${requesterMaxUserId}` },
    answers,
  };
}

function answer(id: string, text: string): FakeAnswer {
  return { id, version: 1, text, deliveredAt: null, attachments: [] };
}

describe('RequesterDeliveryService', () => {
  let store: Map<string, FakeIncident>;
  let messages: FakeMessageService;
  let history: FakeHistoryService;
  let service: RequesterDeliveryService;

  beforeEach(() => {
    const answerA = answer('answer-a', 'Освещение восстановлено. Выполнена замена светильника.');
    const answerB = answer('answer-b', 'Доступ к системе восстановлен, пароль сброшен.');

    store = new Map([
      ['incident-a', incident('incident-a', 'INC-20260823-0001', TEST_USERS.requesterA, [answerA])],
      ['incident-b', incident('incident-b', 'INC-20260823-0002', TEST_USERS.requesterB, [answerB])],
    ]);

    const repository = {
      findById: async (id: string) => store.get(id) ?? null,
    };
    const prisma = {
      incidentAnswer: {
        update: async ({ where, data }: { where: { id: string }; data: { deliveredAt: Date } }) => {
          for (const item of store.values()) {
            const target = item.answers.find((candidate) => candidate.id === where.id);
            if (target) target.deliveredAt = data.deliveredAt;
          }
        },
      },
    };

    messages = new FakeMessageService();
    history = new FakeHistoryService();
    service = new RequesterDeliveryService(
      prisma as never,
      repository as never,
      history as never,
      messages as never,
      new FakeMediaService() as never,
    );
  });

  it('delivers each answer to its own requester and to nobody else', async () => {
    await service.deliverAnswer('incident-a', 'answer-a', 'Ответ по INC-20260823-0001: свет починили.');
    await service.deliverAnswer('incident-b', 'answer-b', 'Ответ по INC-20260823-0002: доступ восстановлен.');

    const toA = messages.toUser(TEST_USERS.requesterA);
    const toB = messages.toUser(TEST_USERS.requesterB);

    expect(toA).toHaveLength(1);
    expect(toB).toHaveLength(1);
    expect(toA[0]!.message.text).toContain('INC-20260823-0001');
    expect(toA[0]!.message.text).not.toContain('INC-20260823-0002');
    expect(toB[0]!.message.text).toContain('INC-20260823-0002');
    expect(toB[0]!.message.text).not.toContain('INC-20260823-0001');
    expect(messages.sent).toHaveLength(2);
  });

  it('labels every delivery with the incident number', async () => {
    await service.deliverAnswer('incident-a', 'answer-a', 'текст ответа');
    expect(messages.toUser(TEST_USERS.requesterA)[0]!.message.label).toBe('№ INC-20260823-0001');
  });

  it('offers a one-to-five rating on the delivered answer', async () => {
    await service.deliverAnswer('incident-a', 'answer-a', 'текст ответа');
    const keyboard = messages.toUser(TEST_USERS.requesterA)[0]!.message.keyboard!;
    expect(keyboard.flat().map((button) => button.text)).toEqual(['1', '2', '3', '4', '5']);
    expect(keyboard.flat().map((button) => 'payload' in button ? button.payload : undefined)).toEqual([
      'user:rate-answer:incident-a~1',
      'user:rate-answer:incident-a~2',
      'user:rate-answer:incident-a~3',
      'user:rate-answer:incident-a~4',
      'user:rate-answer:incident-a~5',
    ]);
  });

  it('refuses an answer that belongs to a different incident', async () => {
    await expect(service.deliverAnswer('incident-a', 'answer-b', 'подмена')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(messages.sent).toHaveLength(0);
  });

  it('is idempotent: a repeated delivery does not send a second message', async () => {
    expect(await service.deliverAnswer('incident-a', 'answer-a', 'текст')).toBe('sent');
    expect(await service.deliverAnswer('incident-a', 'answer-a', 'текст')).toBe('already-sent');
    expect(messages.toUser(TEST_USERS.requesterA)).toHaveLength(1);
    expect(history.actions().filter((action) => action === 'ANSWER_SENT')).toHaveLength(1);
  });

  it('routes plain notifications by incident as well', async () => {
    await service.notify('incident-b', 'Обращение отклонено.');
    expect(messages.toUser(TEST_USERS.requesterB)).toHaveLength(1);
    expect(messages.toUser(TEST_USERS.requesterA)).toHaveLength(0);
  });

  it('reports queued delivery without marking the answer delivered', async () => {
    messages.send = async () => ({ state: 'queued', trackingApplied: false });
    expect(await service.deliverAnswer('incident-a', 'answer-a', 'текст')).toBe('queued');
    expect(history.actions()).not.toContain('ANSWER_SENT');
    // A later attempt must still be allowed; it was not recorded as delivered.
    messages.send = async () => ({ state: 'sent', trackingApplied: false, firstMessageId: 'later' });
    expect(await service.deliverAnswer('incident-a', 'answer-a', 'текст')).toBe('sent');
  });

  it('fails loudly for an unknown incident instead of guessing a recipient', async () => {
    await expect(service.notify('nope', 'текст')).rejects.toBeInstanceOf(NotFoundError);
  });
});
