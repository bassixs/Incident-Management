'use strict';
// Synthetic MAX only. Network is Docker --internal; no production credentials.
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const ledger = [], requests = [], unexpected = [], rules = new Map(), pins = new Map(), held = new Map();
let seq = 0;
function message(target, body) {
  return { sender: { user_id: 999, is_bot: true, name: 'Synthetic bot' }, recipient: { chat_id: Number(target.split(':')[1]), chat_type: target.startsWith('chat:') ? 'chat' : 'dialog' }, timestamp: Date.now(), body: { mid: `lab-mid-${++seq}`, seq, text: body.text ?? '', attachments: body.attachments ?? [] } };
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://mock:8080');
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const body = req.headers['content-type']?.includes('application/json') && raw.length ? JSON.parse(raw) : {};
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/control') {
      if (req.method === 'POST') {
        if (body.op === 'rule') rules.set(body.target, { ...body, calls: 0 });
        else if (body.op === 'clear') rules.delete(body.target);
        else if (body.op === 'release') { held.get(body.target)?.(); held.delete(body.target); }
        else return json(400, { error: 'unknown control operation' });
      }
      return json(200, { ledger, requests, unexpected, held: [...held.keys()] });
    }
    if (url.pathname === '/blob') return json(200, { token: 'synthetic-file-token' });
    if (req.headers.authorization !== 'synthetic-container-token') return json(401, { code: 'test.token', message: 'Only synthetic token accepted' });
    if (url.pathname === '/me' && req.method === 'GET') return json(200, { user_id: 999, is_bot: true, name: 'Synthetic bot', username: 'synthetic_bot' });
    if (url.pathname === '/me/commands' && req.method === 'PATCH') return json(200, { success: true });
    if (url.pathname === '/uploads') return json(200, { url: 'http://mock:8080/blob', token: 'synthetic-file-token' });
    if (url.pathname === '/subscriptions') { unexpected.push({ path: url.pathname, method: req.method }); return json(403, { code: 'test.forbidden', message: 'Subscription operations forbidden' }); }
    if (url.pathname === '/messages' && req.method === 'POST') {
      const target = url.searchParams.has('user_id') ? `user:${url.searchParams.get('user_id')}` : `chat:${url.searchParams.get('chat_id')}`;
      const rule = rules.get(target); if (rule) rule.calls++;
      requests.push({ target, at: performance.now(), text: body.text ?? '', type: 'send' });
      if (Array.from(body.text ?? '').length > 4000) return json(400, { code: 'test.text.length', message: 'Text exceeds MAX limit' });
      if (rule && rule.calls >= (rule.from ?? 1) && (rule.count == null || rule.calls < (rule.from ?? 1) + rule.count)) {
        if (rule.mode === 'error') return json(rule.status ?? 503, { code: 'test.temporary', message: 'Synthetic temporary failure' });
        if (rule.mode === 'drop-before') return req.socket.destroy();
      }
      const msg = message(target, body); ledger.push({ target, at: performance.now(), message: msg });
      if (rule?.mode === 'drop-after' && rule.calls === (rule.from ?? 1)) return req.socket.destroy();
      if (rule?.mode === 'hold' && rule.calls === (rule.from ?? 1)) await new Promise(r => held.set(target, r));
      return json(200, { message: msg });
    }
    if (url.pathname.startsWith('/messages/') && req.method === 'GET') {
      const row = ledger.find(r => r.message.body.mid === decodeURIComponent(url.pathname.slice(10)));
      return row ? json(200, row.message) : json(404, { code: 'test.notfound', message: 'Synthetic message absent' });
    }
    if (url.pathname === '/messages' && req.method === 'PUT') {
      const row = ledger.find(r => r.message.body.mid === url.searchParams.get('message_id'));
      if (!row) return json(404, { code: 'test.notfound', message: 'Synthetic message absent' });
      if (Array.from(body.text ?? '').length > 4000) return json(400, { code: 'test.text.length', message: 'Text exceeds MAX limit' });
      requests.push({ type: 'edit', target: row.target, mid: row.message.body.mid, at: performance.now(), body });
      Object.assign(row.message.body, body); return json(200, { success: true });
    }
    if (/^\/chats\/-?\d+\/pin$/.test(url.pathname)) {
      if (req.method === 'PUT') { pins.set(url.pathname, body.message_id); return json(200, { success: true }); }
      const row = ledger.find(r => r.message.body.mid === pins.get(url.pathname)); return json(200, { message: row?.message ?? null });
    }
    unexpected.push({ path: url.pathname, method: req.method });
    return json(404, { code: 'test.unexpected', message: 'Unsupported mock route' });
  } catch (e) { res.writeHead(500); res.end(JSON.stringify({ code: 'test.mock', message: String(e) })); }
});
server.listen(8080, '0.0.0.0');
