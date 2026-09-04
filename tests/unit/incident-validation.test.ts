import { describe, expect, it } from 'vitest';

import {
  IncidentService,
  REJECTION_MESSAGES,
  normaliseRequesterName,
  normaliseRequesterPhone,
} from '../../src/incidents/incident.service';
import type { IncomingMedia } from '../../src/media/media.service';
import { ValidationError } from '../../src/utils/errors';
import { unicodeLength } from '../../src/utils/text';

/** validateSubmission touches no collaborators, so nulls are safe here. */
const service = new IncidentService(
  null as never,
  null as never,
  null as never,
  null as never,
  null as never,
  null as never,
);

const image: IncomingMedia = { kind: 'IMAGE', url: 'https://example.test/a.jpg' };
const video: IncomingMedia = { kind: 'VIDEO', url: 'https://example.test/a.mp4' };
const audio: IncomingMedia = { kind: 'AUDIO', url: 'https://example.test/a.mp3' };

describe('incident submission validation', () => {
  it('accepts an ordinary request', () => {
    expect(service.validateSubmission('Не работает освещение возле входа.').text).toBe(
      'Не работает освещение возле входа.',
    );
  });

  it('accepts exactly 150 characters', () => {
    const text = 'а'.repeat(150);
    expect(unicodeLength(text)).toBe(150);
    expect(service.validateSubmission(text).text).toHaveLength(150);
  });

  it('rejects 151 characters and says so', () => {
    const text = 'а'.repeat(151);
    expect(() => service.validateSubmission(text)).toThrow(ValidationError);
    try {
      service.validateSubmission(text);
    } catch (error) {
      expect((error as ValidationError).message).toContain('Сообщение слишком длинное');
      expect((error as ValidationError).details?.reason).toBe('too_long');
    }
  });

  it('counts emoji as single characters', () => {
    // 150 astral-plane code points are 300 UTF-16 units — the limit is on
    // characters as a person counts them.
    const text = '🙂'.repeat(150);
    expect(text.length).toBe(300);
    expect(() => service.validateSubmission(text)).not.toThrow();
    expect(() => service.validateSubmission('🙂'.repeat(151))).toThrow(ValidationError);
  });

  it('accepts text with a photo', () => {
    expect(service.validateSubmission('Освещение не работает', [image]).text).toBe('Освещение не работает');
  });

  it('rejects video with the documented wording', () => {
    try {
      service.validateSubmission('Освещение не работает', [video]);
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as ValidationError).message).toBe(REJECTION_MESSAGES.video);
      expect((error as ValidationError).details?.reason).toBe('video');
    }
  });

  it('rejects audio-only submissions', () => {
    expect(() => service.validateSubmission('', [audio])).toThrow(ValidationError);
    expect(() => service.validateSubmission('текст', [audio])).toThrow(ValidationError);
  });

  it('requires text even when a photo is attached', () => {
    expect(() => service.validateSubmission('   ', [image])).toThrow(ValidationError);
  });
});

describe('mandatory requester contacts', () => {
  it('requires a surname and name', () => {
    expect(normaliseRequesterName('  Иванов   Иван Иванович  ')).toBe('Иванов Иван Иванович');
    expect(() => normaliseRequesterName('')).toThrow(ValidationError);
    expect(() => normaliseRequesterName('Иван')).toThrow(ValidationError);
    expect(() => normaliseRequesterName('Иванов 123')).toThrow(ValidationError);
  });

  it('normalises common Russian phone formats', () => {
    expect(normaliseRequesterPhone('+7 (900) 123-45-67')).toBe('+7 900 123-45-67');
    expect(normaliseRequesterPhone('8 900 123 45 67')).toBe('+7 900 123-45-67');
    expect(normaliseRequesterPhone('9001234567')).toBe('+7 900 123-45-67');
  });

  it('rejects a missing or malformed phone', () => {
    expect(() => normaliseRequesterPhone('')).toThrow(ValidationError);
    expect(() => normaliseRequesterPhone('12345')).toThrow(ValidationError);
    expect(() => normaliseRequesterPhone('номер не дам')).toThrow(ValidationError);
  });
});
