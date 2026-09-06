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
    requesterName: 'Иванов Иван', requesterPhone: '+7 900 111-22-33', selectedCategoryId: null,
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
      attachments: photoUrl ? [{ type: 'image', payload: { url: photoUrl } }] : [] },
  });
  const session = () => h.services.sessions.find(actor.maxUserId, actor.maxUserId);

  it.each(['oversized', 'network'])('preserves the draft after %s failure and registers only after replacement and confirmation', async failure => {
    const download = vi.spyOn(h.services.max, 'downloadFromUrl')
      .mockRejectedValueOnce(failure === 'oversized' ? new ValidationError('Максимальный размер — 20 МБ.') : new Error('offline'))
      .mockResolvedValue({ body: Buffer.from('photo') });
    vi.spyOn(h.services.media, 'ingestAll').mockImplementation(async (prefix, photos) => photos.map((photo, i) => ({
      type: 'IMAGE', storageKey: `${prefix}/${i}.jpg`, size: 5, sourceUrl: photo.url,
    })));
    await h.services.sessions.start({ maxUserId: actor.maxUserId, chatId: actor.maxUserId,
      type: 'WAITING_INCIDENT_TEXT', data: draft });
    await handleRequesterMessage(h.services, actor, actor.maxUserId, incoming(draft.draftText, 'failed') as never);
    const recovery = (await session())!;
    expect(recovery.type).toBe('WAITING_INCIDENT_EDIT_VALUE');
    expect(h.services.sessions.readData(recovery)).toMatchObject({ ...draft, draftPhotoRetry: true, draftMedia: [] });
    expect(h.messages.toUser(actor.maxUserId).at(-1)!.message.text).toContain('данные сохранены');
    expect(await prisma.incident.count()).toBe(0);
    await expect(handleUserCallback(context(), { kind: 'user', action: 'draft-confirm' })).rejects.toThrow('Кнопка устарела');
    expect(download).toHaveBeenCalledTimes(1);

    await handleRequesterMessage(h.services, actor, actor.maxUserId, incoming('', 'replacement') as never);
    const ready = (await session())!;
    expect(ready.type).toBe('WAITING_INCIDENT_CONFIRMATION');
    expect(h.services.sessions.readData(ready).draftMedia).toEqual([{ kind: 'IMAGE', url: 'replacement' }]);
    expect(h.services.sessions.readData(ready).draftPhotoRetry).toBeUndefined();
    expect(h.messages.toUser(actor.maxUserId).at(-1)!.message.attachments).toHaveLength(1);
    expect(await prisma.incident.count()).toBe(0);
    await handleUserCallback(context(), { kind: 'user', action: 'draft-confirm' });
    const incident = await prisma.incident.findFirstOrThrow({ include: { attachments: true } });
    expect(incident.text).toBe(draft.draftText);
    expect(incident.attachments).toHaveLength(1);
    expect(incident.attachments[0]!.sourceUrl).toBe('replacement');
    expect(await session()).toBeNull();
  });

  it('preserves an edited field when an old photo expires and permits explicit continuation without photos', async () => {
    const download = vi.spyOn(h.services.max, 'downloadFromUrl').mockRejectedValue(new Error('expired URL'));
    await h.services.sessions.start({ maxUserId: actor.maxUserId, chatId: actor.maxUserId,
      type: 'WAITING_INCIDENT_EDIT_VALUE', data: { ...draft, draftEditField: 'name',
        draftMedia: [{ kind: 'IMAGE', url: 'expired' }] } });
    await handleRequesterMessage(h.services, actor, actor.maxUserId, incoming('Петров Пётр') as never);
    expect(h.services.sessions.readData((await session())!)).toMatchObject({
      ...draft, requesterName: 'Петров Пётр', draftPhotoRetry: true, draftMedia: [],
    });
    await handleUserCallback(context(), { kind: 'user', action: 'draft-photo', argument: 'remove' });
    expect(download).toHaveBeenCalledTimes(1);
    expect((await session())!.type).toBe('WAITING_INCIDENT_CONFIRMATION');
    expect(h.messages.toUser(actor.maxUserId).at(-1)!.message.attachments).toBeUndefined();
    expect(await prisma.incident.count()).toBe(0);
    await handleUserCallback(context(), { kind: 'user', action: 'draft-confirm' });
    expect((await prisma.incident.findFirstOrThrow()).requesterName).toBe('Петров Пётр');
  });

  it('does not let an old skip-photo button interrupt editing another field', async () => {
    await h.services.sessions.start({ maxUserId: actor.maxUserId, chatId: actor.maxUserId,
      type: 'WAITING_INCIDENT_EDIT_VALUE', data: { ...draft, draftEditField: 'name' } });
    await expect(handleUserCallback(context(), { kind: 'user', action: 'draft-photo', argument: 'remove' })).rejects.toThrow('Кнопка устарела');
    expect(h.services.sessions.readData((await session())!).draftEditField).toBe('name');
    expect(await prisma.incident.count()).toBe(0);
  });
});
