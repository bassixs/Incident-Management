import type { AppServices } from '../../src/app/container';
import type { ResolvedActor } from '../../src/bot/handlers/helpers';
import { handleIncidentCallback } from '../../src/bot/callbacks/incident.callbacks';
import { navigationKey } from '../../src/bot/callbacks/distribution-navigation';
import type { IncidentAction } from '../../src/max/callback-payload';
import { personalAction } from '../../src/work-queues/private-workspace';
import { vi } from 'vitest';

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

export async function prepareDistributionChoice(services: AppServices, actor: ResolvedActor, chatId: bigint, incidentId: string, groupId: string) {
  let incident = await services.prisma.incident.findUniqueOrThrow({ where: { id: incidentId } });
  if (!incident.distributionMessageId) {
    await services.distribution.publishCard(incidentId);
    // Concurrent producers can enqueue while a previously started drain is
    // finishing. Wait on the actual ACK/tracking predicate, not elapsed sleep or
    // one global drain promise. flush keeps normal FIFO, dedupe and backoff.
    await vi.waitFor(async () => {
      await services.messages.flush();
      incident = await services.prisma.incident.findUniqueOrThrow({ where: { id: incidentId } });
      if (!incident.distributionMessageId) {
        const head = await services.prisma.outboundMessage.findFirst({ where: { targetType: 'chat', targetId: chatId, status: { in: ['PENDING', 'SENDING'] } }, orderBy: { sequence: 'asc' }, select: { id: true, status: true, attempts: true, nextAttemptAt: true, lastError: true } });
        throw new Error(`Fixture is waiting for acknowledged distribution card; head=${JSON.stringify(head)}`);
      }
    }, { timeout: 10_000, interval: 20 });
  }
  await handleIncidentCallback({ services, actor, chatId, messageId: incident.distributionMessageId! }, { kind: 'incident', action: 'assign', incidentId });
  const group = await services.prisma.responsibleGroup.findUniqueOrThrow({ where: { id: groupId } });
  await clickDistributionPicker(services, actor, chatId, 'assign-branch', group.kind === 'LOCAL_GOVERNMENT' ? 'local' : group.kind === 'REGIONAL' ? 'regional' : 'executive');
  await clickDistributionPicker(services, actor, chatId, 'assign-group', groupId);
}
