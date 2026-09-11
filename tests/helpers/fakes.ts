import type { CompositeMessage, MessageSendResult, SendTarget } from '../../src/max/max-message.service';
import type { Button } from '../../src/max/max-types';

export type RecordedSend = { target: SendTarget; message: CompositeMessage };
export type RecordedEdit = { messageId: string; text: string; mode: 'text' | 'finalize' | 'keyboard' };

/** Captures everything the code tried to send instead of calling MAX. */
export class FakeMessageService {
  async flush(): Promise<void> {}
  readonly sent: RecordedSend[] = [];
  readonly edits: RecordedEdit[] = [];
  readonly deleted: string[] = [];

  async send(target: SendTarget, message: CompositeMessage): Promise<MessageSendResult> {
    this.sent.push({ target, message });
    return { firstMessageId: `mid-${this.sent.length}`, state: 'sent', trackingApplied: false };
  }

  async editCardText(messageId: string, text: string): Promise<boolean> {
    this.edits.push({ messageId, text, mode: 'text' });
    return true;
  }

  async finalizeCard(messageId: string, text: string): Promise<boolean> {
    this.edits.push({ messageId, text, mode: 'finalize' });
    return true;
  }

  async finalizeStaffCard(messageId: string, text: string): Promise<boolean> {
    this.edits.push({ messageId, text, mode: 'keyboard' });
    return true;
  }

  async editCardKeyboard(messageId: string, text: string, _keyboard: Button[][]): Promise<boolean> {
    this.edits.push({ messageId, text, mode: 'keyboard' });
    return true;
  }

  async deleteCard(messageId: string): Promise<boolean> {
    this.deleted.push(messageId);
    return true;
  }

  toUser(userId: bigint): RecordedSend[] {
    return this.sent.filter((entry) => 'userId' in entry.target && entry.target.userId === userId);
  }

  toChat(chatId: bigint): RecordedSend[] {
    return this.sent.filter((entry) => 'chatId' in entry.target && entry.target.chatId === chatId);
  }
}

export class FakeMediaService {
  async discard(): Promise<void> {}
  async tryLoad(): Promise<Buffer | null> {
    return null;
  }

  async load(): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  async ingestAll(): Promise<[]> {
    return [];
  }
}

export class FakeHistoryService {
  readonly entries: Array<Record<string, unknown>> = [];

  async record(entry: Record<string, unknown>): Promise<void> {
    this.entries.push(entry);
  }

  actions(): string[] {
    return this.entries.map((entry) => String(entry.action));
  }
}
