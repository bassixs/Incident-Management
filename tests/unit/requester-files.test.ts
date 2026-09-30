import { beforeEach, expect, it, vi } from 'vitest';

import { handleMessageUpdate } from '../../src/bot/handlers/message.handler';
import { handleRequesterMessage } from '../../src/bot/handlers/requester.handler';
import { handleOperatorMessage } from '../../src/bot/handlers/operator.handler';
import { findCommand } from '../../src/bot/commands';
import { REJECTION_MESSAGES } from '../../src/incidents/incident.service';
import { getConfig } from '../../src/config';
import { CONTACT_REJECTION } from '../../src/privacy/optional-contact';

vi.mock('../../src/bot/handlers/requester.handler', () => ({ handleRequesterMessage: vi.fn(), sendMainMenu: vi.fn() }));
vi.mock('../../src/bot/handlers/operator.handler', () => ({ handleOperatorMessage: vi.fn() }));
vi.mock('../../src/bot/commands', () => ({ findCommand: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

function setup(attachments: unknown[], text = 'Описание', dialog = true) {
  const session = { id: 'unchanged-session' };
  const services = {
    config: getConfig(),
    prisma: { privateWorkItem: { findFirst: vi.fn().mockResolvedValue(null) }, responsibleGroup: { findMany: vi.fn().mockResolvedValue([{ name: 'Профильная группа', bypassReview: false }]) } },
    actionGuard: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    users: { identity: vi.fn().mockResolvedValue({ user: { id: 'user', maxUserId: 5001n, displayName: 'Житель' }, roles: [] }) },
    messages: { send: vi.fn().mockResolvedValue({}) },
    sessions: { find: vi.fn().mockResolvedValue(session) },
    media: { ingestAll: vi.fn() },
  };
  const message = {
    sender: { user_id: 5001, is_bot: false },
    recipient: { chat_type: dialog ? 'dialog' : 'chat', chat_id: dialog ? undefined : -1010 },
    body: { mid: 'incoming', text, attachments },
  };
  return { services, message, session, ctx: { update: { message }, contactInfo: { tel: '+79001112233' } } };
}

it.each(['document.pdf', 'document.docx', 'photo.jpg'])('rejects %s sent as a file before routing or downloading', async filename => {
  const { services, ctx } = setup([{ type: 'file', filename, payload: { url: 'https://example.test/file' } }]);
  await handleMessageUpdate(services as never, ctx as never);
  expect(services.messages.send).toHaveBeenCalledWith({ userId: 5001n }, { text: REJECTION_MESSAGES.file });
  expect(handleRequesterMessage).not.toHaveBeenCalled();
  expect(services.sessions.find).not.toHaveBeenCalled();
  expect(services.media.ingestAll).not.toHaveBeenCalled();
});

it('rejects a mixed photo/file message with a command caption without executing the command', async () => {
  const { services, ctx } = setup([{ type: 'image', payload: {} }, { type: 'file', payload: {} }], '/start');
  await handleMessageUpdate(services as never, ctx as never);
  expect(services.messages.send).toHaveBeenCalledTimes(1);
  expect(findCommand).not.toHaveBeenCalled();
  expect(handleRequesterMessage).not.toHaveBeenCalled();
});

it('keeps normal image messages available to the requester flow', async () => {
  const { services, ctx, message } = setup([{ type: 'image', payload: {} }]);
  await handleMessageUpdate(services as never, ctx as never);
  expect(handleRequesterMessage).toHaveBeenCalledWith(services, expect.anything(), 5001n, message);
  expect(services.messages.send).not.toHaveBeenCalled();
});

it('never routes an unverified raw contact to the ordinary requester flow', async () => {
  const { services, ctx } = setup([{ type: 'contact', payload: {} }]);
  await handleMessageUpdate(services as never, ctx as never);
  expect(handleRequesterMessage).not.toHaveBeenCalled();
  expect(services.messages.send).toHaveBeenCalledWith({ userId: 5001n }, { text: CONTACT_REJECTION });
  expect(services.sessions.find).not.toHaveBeenCalled();
});

it('routes a verified contact exactly once before commands and staff text processing', async () => {
  const { services, ctx, message } = setup([], '/start');
  const contact = { phone: '+7 900 111-22-33', draftToken: 'draft', previewToken: 'preview' };
  Object.assign(ctx.update, { verifiedDraftContact: contact });
  await handleMessageUpdate(services as never, ctx as never);
  expect(handleRequesterMessage).toHaveBeenCalledTimes(1);
  expect(handleRequesterMessage).toHaveBeenCalledWith(services, expect.anything(), 5001n, message, contact);
  expect(findCommand).not.toHaveBeenCalled();
  expect(services.prisma.privateWorkItem.findFirst).not.toHaveBeenCalled();
  expect(services.messages.send).not.toHaveBeenCalled();
});

it('routes staff files in working chats to the operator handler', async () => {
  const { services, ctx, message, session } = setup([{ type: 'file', payload: {} }], 'Ответ', false);
  await handleMessageUpdate(services as never, ctx as never);
  expect(handleOperatorMessage).toHaveBeenCalledWith(services, expect.objectContaining({ roles: ['RESPONDER'] }), -1010n, message, session);
  expect(services.messages.send).not.toHaveBeenCalled();
});

it.each(['https://max.ru/example', 'Проблема: example.org'])('accepts resident links with MAX previews: %s', async text => {
  const { services, ctx, message } = setup([{ type: 'image', payload: { url: 'https://photo.test/a' } }, { type: 'share', payload: { url: 'https://example.org', token: 'preview' } }], text);
  await handleMessageUpdate(services as never, ctx as never);
  expect(handleRequesterMessage).toHaveBeenCalledWith(services, expect.anything(), 5001n, message);
  expect(services.messages.send).not.toHaveBeenCalled();
});

it('keeps links available in staff working chats', async () => {
  const { services, ctx, message, session } = setup([], 'Ответ: https://example.org', false);
  await handleMessageUpdate(services as never, ctx as never);
  expect(handleOperatorMessage).toHaveBeenCalledWith(services, expect.anything(), -1010n, message, session);
  expect(services.messages.send).not.toHaveBeenCalled();
});
