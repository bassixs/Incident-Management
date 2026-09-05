import { describe, expect, it, vi } from 'vitest';

import type { AttachmentRequest } from '../../src/max/max-types';
import {
  MaxMessageService,
  groupAttachments,
  splitText,
  type OutboundAttachment,
} from '../../src/max/max-message.service';
import { renderTemplate, truncate, unicodeLength } from '../../src/utils/text';

function attachment(type: 'IMAGE' | 'FILE', name: string): OutboundAttachment {
  return { type, body: Buffer.from(name), originalName: name };
}

type SentMessage = { text: string; attachments?: AttachmentRequest[] };

/** Records what would have gone to MAX. */
function fakeMax() {
  const sent: SentMessage[] = [];
  const edits: Array<{ text: string; attachments?: AttachmentRequest[] }> = [];
  const deleted: string[] = [];
  let counter = 0;
  const client = {
    async uploadImage(): Promise<AttachmentRequest> {
      counter += 1;
      return { type: 'image', payload: { token: `img-${counter}` } };
    },
    async uploadFile(): Promise<AttachmentRequest> {
      counter += 1;
      return { type: 'file', payload: { token: `file-${counter}` } };
    },
    async sendToChat(_chatId: bigint, text: string, extra?: { attachments?: AttachmentRequest[] }) {
      sent.push({ text, attachments: extra?.attachments });
      return { body: { mid: `mid-${sent.length}` } };
    },
    async sendToUser(_userId: bigint, text: string, extra?: { attachments?: AttachmentRequest[] }) {
      sent.push({ text, attachments: extra?.attachments });
      return { body: { mid: `mid-${sent.length}` } };
    },
    async editMessage(_mid: string, text: string, attachments?: AttachmentRequest[]) {
      edits.push({ text, attachments });
    },
    async deleteMessage(mid: string) {
      deleted.push(mid);
    },
  };
  return { client, sent, edits, deleted };
}

const KEYBOARD = [[{ type: 'callback' as const, text: 'Кнопка', payload: 'noop' }]];

/**
 * Verified against the live MAX API: one message may carry text, an image and
 * an inline keyboard together, and an edit that omits `attachments` leaves
 * both the image and the keyboard in place.
 */
describe('composing one message', () => {
  it('puts text, photo and buttons into a single message', async () => {
    const { client, sent } = fakeMax();
    const service = new MaxMessageService(client as never);

    await service.send(
      { chatId: -1n },
      { text: 'Ответ готов', keyboard: KEYBOARD, attachments: [attachment('IMAGE', 'a.jpg')] },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe('Ответ готов');
    expect(sent[0]!.attachments?.map((item) => item.type)).toEqual(['image', 'inline_keyboard']);
  });

  it('keeps several photos in the same message as the text', async () => {
    const { client, sent } = fakeMax();
    const service = new MaxMessageService(client as never);

    await service.send(
      { userId: 7n },
      { text: 'Три фото', attachments: [1, 2, 3].map((n) => attachment('IMAGE', `${n}.jpg`)) },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.attachments?.map((item) => item.type)).toEqual(['image', 'image', 'image']);
  });

  it('sends a second message only for attachments of another kind', async () => {
    const { client, sent } = fakeMax();
    const service = new MaxMessageService(client as never);

    await service.send(
      { chatId: -1n },
      {
        text: 'Ответ с файлом',
        label: '№ INC-20260823-0001',
        attachments: [attachment('IMAGE', 'a.jpg'), attachment('FILE', 'report.xlsx')],
      },
    );

    expect(sent).toHaveLength(2);
    expect(sent[0]!.attachments?.map((item) => item.type)).toEqual(['image']);
    expect(sent[1]!.attachments?.map((item) => item.type)).toEqual(['file']);
    // The trailing part repeats the incident number so it stays traceable.
    expect(sent[1]!.text).toBe('№ INC-20260823-0001');
  });

  it('sends a plain message when there is nothing to attach', async () => {
    const { client, sent } = fakeMax();
    const service = new MaxMessageService(client as never);

    await service.send({ chatId: -1n }, { text: 'Просто текст' });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.attachments).toBeUndefined();
  });
});

