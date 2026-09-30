import { MaxError } from '@maxhub/max-bot-api';
import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { handleRequesterMessage } from '../../src/bot/handlers/requester.handler';
import { handleUserCallback } from '../../src/bot/callbacks/user.callbacks';
import { ValidationError } from '../../src/utils/errors';
import { actorFor, createHarness, createTestPrisma, describeIntegration, pushSchemaOnce,
  resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { TEST_USERS } from '../helpers/setup-env';

describeIntegration('requester recovery from preview photo errors', () => {
  let prisma: PrismaClient;
  let h: TestHarness;
  let actor: Awaited<ReturnType<typeof actorFor>>;
  const draft = {
    requesterPhone: '+7 900 111-22-33', selectedCategoryId: null,
    problemMunicipalityCode: 'KALUGA_CITY', problemMunicipalityName: 'Город Калуга',
    problemLocality: null, draftText: 'Не работает фонарь',
  };
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedCategories(prisma);
    h = await createHarness(prisma);
    actor = await actorFor(prisma, TEST_USERS.requesterA, 'Житель', []);
    if ((await h.services.legal.status(actor.userId)).required) {
      const evidence = { userId: actor.userId, maxUserId: actor.maxUserId };
      await h.services.legal.acceptUserAgreement(evidence);
      await h.services.legal.acceptPersonalDataConsent(evidence);
    }
  });
  const context = () => ({ services: h.services, actor, chatId: actor.maxUserId,
    messageId: 'preview', callbackId: 'callback' });
  const incoming = (text: string, photoUrl?: string) => ({
    body: { mid: `incoming-${photoUrl ?? text}`, text,
      attachments: photoUrl ? [{ type: 'image', payload: { url: photoUrl, token: photoUrl } }] : [] },
  });
  const session = () => h.services.sessions.find(actor.maxUserId, actor.maxUserId);

  it.each(['oversized', 'expired'])('preserves the draft after %s failure and registers only after replacement and confirmation', async failure => {
    const download = vi.spyOn(h.services.max, 'downloadFromUrl');
    if (failure === 'expired') vi.spyOn(h.messages, 'send').mockRejectedValueOnce(new MaxError(400, { code: 'attachment.invalid', message: 'Invalid photo token' }));
    vi.spyOn(h.services.media, 'ingestAll').mockImplementation(async (prefix, photos) => photos.map((photo, i) => ({
      type: 'IMAGE', storageKey: `${prefix}/${i}.jpg`, size: 5, sourceUrl: photo.url,
    })));
    await h.services.sessions.start({ maxUserId: actor.maxUserId, chatId: actor.maxUserId,
      type: 'WAITING_INCIDENT_TEXT', data: draft });
    if (failure === 'oversized') {
      await h.services.sessions.start({ maxUserId: actor.maxUserId, chatId: actor.maxUserId, type: 'WAITING_INCIDENT_EDIT_VALUE',
        data: { ...draft, draftEditField: 'text', draftMedia: [{ kind: 'IMAGE', token: 'failed', size: 21 * 1024 * 1024 }] } });
    }
    await handleRequesterMessage(h.services, actor, actor.maxUserId, incoming(draft.draftText, failure === 'expired' ? 'failed' : undefined) as never);
    const recovery = (await session())!;
    expect(recovery.type).toBe('WAITING_INCIDENT_EDIT_VALUE');
    expect(h.services.sessions.readData(recovery)).toMatchObject({ ...draft, draftPhotoRetry: true, draftMedia: [] });
    expect(h.messages.toUser(actor.maxUserId).at(-1)!.message.text).toContain('данные сохранены');
    expect(await prisma.incident.count()).toBe(0);
    await expect(handleUserCallback(context(), { kind: 'user', action: 'draft-confirm' })).rejects.toThrow('Кнопка устарела');
    expect(download).not.toHaveBeenCalled();

    await handleRequesterMessage(h.services, actor, actor.maxUserId, incoming('', 'replacement') as never);
    const ready = (await session())!;
    expect(ready.type).toBe('WAITING_INCIDENT_CONFIRMATION');
    expect(h.services.sessions.readData(ready).draftMedia).toEqual([{ kind: 'IMAGE', url: 'replacement', token: 'replacement' }]);
    expect(h.services.sessions.readData(ready).draftPhotoRetry).toBeUndefined();
    expect(h.messages.toUser(actor.maxUserId).at(-1)!.message.attachments).toHaveLength(1);
    expect(await prisma.incident.count()).toBe(0);
    await handleUserCallback(context(), { kind: 'user', action: 'draft-confirm', argument: h.services.sessions.readData(ready).previewToken });
    const incident = await prisma.incident.findFirstOrThrow({ include: { attachments: true } });
    expect(incident.text).toBe(draft.draftText);
    expect(incident.attachments).toHaveLength(1);
    expect(incident.attachments[0]!.sourceUrl).toBe('replacement');
    expect(await session()).toBeNull();
  });

  it('preserves an edited field when an old photo expires and permits explicit continuation without photos', async () => {
    const download = vi.spyOn(h.services.max, 'downloadFromUrl').mockRejectedValue(new Error('expired URL'));
    vi.spyOn(h.messages, 'send').mockRejectedValueOnce(new MaxError(400, { code: 'attachment.invalid', message: 'Expired photo token' }));
    await h.services.sessions.start({ maxUserId: actor.maxUserId, chatId: actor.maxUserId,
      type: 'WAITING_INCIDENT_EDIT_VALUE', data: { ...draft, draftEditField: 'text',
        draftMedia: [{ kind: 'IMAGE', url: 'expired', token: 'expired' }] } });
    const correctedText = 'Не работает фонарь у дома 12';
    await handleRequesterMessage(h.services, actor, actor.maxUserId, incoming(correctedText) as never);
    expect(h.services.sessions.readData((await session())!)).toMatchObject({
      ...draft, draftText: correctedText, draftPhotoRetry: true, draftMedia: [],
    });
    await handleUserCallback(context(), { kind: 'user', action: 'draft-photo', argument: 'remove' });
    expect(download).not.toHaveBeenCalled();
    expect((await session())!.type).toBe('WAITING_INCIDENT_CONFIRMATION');
    expect(h.messages.toUser(actor.maxUserId).at(-1)!.message.attachments).toBeUndefined();
    expect(await prisma.incident.count()).toBe(0);
    await handleUserCallback(context(), { kind: 'user', action: 'draft-confirm', argument: h.services.sessions.readData((await session())!).previewToken });
    const incident = await prisma.incident.findFirstOrThrow();
    expect(incident.text).toBe(correctedText);
    expect(incident.requesterPhone).toBe(draft.requesterPhone);
    expect(incident.requesterName).toBe('Житель');
  });

  it('does not let an old skip-photo button interrupt editing another field', async () => {
    await h.services.sessions.start({ maxUserId: actor.maxUserId, chatId: actor.maxUserId,
      type: 'WAITING_INCIDENT_EDIT_VALUE', data: { ...draft, draftEditField: 'text' } });
    await expect(handleUserCallback(context(), { kind: 'user', action: 'draft-photo', argument: 'remove' })).rejects.toThrow('Кнопка устарела');
    expect(h.services.sessions.readData((await session())!).draftEditField).toBe('text');
    expect(await prisma.incident.count()).toBe(0);
  });
});
