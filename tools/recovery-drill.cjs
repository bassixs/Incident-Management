// Requires the disposable, network-isolated PostgreSQL from restore-check.cjs.
const fs = require('fs');
const { fork } = require('child_process');
const { createRequire } = require('module');
const req = createRequire('/app/package.json');
const { PrismaClient } = req('@prisma/client');
const { UpdateDispatcher } = req('./dist/server/update-dispatcher');
const { MaxMessageService } = req('./dist/max/max-message.service');
const { completeShutdown } = req('./dist/server/shutdown');
const url = new URL(process.env.DATABASE_URL || 'http://invalid');
if (process.env.ISOLATED_RECOVERY_DRILL !== '1' || url.hostname !== '127.0.0.1' || url.pathname !== '/incident_test') throw Error('Refusing non-isolated test database');
const prisma = new PrismaClient();
const mode = process.argv[2];
const receipts = '/tmp/recovery-receipts.jsonl';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = (type, id) => fs.appendFileSync(receipts, JSON.stringify({ type, id }) + '\n');

async function worker() {
  const scenario = process.argv[3];
  const transport = {
    dispatch: async update => {
      process.send?.({ event: 'inbox-start' });
      if (scenario === 'before-ack') await new Promise(() => {});
      await sleep(250); record('inbox', update.probe);
    },
    sendToUser: async (_id, text) => {
      process.send?.({ event: 'outbox-start' });
      if (scenario === 'before-ack') await new Promise(() => {});
      await sleep(250); record('outbox', text);
      if (scenario === 'after-ack') { process.send?.({ event: 'accepted' }); await new Promise(() => {}); }
      return { body: { mid: 'probe-' + text } };
    },
  };
  const inbox = new UpdateDispatcher(prisma, transport, 8);
  const outbox = new MaxMessageService(transport, { prisma, storage: {} }, 8);
  let shuttingDown = false;
  process.on('SIGTERM', async () => {
    if (shuttingDown) return;
    shuttingDown = true; inbox.stop(); outbox.stop();
    await completeShutdown({ closeIngress: async () => {}, waitForHandlers: () => inbox.waitForIdle(),
      waitForMessages: () => outbox.waitForIdle(), disconnect: () => prisma.$disconnect() });
    process.exit(0);
  });
  const keepAlive = setInterval(() => {}, 1000);
  outbox.start();
  await inbox.start();
  process.send?.({ event: 'started' });
  process.on('disconnect', () => clearInterval(keepAlive));
}
const children = [];
const child = scenario => {
  const events = new Set();
  const process = fork(__filename, ['worker', scenario], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  process.on('message', msg => events.add(msg.event));
  const exited = new Promise(resolve => process.on('exit', (code, signal) => resolve({ code, signal })));
  const item = { process, events, exited };
  children.push(item);
  return item;
};
async function until(fn, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (!(await fn())) { if (Date.now() > deadline) throw Error('Recovery assertion timed out'); await sleep(50); }
}
async function seed(count, inbox = true) {
  await prisma.inboundUpdate.deleteMany(); await prisma.outboundMessage.deleteMany();
  fs.writeFileSync(receipts, '');
  for (let i = 0; i < count; i++) {
    if (inbox) await prisma.inboundUpdate.create({ data: { externalUpdateKey: 'probe-' + i, updateType: 'probe', partitionKey: 'user:' + i, payload: { probe: i } } });
    await prisma.outboundMessage.create({ data: { targetType: 'user', targetId: BigInt(i + 1), dedupeKey: 'probe-' + i, payload: { text: String(i) }, attachments: [] } });
  }
}
const tally = () => fs.readFileSync(receipts, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
async function run() {
  const results = [];
  await seed(12);
  const a = child('graceful');
  await until(() => a.events.has('inbox-start') && a.events.has('outbox-start'));
  a.process.kill('SIGTERM');
  const exit = await a.exited;
  if (exit.code !== 0) throw Error('Graceful stop failed');
  const b = child('resume');
  await until(async () => await prisma.inboundUpdate.count({ where: { status: 'PROCESSED' } }) === 12 && await prisma.outboundMessage.count({ where: { status: 'SENT' } }) === 12);
  b.process.kill('SIGTERM'); await b.exited;
  const entries = tally();
  if (entries.length !== 24 || new Set(entries.map(x => x.type + ':' + x.id)).size !== 24) throw Error('Graceful restart lost or duplicated work');
  results.push({ scenario: 'SIGTERM during 12 incoming and 12 outgoing jobs', passed: true, receipts: 24, duplicates: 0 });

  await seed(12);
  const c = child('before-ack');
  await until(() => c.events.has('inbox-start') && c.events.has('outbox-start'));
  c.process.kill('SIGKILL'); await c.exited;
  const interrupted = await prisma.inboundUpdate.count({ where: { status: 'PROCESSING' } });
  // Shorten only the test lease; the production two-minute lease is unchanged.
  await prisma.outboundMessage.updateMany({ where: { status: 'SENDING' }, data: { lockedAt: new Date(Date.now() - 121_000) } });
  const d = child('resume');
  await until(async () => await prisma.outboundMessage.count({ where: { status: 'SENT' } }) === 12 && await prisma.inboundUpdate.count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } }) === 0);
  d.process.kill('SIGTERM'); await d.exited;
  const failed = await prisma.inboundUpdate.count({ where: { status: 'FAILED' } });
  const delivered = tally().filter(x => x.type === 'outbox');
  if (failed !== interrupted || delivered.length !== 12 || new Set(delivered.map(x => x.id)).size !== 12) throw Error('Abrupt recovery accounting mismatch');
  results.push({ scenario: 'SIGKILL before external acceptance', passed: true, outgoingDelivered: 12, outgoingDuplicates: 0,
    incomingNeedingManualReview: failed, leaseExpiryAcceleratedInTest: true });

  await seed(1, false);
  const e = child('after-ack'); await until(() => e.events.has('accepted'));
  e.process.kill('SIGKILL'); await e.exited;
  await prisma.outboundMessage.updateMany({ where: { status: 'SENDING' }, data: { lockedAt: new Date(Date.now() - 121_000) } });
  const f = child('resume'); await until(async () => await prisma.outboundMessage.count({ where: { status: 'SENT' } }) === 1);
  f.process.kill('SIGTERM'); await f.exited;
  const accepted = tally().filter(x => x.type === 'outbox').length;
  if (accepted !== 2) throw Error('Ambiguous acceptance probe did not reach the intended window');
  results.push({ scenario: 'SIGKILL after external acceptance but before database acknowledgement',
    observedExternalAcceptances: accepted, knownLimitation: 'Retry can duplicate an externally accepted message when its acknowledgement was lost', leaseExpiryAcceleratedInTest: true });
  console.log(JSON.stringify({ simulatedTransport: true, results }, null, 2));
}
(mode === 'worker' ? worker() : run()).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (mode !== 'worker') {
    for (const item of children) if (item.process.exitCode === null && item.process.signalCode === null) item.process.kill('SIGKILL');
    await Promise.all(children.map(item => item.exited));
    await prisma.$disconnect();
  }
});
