import { handleUserCallback, type UserCallbackContext } from '../../src/bot/callbacks/user.callbacks';
import { parseCallbackPayload, type CallbackPayload } from '../../src/max/callback-payload';

/** Select the button actually published for the current screen. If absent, send
 * the original stale action so negative assertions still exercise rejection.
 */
export async function currentResidentAction(context: UserCallbackContext, payload: Extract<CallbackPayload, { kind: 'user' }>) {
  const session = await context.services.sessions.find(context.actor.maxUserId, context.chatId ?? context.actor.maxUserId);
  const data = session && context.services.sessions.readData(session);
  const index = data?.screenActions?.findIndex(raw => {
    const item = parseCallbackPayload(raw);
    return item?.kind === 'user' && item.action === payload.action &&
      (item.argument === payload.argument || payload.argument === undefined);
  }) ?? -1;
  return index < 0 ? payload : { kind: 'user' as const, action: 'draft-action' as const, argument: `${data!.screenToken}~${index}` };
}

export async function clickResidentAction(context: UserCallbackContext, payload: Extract<CallbackPayload, { kind: 'user' }>) {
  return handleUserCallback(context, await currentResidentAction(context, payload));
}
