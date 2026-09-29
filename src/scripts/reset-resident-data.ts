/** One-off, explicitly confirmed reset for the minimal-profile release. Never starts the bot. */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { Bot } from '@maxhub/max-bot-api';
import { getConfig } from '../config';
import { resolveRoles, isStaff } from '../users/roles';

async function main() {
  const config = getConfig();
  const prisma = new PrismaClient();
  try {
    const incidents = await prisma.incident.findMany({ select: { id: true, distributionMessageId: true, sectorMessageId: true, reviewMessageId: true } });
    const users = await prisma.user.findMany({ include: { _count: { select: { assignedByMe: true, respondingTo: true, approvedByMe: true, authoredAnswers: true, approvedAnswers: true, bansIssued: true } } } });
    const history = await prisma.incidentHistory.findMany({ where: { actorMaxUserId: { not: null }, OR: ['DISPATCHER','RESPONDER','APPROVER','ADMIN'].map(role => ({ actorRole: { contains: role } })) }, select: { actorMaxUserId: true } });
    const audit = await prisma.adminAuditLog.findMany({ select: { actorMaxUserId: true } });
    const remembered = await prisma.systemSetting.findMany({ where: { key: { startsWith: 'maintenance.cleanup-staff:' } } });
    const staff = new Set([...history.map(x => String(x.actorMaxUserId)), ...audit.map(x => String(x.actorMaxUserId)), ...remembered.map(x => x.value)]);
    for (const user of users) if (isStaff(resolveRoles(user.maxUserId, user.roles)) || Object.values(user._count).some(n => n > 0)) staff.add(String(user.maxUserId));
    const removable = users.filter(u => !staff.has(String(u.maxUserId))).map(u => u.id);
    const outbox = await prisma.outboundMessage.findMany({ where: { targetType: 'chat' }, select: { firstMessageId: true } });
    const messageIds = [...new Set([...incidents.flatMap(i => [i.distributionMessageId,i.sectorMessageId,i.reviewMessageId]), ...outbox.map(o => o.firstMessageId)].filter((id): id is string => !!id))];
    const stable = async () => JSON.stringify({ groups: await prisma.responsibleGroup.findMany({ orderBy: { id: 'asc' } }), categories: await prisma.category.findMany({ orderBy: { id: 'asc' } }), staff: await prisma.user.findMany({ where: { id: { notIn: removable } }, orderBy: { id: 'asc' }, select: { id: true, maxUserId: true, roles: true } }) }, (_k,v) => typeof v === 'bigint' ? String(v) : v);
    const beforeHash = createHash('sha256').update(await stable()).digest('hex');
    console.log(JSON.stringify({ mode: process.argv.includes('--confirm') ? 'confirmed' : 'preview', incidents: incidents.length, residentProfiles: removable.length, retainedStaffAccounts: users.length-removable.length, knownWorkMessages: messageIds.length }));
    if (!process.argv.includes('--confirm')) return;
    // Do not create another backup of the very data the owner requested to erase.
    await prisma.$transaction(async tx => {
      await tx.systemSetting.createMany({ skipDuplicates: true, data: [...staff].map(id => ({ key: `maintenance.cleanup-staff:${id}`, value: id })) });
      await tx.outboundMessage.deleteMany(); await tx.inboundUpdate.deleteMany(); await tx.processedUpdate.deleteMany();
      await tx.operatorSession.deleteMany(); await tx.privateWorkItem.deleteMany(); await tx.actionLock.deleteMany();
      await tx.incident.deleteMany(); await tx.legalAcceptance.deleteMany(); await tx.ban.deleteMany();
      await tx.adminAuditLog.deleteMany();
      await tx.user.updateMany({ data: { requesterName: null, requesterPhone: null, username: null } });
      await tx.user.deleteMany({ where: { id: { in: removable } } });
      await tx.systemSetting.deleteMany({ where: { OR: [{ key: { startsWith: 'distribution-panel:' } }, { key: { startsWith: 'work-panel:' } }, { key: 'maintenance.manual-cleanup' }] } });
      // Counter deliberately survives: old MAX buttons must never refer to a reused public number.
    }, { timeout: 60000 });
    if (createHash('sha256').update(await stable()).digest('hex') !== beforeHash) throw Error('Work configuration changed unexpectedly');
    let removed = 0, failed = 0;
    const bot = new Bot(config.BOT_TOKEN);
    for (const id of messageIds) {
      try { await bot.api.deleteMessage(id); removed++; }
      catch (error) { if ((error as { status?: number }).status === 404) { removed++; continue; } failed++; if (failed >= 3) break; }
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    console.log(JSON.stringify({ incidentsRemaining: await prisma.incident.count(), consentsRemaining: await prisma.legalAcceptance.count(), residentProfilesRemaining: await prisma.user.count({ where: { id: { in: removable } } }), workConfigurationUnchanged: true, workMessagesDeleted: removed, workMessagesUnconfirmed: messageIds.length-removed, botStarted: false }));
  } finally { await prisma.$disconnect(); }
}
main().catch(() => { console.error('Resident reset failed; inspect server state without exposing data.'); process.exitCode=1; });
