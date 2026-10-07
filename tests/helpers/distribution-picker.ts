import type { AppServices } from '../../src/app/container';
import type { ResolvedActor } from '../../src/bot/handlers/helpers';
import { handleIncidentCallback } from '../../src/bot/callbacks/incident.callbacks';
import { navigationKey } from '../../src/bot/callbacks/distribution-navigation';
import type { IncidentAction } from '../../src/max/callback-payload';
import { personalAction } from '../../src/work-queues/private-workspace';

/** Follow an action actually offered by the saved current screen, not a fabricated
 * legacy assign-group payload. End-to-end keyboard parsing is covered separately. */
export async function clickDistributionPicker(services: AppServices, actor: ResolvedActor, chatId: bigint, action: IncidentAction, argument?: string, privateItemId?: string) {
  const row = await services.prisma.systemSetting.findUniqueOrThrow({ where: { key: navigationKey(actor.maxUserId, chatId) } });
  const screen = JSON.parse(row.value) as { incidentId: string; token: string; mid: string; actions: { action: string; argument?: string }[] };
  const index = screen.actions.findIndex(p => p.action === action && (argument === undefined || p.argument === argument));
  if (index < 0) throw new Error(`Current screen does not offer ${action}`);
  const token = `${screen.token}~${index}`;
  if (privateItemId) await personalAction(services, actor, privateItemId, 'run', `incident:distribution-nav:${screen.incidentId}:${token}`, screen.mid);
  else await handleIncidentCallback({ services, actor, chatId, messageId: screen.mid }, { kind: 'incident', action: 'distribution-nav', incidentId: screen.incidentId, argument: token });
  return screen.mid;
}