describe('editing a published card', () => {
  it('omits attachments when only the text changes, preserving photo and buttons', async () => {
    const { client, edits } = fakeMax();
    const service = new MaxMessageService(client as never);

    await service.editCardText('mid-1', 'обновлённый текст');

    expect(edits).toHaveLength(1);
    expect(edits[0]!.attachments).toBeUndefined();
  });

  it('clears the attachment list when a card is finalised', async () => {
    const { client, edits } = fakeMax();
    const service = new MaxMessageService(client as never);

    await service.finalizeCard('mid-1', 'обращение распределено');

    expect(edits).toHaveLength(1);
    expect(edits[0]!.attachments).toEqual([]);
  });

  it('deletes a temporary picker instead of leaving a duplicate card', async () => {
    const { client, deleted } = fakeMax();
    const service = new MaxMessageService(client as never);

    await service.deleteCard('picker-mid');

    expect(deleted).toEqual(['picker-mid']);
  });
});

describe('message splitting', () => {
  it('leaves a short message untouched', () => {
    expect(splitText('короткий текст', '№ INC-1')).toEqual(['короткий текст']);
  });

  it('splits an oversized message and repeats the label on every follow-up', () => {
    const parts = splitText('я'.repeat(9000), '№ INC-20260823-0001');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.startsWith('№')).toBe(false);
    for (const part of parts.slice(1)) {
      expect(part.startsWith('№ INC-20260823-0001')).toBe(true);
    }
    for (const part of parts) {
      expect(unicodeLength(part)).toBeLessThanOrEqual(3800);
    }
  });

  it('loses no characters while splitting', () => {
    const source = 'ю'.repeat(9000);
    const parts = splitText(source, '№ INC-1');
    const rejoined = parts.map((part, index) => (index === 0 ? part : part.replace('№ INC-1\n\n', ''))).join('');
    expect(rejoined).toBe(source);
  });
});

describe('attachment grouping', () => {
  it('never mixes images and files in one MAX message', () => {
    const groups = groupAttachments([
      attachment('IMAGE', 'a.jpg'),
      attachment('FILE', 'report.xlsx'),
      attachment('IMAGE', 'b.jpg'),
    ]);
    for (const group of groups) {
      expect(new Set(group.map((item) => item.type)).size).toBe(1);
    }
    expect(groups.flat()).toHaveLength(3);
  });

  it('chunks large batches of one kind', () => {
    const groups = groupAttachments(
      Array.from({ length: 9 }, (_, index) => attachment('IMAGE', `${index}.jpg`)),
    );
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.length)).toEqual([4, 4, 1]);
  });

  it('returns nothing for an empty list', () => {
    expect(groupAttachments([])).toEqual([]);
  });
});

describe('answer templates', () => {
  it('fills known placeholders and leaves the rest for the operator', () => {
    const rendered = renderTemplate(
      'Обращение № {{incidentCode}}\nРезультат:\n{{result}}\nДетали: {{ details }}',
      { incidentCode: 'INC-20260823-0001' },
    );
    expect(rendered).toContain('INC-20260823-0001');
    expect(rendered).toContain('{{result}}');
    expect(rendered).toContain('{{ details }}');
  });
});

describe('truncate', () => {
  it('keeps short strings and trims long ones with an ellipsis', () => {
    expect(truncate('короткий', 20)).toBe('короткий');
    expect(unicodeLength(truncate('я'.repeat(50), 10))).toBe(10);
  });
});

it('links only the first part of a long reply to the original card', async () => {
  const sendToChat = vi.fn().mockResolvedValue({ body: { mid: 'reply' } });
  const service = new MaxMessageService({ sendToChat } as never);
  await service.send({ chatId: -1n }, { text: 'a'.repeat(4000), replyToMessageId: 'original' });
  expect(sendToChat).toHaveBeenCalledTimes(2);
  expect(sendToChat.mock.calls[0]?.[2]).toEqual({ link: { type: 'reply', mid: 'original' } });
  expect(sendToChat.mock.calls[1]?.[2]).toEqual({});
});
