import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DMIT_STOCK_URL } from '../lib/monitor.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cookies = new Map();

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function request(base, endpoint, method = 'GET', body) {
  const response = await fetch(`${base}${endpoint}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookies.get(base) ? { cookie: cookies.get(base) } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (response.headers.get('set-cookie')) cookies.set(base, response.headers.get('set-cookie').split(';')[0]);
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
}

async function startApp(dataDir) {
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await request(base, '/api/auth/status'); await request(base, '/api/auth/register', 'POST', { username: 'alice', password: 'a-strong-password-123' }); return { base, child }; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  child.kill();
  throw new Error('应用未启动');
}

test('多渠道选择、单独测试与失败渠道重试', async () => {
  const messages = { a: [], b: [] };
  const aiCalls = [];
  let failB = false;
  let pageText = '<p>缺货</p>';
  const mock = http.createServer(async (req, res) => {
    if (req.url === '/source') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(pageText); return; }
    if (req.url === '/hook-a' || req.url === '/hook-b') {
      let body = '';
      for await (const chunk of req) body += chunk;
      if (req.url === '/hook-b' && failB) { res.writeHead(500); res.end('failed'); return; }
      messages[req.url === '/hook-a' ? 'a' : 'b'].push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url === '/hook-b' ? '{"errcode":0,"errmsg":"ok"}' : 'ok');
      return;
    }
    if (req.url === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const instruction = JSON.parse(body).messages.at(-1).content;
      aiCalls.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' });
      const rule = instruction.includes('DMIT')
        ? { url: DMIT_STOCK_URL, label: 'DMIT 任意有货', intervalMinutes: 10, plan: { sourceType: 'json', mode: instruction.includes('故意错误') ? 'item-transition' : 'any', initial: 'notify', path: 'products', filters: [{ path: 'provider', operator: 'equals', expected: 'dmit' }, { path: 'stale', operator: 'equals', expected: 0 }, { path: 'last_check_at', operator: 'withinMinutes', expected: 120 }, { path: 'status', operator: 'in', expected: ['有货', 'available'] }], idPath: 'product_key', statePath: 'status', fromValues: ['无货'], toValues: ['有货'] } }
        : { url: `http://127.0.0.1:${mock.address().port}/source`, label: '库存恢复', intervalMinutes: 10, plan: { sourceType: 'html', mode: 'contains', initial: 'baseline', keyword: '有货' } };
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rule) } }] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const mockPort = await listen(mock);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'webhook-radar-test-'));
  const { base, child } = await startApp(dataDir);
  const hooks = [
    { id: 'hook-a', name: '团队群', url: `http://127.0.0.1:${mockPort}/hook-a`, enabled: true },
    { id: 'hook-b', name: '个人频道', url: `http://127.0.0.1:${mockPort}/hook-b`, enabled: true, format: 'wecom' }
  ];
  try {
    const noKey = await fetch(`${base}/api/parse`, { method: 'POST', headers: { cookie: cookies.get(base), 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'DMIT 任意有货时通知' }) });
    assert.equal(noKey.status, 400);
    assert.match((await noKey.json()).error, /AI API Key/);
    assert.deepEqual(aiCalls, []);
    const saved = await request(base, '/api/settings', 'PUT', { webhooks: hooks, aiBaseUrl: `http://127.0.0.1:${mockPort}/v1`, aiModel: 'test-model', aiKey: 'secret-test-key' });
    assert.equal(saved.settings.webhooks.length, 2);
    assert.equal(saved.settings.hasAiKey, true);
    assert.equal(JSON.stringify(saved).includes('secret-test-key'), false);
    const parsed = await request(base, '/api/parse', 'POST', { instruction: `监控 http://127.0.0.1:${mockPort}/source 当库存恢复时提醒我` });
    assert.equal(parsed.monitor.kind, 'generated');
    assert.equal(parsed.monitor.plan.keyword, '有货');
    assert.equal(parsed.parser, 'ai');
    assert.deepEqual(aiCalls, ['Bearer secret-test-key']);
    const dmit = await request(base, '/api/parse', 'POST', { instruction: 'DMIT 套餐补货，第三方库存列表中，任意有货时通知' });
    assert.equal(dmit.monitor.plan.mode, 'any');
    assert.equal(dmit.monitor.plan.initial, 'notify');
    const wrongMode = await fetch(`${base}/api/parse`, { method: 'POST', headers: { cookie: cookies.get(base), 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'DMIT 任意有货故意错误时通知' }) });
    assert.equal(wrongMode.status, 400);
    assert.match((await wrongMode.json()).error, /没有按“任意有货”生成规则/);

    await request(base, '/api/send', 'POST', { title: '手动通知', message: '消息内容', webhookIds: ['hook-a'] });
    assert.deepEqual([messages.a.length, messages.b.length], [1, 0]);
    await request(base, '/api/test-webhook', 'POST', { webhookId: 'hook-b' });
    assert.deepEqual([messages.a.length, messages.b.length], [1, 1]);
    assert.equal(messages.b[0].msgtype, 'text');
    assert.match(messages.b[0].text.content, /测试通知/);

    const created = await request(base, '/api/monitors', 'POST', { kind: 'webpage', url: `http://127.0.0.1:${mockPort}/source`, label: '库存', description: '出现有货', keyword: '有货', mode: 'contains', intervalMinutes: 5, webhookIds: ['hook-a', 'hook-b'] });
    const id = created.monitors[0].id;
    assert.equal(created.monitors[0].baselined, true);
    assert.deepEqual([messages.a.length, messages.b.length], [1, 1]);
    pageText = '<p>有货</p>';
    await request(base, `/api/monitors/${id}/check`, 'POST');
    assert.deepEqual([messages.a.length, messages.b.length], [2, 2]);
    await request(base, `/api/monitors/${id}/check`, 'POST');
    assert.deepEqual([messages.a.length, messages.b.length], [2, 2]);

    pageText = '<p>缺货</p>';
    await request(base, `/api/monitors/${id}/check`, 'POST');
    failB = true;
    pageText = '<p>有货</p>';
    const partial = await request(base, `/api/monitors/${id}/check`, 'POST');
    assert.deepEqual([messages.a.length, messages.b.length], [3, 2]);
    assert.deepEqual(partial.monitors[0].pendingNotifications[0].remainingIds, ['hook-b']);
    failB = false;
    const retried = await request(base, `/api/monitors/${id}/check`, 'POST');
    assert.deepEqual([messages.a.length, messages.b.length], [3, 3]);
    assert.equal(retried.monitors[0].pendingNotifications.length, 0);
    assert.equal(retried.sentCount, 6);

    await request(base, '/api/settings', 'PUT', { webhooks: [hooks[0], { ...hooks[1], enabled: false }] });
    await request(base, '/api/test-webhook', 'POST', { webhookId: 'hook-b' });
    assert.equal(messages.b.length, 4);
    await request(base, '/api/settings', 'PUT', { webhooks: hooks });

    const edited = await request(base, `/api/monitors/${id}`, 'PATCH', { rule: { label: '现货提醒', keyword: '现货', description: '页面出现「现货」时通知', intervalMinutes: 15 }, webhookIds: ['hook-a'] });
    const editedMonitor = edited.monitors.find((monitor) => monitor.id === id);
    assert.equal(editedMonitor.label, '现货提醒');
    assert.equal(editedMonitor.intervalMinutes, 15);
    assert.equal(editedMonitor.baselined, true);
    assert.equal(editedMonitor.snapshot.matched, false);
    pageText = '<p>现货</p>';
    await request(base, `/api/monitors/${id}/check`, 'POST');
    assert.deepEqual([messages.a.length, messages.b.length], [4, 4]);

    const onlyB = await request(base, '/api/monitors', 'POST', { kind: 'webpage', url: `http://127.0.0.1:${mockPort}/source`, label: '仅个人频道', description: '出现有货', keyword: '有货', mode: 'contains', intervalMinutes: 5, webhookIds: ['hook-b'] });
    const onlyBId = onlyB.monitors[0].id;
    const updated = await request(base, '/api/settings', 'PUT', { webhooks: [hooks[0]] });
    assert.deepEqual(updated.monitors.find((monitor) => monitor.id === id).webhookIds, ['hook-a']);
    const paused = updated.monitors.find((monitor) => monitor.id === onlyBId);
    assert.equal(paused.enabled, false);
    assert.deepEqual(paused.webhookIds, []);
    const page = await fetch(`${base}/`);
    assert.equal((await page.text()).includes('data-example'), false);
  } finally {
    child.kill();
    await new Promise((resolve) => mock.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('旧版单 Webhook 设置自动迁移并保留监控任务', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'webhook-radar-migrate-'));
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    settings: { webhookUrl: 'https://example.com/hook', aiKey: 'old-key' },
    monitors: [{ id: 'existing-monitor', kind: 'webpage', url: 'https://example.com', label: '旧任务', keyword: '有货', mode: 'contains', enabled: false, intervalMinutes: 10 }],
    events: [], sentCount: 2
  }));
  const { base, child } = await startApp(dataDir);
  try {
    const saved = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
    await request(base, '/api/auth/claim-legacy', 'POST', { token: saved.legacyClaimToken });
    const state = await request(base, '/api/state');
    assert.equal(state.settings.webhooks.length, 1);
    assert.equal(state.settings.webhooks[0].name, '默认 Webhook');
    assert.deepEqual(state.monitors[0].webhookIds, [state.settings.webhooks[0].id]);
    assert.equal(state.settings.hasAiKey, true);
    assert.equal(JSON.stringify(state).includes('old-key'), false);
  } finally {
    child.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('不同用户的规则、渠道、日志隔离，ntfy 优先级按通知覆盖', async () => {
  const received = [];
  let stock = 0;
  const mock = http.createServer(async (req, res) => {
    if (req.url === '/source') { res.end(JSON.stringify({ stock })); return; }
    if (req.url === '/forbidden') { res.writeHead(403); res.end('blocked'); return; }
    if (req.url === '/ntfy') {
      let body = '';
      for await (const chunk of req) body += chunk;
      received.push({ body, priority: req.headers['x-priority'], title: req.headers['x-title'] });
      res.end('{"id":"message"}'); return;
    }
    res.writeHead(404); res.end();
  });
  const mockPort = await listen(mock);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'webhook-radar-users-'));
  const { base, child } = await startApp(dataDir);
  const aliceCookie = cookies.get(base);
  try {
    await request(base, '/api/settings', 'PUT', { webhooks: [{ id: 'alice-ntfy', name: 'Alice', url: `http://127.0.0.1:${mockPort}/ntfy`, format: 'ntfy', priority: 4 }], aiBaseUrl: 'https://api.openai.com/v1', aiModel: 'test', aiKey: 'alice-secret' });
    assert.equal((await request(base, '/api/state')).settings.hasAiKey, true);
    const created = await request(base, '/api/monitors', 'POST', { kind: 'json', url: `http://127.0.0.1:${mockPort}/source`, label: '库存', jsonPath: 'stock', operator: 'gt', expected: '0', webhookIds: ['alice-ntfy'] });
    const aliceMonitor = created.monitors[0].id;
    await request(base, '/api/send', 'POST', { title: '紧急', message: '内容', priority: 5, webhookIds: ['alice-ntfy'] });
    assert.deepEqual(received.map((item) => item.priority), ['5']);
    assert.equal(received[0].body, '内容');
    assert.equal(Buffer.from(received[0].title.slice(10, -2), 'base64').toString(), '紧急');
    const generated = await request(base, '/api/monitors', 'POST', { kind: 'generated', url: `http://127.0.0.1:${mockPort}/source`, label: '按需生成的库存提醒', plan: { sourceType: 'json', mode: 'compare', initial: 'baseline', path: 'stock', operator: 'gt', expected: 0 }, webhookIds: ['alice-ntfy'] });
    assert.equal(generated.monitors[0].snapshot.matched, false);
    stock = 1;
    await request(base, `/api/monitors/${generated.monitors[0].id}/check`, 'POST');
    assert.equal(received.at(-1).priority, '4');
    assert.match(received.at(-1).body, /stock/);
    await request(base, '/api/monitors', 'POST', { kind: 'webpage', url: `http://127.0.0.1:${mockPort}/forbidden`, label: '受限页面', keyword: '有货', webhookIds: ['alice-ntfy'] });
    const aliceLogs = await request(base, '/api/logs');
    assert.ok(aliceLogs.logs.some((entry) => entry.kind === 'monitor' && entry.status === 'error' && /HTTP 403/.test(entry.detail)));

    await request(base, '/api/auth/register', 'POST', { username: 'bob', password: 'another-strong-password-456' });
    const bobState = await request(base, '/api/state');
    assert.deepEqual(bobState.monitors, []);
    assert.deepEqual(bobState.settings.webhooks, []);
    assert.equal(bobState.settings.hasAiKey, false);
    assert.deepEqual((await request(base, '/api/logs')).logs, []);
    const foreign = await fetch(`${base}/api/monitors/${aliceMonitor}/check`, { method: 'POST', headers: { cookie: cookies.get(base) } });
    assert.equal(foreign.status, 404);
    const forbiddenSend = await fetch(`${base}/api/send`, { method: 'POST', headers: { cookie: cookies.get(base), 'content-type': 'application/json' }, body: JSON.stringify({ title: 'test', message: 'test', webhookIds: ['alice-ntfy'] }) });
    assert.equal(forbiddenSend.status, 400);
    await request(base, '/api/auth/logout', 'POST');
    const loggedOut = await fetch(`${base}/api/state`, { headers: { cookie: cookies.get(base) } });
    assert.equal(loggedOut.status, 401);
    await request(base, '/api/auth/login', 'POST', { username: 'bob', password: 'another-strong-password-456' });
    assert.deepEqual((await request(base, '/api/state')).monitors, []);
    cookies.set(base, aliceCookie);
    assert.equal((await request(base, '/api/state')).monitors.length, 3);
  } finally {
    child.kill();
    await new Promise((resolve) => mock.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
