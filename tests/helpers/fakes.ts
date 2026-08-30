import type { CompositeMessage, SendTarget } from '../../src/max/max-message.service';

export type RecordedSend = { target: SendTarget; message: CompositeMessage };
export type RecordedEdit = { messageId: string; text: string; mode: 'text' | 'finalize' };

/** Captures everything the code tried to send instead of calling MAX. */
export class FakeMessageService {
  readonly sent: RecordedSend[] = [];
  readonly edits: RecordedEdit[] = [];

  async send(target: SendTarget, message: CompositeMessage): Promise<{ firstMessageId?: string }> {
    this.sent.push({ target, message });
    return { firstMessageId: `mid-${this.sent.length}` };
  }

  async editCardText(messageId: string, text: string): Promise<boolean> {
    this.edits.push({ messageId, text, mode: 'text' });
    return true;
  }

  async finalizeCard(messageId: string, text: string): Promise<boolean> {
    this.edits.push({ messageId, text, mode: 'finalize' });
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
