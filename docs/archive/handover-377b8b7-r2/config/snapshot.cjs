'use strict';
const { req, json, hash, api, safeError, panel } = require('./common.cjs');
const { PrismaClient } = req('@prisma/client');
async function snapshot(db, withMax) {
  const result = { at: new Date().toISOString(), config: {}, database: {}, queues: {}, panels: [] };
  for (const key of ['NODE_ENV','BOT_MODE','WEBHOOK_AUTO_REGISTER','MEDIA_STORAGE','MEDIA_LOCAL_PATH','BOT_STATUS_TIME','BOT_STATUS_WEEKDAY']) result.config[key] = process.env[key] || '';
  result.config.botStatusRecipients = (process.env.BOT_STATUS_USER_IDS || '').split(',').filter(x => x.trim()).length;
  const url = new URL(process.env.DATABASE_URL);
  result.config.databaseHost = url.hostname; result.config.databasePort = url.port || '5432';
  await db.$queryRaw`SELECT 1`;
  for (const model of ['user','responsibleGroup','category','systemSetting','incidentCounter','incident','incidentAnswer','incidentAttachment','answerAttachment','clarification','clarificationAttachment','operatorSession','privateWorkItem']) {
    const rows = await db[model].findMany();
    result.database[model] = { count: rows.length, fingerprint: hash(rows.map(x => json(x)).sort()) };
  }
  for (const model of ['inboundUpdate','outboundMessage']) {
    result.queues[model] = await db[model].groupBy({ by: ['status'], _count: true });
  }
  const settings = await db.systemSetting.findMany({ orderBy: { key: 'asc' } });
  const groups = await db.responsibleGroup.findMany({ where: { isActive: true, maxChatId: { not: null } } });
  result.expectedChats = [...new Set([...groups.map(x => String(x.maxChatId)), process.env.DISTRIBUTION_CHAT_ID, process.env.REVIEW_CHAT_ID].filter(Boolean))].sort();
  for (const row of settings.filter(panel)) result.panels.push({ key: row.key, chatId: row.key.split(':')[1], databaseId: row.value });
  result.missingPanelChats = result.expectedChats.filter(id => !result.panels.some(p => p.chatId === id));
  if (withMax) {
    try {
      const me = await api('GET', '/me'); result.botId = me.user_id;
      const subscriptions = (await api('GET', '/subscriptions')).subscriptions || [];
      result.webhook = { expectedPresent: subscriptions.some(s => s.url === process.env.WEBHOOK_URL), count: subscriptions.length, unexpected: subscriptions.some(s => s.url !== process.env.WEBHOOK_URL) };
      for (const p of result.panels) {
        try {
          const pinned = (await api('GET', `/chats/${p.chatId}/pin`)).message;
          const current = await api('GET', `/messages/${encodeURIComponent(p.databaseId)}`);
          p.pinnedId = pinned?.body?.mid || null;
          p.authorMatches = current.sender?.user_id === me.user_id;
          p.buttons = (current.body?.attachments || []).filter(a => a.type === 'inline_keyboard').flatMap(a => a.payload.buttons.flat()).map(b => b.payload || b.type).sort();
          const expected = p.key.startsWith('distribution-') ? ['personal:home','queue:next','queue:list:0','queue:refresh','work:today:0'] : ['personal:home','work:next','work:list:0','work:mine:0','work:today:0','work:refresh'];
          p.ok = p.pinnedId === p.databaseId && p.authorMatches && json(p.buttons) === json(expected.sort());
        } catch (e) { p.ok = false; p.error = safeError(e); }
      }
    } catch (e) { result.maxError = safeError(e); }
  }
  return result;
}
module.exports = { snapshot };
if (require.main === module) {
  const db = new PrismaClient({ log: [] });
  snapshot(db, !process.argv.includes('--offline')).then(r => { console.log(json(r)); if (r.maxError || r.webhook?.expectedPresent === false || r.webhook?.unexpected || r.missingPanelChats.length || r.panels.some(p => p.ok === false)) process.exitCode = 2; })
    .catch(() => { console.error('Snapshot failed. Check DB connectivity/configuration; raw error omitted.'); process.exitCode = 1; }).finally(() => db.$disconnect());
}
