'use strict';
// Runs only as a short-lived DB helper, never starts a second bot/worker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const req = createRequire('/app/package.json');
const { PrismaClient } = req('@prisma/client');
assert.equal(process.env.DATABASE_URL, 'postgresql://lab:synthetic_lab_password@postgres:5432/reserve_lab');
const p = new PrismaClient();
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
async function run() {
  if (input.op.startsWith('switch-') || input.op === 'benchmark') return require('./switch-state.cjs')(p,input,req);
  if (input.op === 'create') {
    const n = input.n, targetId = BigInt(input.target ?? 10000 + n);
    const payload = { text: input.text ?? String(n % 10).repeat(5000), keyboard: [[{ type: 'callback', text: 'Synthetic action', payload: 'noop' }]] };
    const attachments = input.media ? [...Array.from({ length: 9 }, (_, i) => ({ type: 'IMAGE', storageKey: `max-photo:synthetic-${n}-${i}`, owned: false })), { type: 'FILE', storageKey: 'fixture.txt', originalName: 'fixture.txt', owned: false }] : [];
    let incident, answer;
    if (input.kind === 'answer' || input.kind === 'sector') {
      const user = await p.user.create({ data: { maxUserId: targetId + 100000n, displayName: `Synthetic ${n}` } });
      const group = await p.responsibleGroup.create({ data: { code: `lab-${n}`, name: 'Synthetic group', kind: 'REGIONAL', maxChatId: -targetId, isActive: false } });
      incident = await p.incident.create({ data: { publicCode: `INC-LAB-${n}`, requesterId: user.id, requesterMaxUserId: targetId,
        requesterName: 'Synthetic', text: 'Synthetic fixture', status: input.kind === 'answer' ? 'RESOLVED' : 'ASSIGNED', assignedGroupId: group.id,
        answeredAt: input.kind === 'answer' ? new Date() : null, deadlineAt: new Date() } });
      if (input.kind === 'answer') answer = await p.incidentAnswer.create({ data: { incidentId: incident.id, version: 1, text: payload.text, status: 'APPROVED', createdByUserId: user.id, approvedAt: new Date() } });
      if (input.media) await p.incidentAttachment.createMany({ data: attachments.map(a => ({ incidentId: incident.id, type: a.type, storageKey: a.storageKey })) });
    }
    return p.outboundMessage.create({ data: { id: `lab-job-${n}`, dedupeKey: answer ? `answer:${answer.id}` : incident ? `sector-card:${incident.id}` : `lab-${n}`,
      targetType: input.kind === 'sector' ? 'chat' : 'user', targetId: input.kind === 'sector' ? -targetId : targetId,
      incidentId: incident?.id, answerId: answer?.id, trackingType: answer ? 'ANSWER_TO_REQUESTER' : incident ? 'SECTOR_CARD' : null,
      payload, attachments, attempts: input.attempts ?? 0, nextAttemptAt: new Date(0), status: input.status ?? 'PENDING',
      ...(input.status === 'FAILED' ? { lastError: 'MANUALLY_RETIRED_FOREIGN_BOT_ADDED' } : {}) } });
  }
  if (input.op === 'read') return p.outboundMessage.findUniqueOrThrow({ where: { id: input.id } });
  if (input.op === 'due') return p.outboundMessage.update({ where: { id: input.id }, data: { nextAttemptAt: new Date(0) } });
  if (input.op === 'pending-to-stale-sending') return p.outboundMessage.update({ where: { id: input.id }, data: { status: 'SENDING', lockedAt: new Date(0) } });
  if (input.op === 'corrupt') {
    const row = await p.outboundMessage.findUniqueOrThrow({ where: { id: input.id } });
    row.payload.deliveryProgress.version = 99;
    return p.outboundMessage.update({ where: { id: input.id }, data: { payload: row.payload, nextAttemptAt: new Date(0) } });
  }
  if (input.op === 'new-answer') {
    const row = await p.outboundMessage.findUniqueOrThrow({ where: { id: input.id } });
    const old = await p.incidentAnswer.findUniqueOrThrow({ where: { id: row.answerId } });
    await p.incidentAnswer.create({ data: { incidentId: old.incidentId, version: 2, text: 'New synthetic answer', createdByUserId: old.createdByUserId, status: 'WAITING_REVIEW' } });
    return p.incident.update({ where: { id: old.incidentId }, data: { status: 'WAITING_REVIEW' } });
  }
  if (input.op === 'new-assignment') {
    const row = await p.outboundMessage.findUniqueOrThrow({ where: { id: input.id } });
    const group = await p.responsibleGroup.create({ data: { code: `replacement-${input.id}`, name: 'Synthetic replacement', kind: 'REGIONAL', maxChatId: -900000n, isActive: false } });
    return p.incident.update({ where: { id: row.incidentId }, data: { assignedGroupId: group.id } });
  }
  if (input.op === 'tracking') {
    const row = await p.outboundMessage.findUniqueOrThrow({ where: { id: input.id } });
    return { answer: row.answerId && await p.incidentAnswer.findUnique({ where: { id: row.answerId } }),
      history: await p.incidentHistory.findMany({ where: { incidentId: row.incidentId ?? 'absent', action: 'ANSWER_SENT' } }),
      notices: await p.outboundMessage.findMany({ where: { dedupeKey: `answer-delivered:${row.answerId}:sector` } }) };
  }
  if (input.op === 'snapshot') return { jobs: await p.outboundMessage.findMany({ orderBy: { sequence: 'asc' } }), incidents: await p.incident.findMany(),
    answers: await p.incidentAnswer.findMany(), attachments: await p.incidentAttachment.findMany(), history: await p.incidentHistory.findMany() };
  throw new Error('Unknown synthetic fixture operation');
}
run().then(value => console.log(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v))).catch(e => { console.error(e); process.exitCode = 1; }).finally(() => p.$disconnect());
