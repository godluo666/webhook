import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
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

async function localMonitoringProxy(targetPort, password = 'proxy-regression-private') {
  const sockets = new Set(), proxy = http.createServer();
  proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  proxy.on('connect', (req, socket, head) => {
    if (req.url !== '127.0.0.1:' + targetPort || req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from('regression-user:' + password).toString('base64')) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return;
    }
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
  });
  const port = await listen(proxy);
  let stopped = false;
  return {
    url: 'http://regression-user:' + password + '@127.0.0.1:' + port,
    endpoint: 'http://127.0.0.1:' + port,
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => proxy.close(resolve));
    }
  };
}

async function request(base, endpoint, method = 'GET', body) {
  const response = await fetch(`${base}${endpoint}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookies.get(base) ? { cookie: cookies.get(base) } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (response.headers.get('set-cookie')) cookies.set(base, response.headers.get('set-cookie').split(';')[0]);
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
}

async function startApp(dataDir, options = {}) {
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, RESEND_API_KEY: '', MAIL_FROM: '', ...options.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await request(base, '/api/auth/status'); if (options.autoRegister !== false) await request(base, '/api/auth/register', 'POST', { username: 'alice', password: 'a-strong-password-123' }); return { base, child }; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
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
    const firstMatch = await request(base, `/api/monitors/${id}/check`, 'POST');
    assert.deepEqual([messages.a.length, messages.b.length], [2, 2]);
    assert.equal(firstMatch.check.sentCount, 2);
    const repeated = await request(base, `/api/monitors/${id}/check`, 'POST');
    assert.deepEqual([messages.a.length, messages.b.length], [3, 3]);
    assert.equal(repeated.check.sentCount, 2);

    pageText = '<p>缺货</p>';
    await request(base, `/api/monitors/${id}/check`, 'POST');
    failB = true;
    pageText = '<p>有货</p>';
    const partial = await request(base, `/api/monitors/${id}/check`, 'POST');
    assert.deepEqual([messages.a.length, messages.b.length], [4, 3]);
    assert.deepEqual(partial.monitors[0].pendingNotifications[0].remainingIds, ['hook-b']);
    failB = false;
    const retried = await request(base, `/api/monitors/${id}/check`, 'POST');
    assert.deepEqual([messages.a.length, messages.b.length], [4, 4]);
    assert.equal(retried.check.sentCount, 1);
    assert.equal(retried.monitors[0].pendingNotifications.length, 0);
    assert.equal(retried.sentCount, 8);

    await request(base, '/api/settings', 'PUT', { webhooks: [hooks[0], { ...hooks[1], enabled: false }] });
    await request(base, '/api/test-webhook', 'POST', { webhookId: 'hook-b' });
    assert.equal(messages.b.length, 5);
    await request(base, '/api/settings', 'PUT', { webhooks: hooks });

    const edited = await request(base, `/api/monitors/${id}`, 'PATCH', { rule: { label: '现货提醒', keyword: '现货', description: '页面出现「现货」时通知', intervalMinutes: 15 }, webhookIds: ['hook-a'] });
    const editedMonitor = edited.monitors.find((monitor) => monitor.id === id);
    assert.equal(editedMonitor.label, '现货提醒');
    assert.equal(editedMonitor.intervalMinutes, 15);
    assert.equal(editedMonitor.baselined, true);
    assert.equal(editedMonitor.snapshot.matched, false);
    pageText = '<p>现货</p>';
    await request(base, `/api/monitors/${id}/check`, 'POST');
    assert.deepEqual([messages.a.length, messages.b.length], [5, 5]);

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

test('旧版未归属数据不会进入新版账户，也不再提供认领接口', async () => {
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
    const state = await request(base, '/api/state');
    assert.deepEqual(Object.keys(saved).sort(), ['sessionSecret', 'users']);
    assert.deepEqual(state.settings.webhooks, []);
    assert.deepEqual(state.monitors, []);
    assert.equal(JSON.stringify(state).includes('old-key'), false);
    const claim = await fetch(`${base}/api/auth/claim-legacy`, { method: 'POST', headers: { cookie: cookies.get(base), 'content-type': 'application/json' }, body: JSON.stringify({ token: 'anything' }) });
    assert.equal(claim.status, 404);
  } finally {
    child.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('注册和绑定邮箱必须使用邮件服务发送的一次性验证码', async () => {
  const sent = [];
  const mail = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    sent.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `mail-${sent.length}` }));
  });
  const mailPort = await listen(mail);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'webhook-radar-email-'));
  const { base, child } = await startApp(dataDir, { autoRegister: false, env: { RESEND_API_KEY: 'test-mail-key', MAIL_FROM: 'Webhook Radar <notify@example.test>', RESEND_API_URL: `http://127.0.0.1:${mailPort}/emails` } });
  const password = 'a-strong-password-123';
  try {
    assert.equal((await request(base, '/api/auth/status')).emailVerificationEnabled, true);
    const noCode = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password, email: 'alice@example.test' }) });
    assert.equal(noCode.status, 400);
    await request(base, '/api/auth/email-code', 'POST', { purpose: 'register', username: 'alice', email: 'alice@example.test' });
    assert.equal(sent[0].path, '/emails');
    assert.equal(sent[0].authorization, 'Bearer test-mail-key');
    assert.deepEqual(sent[0].body.to, ['alice@example.test']);
    const registerCode = sent[0].body.text.match(/\d{6}/)[0];
    const wrong = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password, email: 'alice@example.test', emailCode: '999999' === registerCode ? '888888' : '999999' }) });
    assert.equal(wrong.status, 400);
    const registered = await request(base, '/api/auth/register', 'POST', { username: 'alice', password, email: 'alice@example.test', emailCode: registerCode });
    assert.equal(registered.user.emailVerified, true);
    assert.equal(registered.user.email, 'alice@example.test');

    const badPassword = await fetch(`${base}/api/auth/email-code`, { method: 'POST', headers: { cookie: cookies.get(base), 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'bind', email: 'new@example.test', password: 'wrong-password' }) });
    assert.equal(badPassword.status, 400);
    await request(base, '/api/auth/email-code', 'POST', { purpose: 'bind', email: 'new@example.test', password });
    const bindCode = sent.at(-1).body.text.match(/\d{6}/)[0];
    const badBind = await fetch(`${base}/api/auth/profile`, { method: 'PUT', headers: { cookie: cookies.get(base), 'content-type': 'application/json' }, body: JSON.stringify({ email: 'new@example.test', password, emailCode: '000000' === bindCode ? '111111' : '000000' }) });
    assert.equal(badBind.status, 400);
    const bound = await request(base, '/api/auth/profile', 'PUT', { email: 'new@example.test', password, emailCode: bindCode });
    assert.equal(bound.user.emailVerified, true);
    assert.equal(bound.user.email, 'new@example.test');
    const removed = await request(base, '/api/auth/profile', 'PUT', { email: '', password });
    assert.equal(removed.user.emailVerified, false);
    assert.equal(removed.user.email, '');
    const saved = await readFile(path.join(dataDir, 'state.json'), 'utf8');
    assert.equal(saved.includes(registerCode), false);
    assert.equal(saved.includes(bindCode), false);
  } finally {
    child.kill();
    await new Promise((resolve) => mail.close(resolve));
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


test('AI 对话补充信息、自动修正模型遗漏并在确认后创建规则', async () => {
  const aiCalls = [];
  const notifications = [];
  const mock = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('private-source-marker-91a7'); return; }
    if (req.url === '/hook') {
      let body = '';
      for await (const chunk of req) body += chunk;
      notifications.push(JSON.parse(body));
      res.writeHead(200); res.end('ok');
      return;
    }
    if (req.url === '/v1/chat/completions') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const call = JSON.parse(raw);
      aiCalls.push(call);
      const turns = call.messages.filter((message) => message.role === 'user').map((message) => message.content).join(' ');
      const repairing = call.messages.some((message) => message.role === 'system' && message.content.includes('上次生成的规则未通过校验'));
      const url = `http://127.0.0.1:${mock.address().port}/health`;
      const content = !turns.includes(url)
        ? { status: 'need_more_info', questions: ['订单接口的健康检查地址是什么？'] }
        : repairing
          ? { status: 'ready', url, label: '订单接口可用性', plan: { sourceType: 'service', mode: 'unavailable', initial: 'notify', failureThreshold: 3 } }
          : { status: 'ready', url, label: '订单接口可用性', plan: { sourceType: 'service', initial: 'notify', failureThreshold: 3 } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const port = await listen(mock);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'webhook-radar-dialog-'));
  const { base, child } = await startApp(dataDir);
  try {
    await request(base, '/api/settings', 'PUT', {
      webhooks: [{ id: 'hook', name: '通知', url: `http://127.0.0.1:${port}/hook`, enabled: true }],
      aiBaseUrl: `http://127.0.0.1:${port}/v1`, aiModel: 'test-model', aiKey: 'test-key'
    });
    const instruction = '帮我监控订单接口';
    const first = await request(base, '/api/parse', 'POST', { instruction });
    assert.equal(first.status, 'need_more_info');
    assert.match(first.questions[0], /地址/);
    assert.equal(aiCalls.length, 1);
    assert.equal((await request(base, '/api/state')).monitors.length, 0);
    const url = `http://127.0.0.1:${port}/health`;
    const conversation = [
      { role: 'assistant', content: first.questions[0] },
      { role: 'user', content: `${url}，每 5 分钟检查，连续失败 3 次报警` }
    ];
    const ready = await request(base, '/api/parse', 'POST', { instruction, conversation });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.monitor.url, `http://127.0.0.1:${port}/health`);
    assert.match(ready.sourceCheck, /HTTP 503/);
    assert.equal(JSON.stringify(aiCalls).includes('private-source-marker-91a7'), false);
    assert.equal(ready.monitor.intervalMinutes, 5);
    assert.equal(ready.monitor.severity, 'warning');
    assert.equal(ready.monitor.plan.failureThreshold, 3);
    assert.equal(aiCalls.length, 3);
    const logs = await request(base, '/api/logs');
    assert.match(JSON.stringify(logs), /首次生成|firstModelError|AI 未生成有效监控逻辑/);
    const revised = await request(base, '/api/parse', 'POST', { instruction, sourceUrl: `http://127.0.0.1:${port}/old`, conversation });
    assert.equal(revised.monitor.url, url);
    assert.equal((await request(base, '/api/state')).monitors.length, 0);
    const created = await request(base, '/api/monitors', 'POST', { ...ready.monitor, webhookIds: ['hook'] });
    assert.equal(created.status, 'created');
    assert.equal(created.monitors.length, 1);
    assert.equal(notifications.length, 0);
    const id = created.monitors[0].id;
    await request(base, `/api/monitors/${id}/check`, 'POST');
    assert.equal(notifications.length, 0);
    await request(base, `/api/monitors/${id}/check`, 'POST');
    assert.equal(notifications.length, 1);
  } finally {
    child.kill();
    await new Promise((resolve) => mock.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('AI 一次性提醒无需监控来源，到点重试且不会重复发送；API Key 不回显', async () => {
  const notifications = [];
  let failWebhook = true;
  const mock = http.createServer(async (req, res) => {
    if (req.url === '/hook') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      if (failWebhook) { res.writeHead(500); res.end('temporary failure'); return; }
      notifications.push(JSON.parse(raw));
      res.writeHead(200); res.end('ok');
      return;
    }
    if (req.url === '/v1/chat/completions') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const due = new Date(Date.now() + 1600).toISOString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        status: 'ready', kind: 'reminder', label: '开会提醒', message: '去会议室开会', remindAt: due
      }) } }] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const port = await listen(mock);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'webhook-radar-reminder-'));
  const { base, child } = await startApp(dataDir);
  try {
    const saved = await request(base, '/api/settings', 'PUT', {
      webhooks: [{ id: 'hook', name: '通知', url: 'http://127.0.0.1:' + port + '/hook', enabled: true }],
      aiBaseUrl: 'http://127.0.0.1:' + port + '/v1', aiModel: 'test-model', aiKey: 'private-test-key'
    });
    assert.equal(saved.settings.hasAiKey, true);
    assert.equal('aiKeyHint' in saved.settings, false);
    assert.equal(JSON.stringify(saved).includes('private-test-key'), false);
    const keyRead = await fetch(base + '/api/ai/key', { headers: { cookie: cookies.get(base) } });
    assert.equal(keyRead.status, 404);
    const draft = await request(base, '/api/parse', 'POST', { instruction: '两分钟后提醒我开会', timeZone: 'Asia/Shanghai' });
    assert.equal(draft.status, 'ready');
    assert.equal(draft.monitor.kind, 'reminder');
    assert.equal(draft.monitor.message, '去会议室开会');
    assert.equal((await request(base, '/api/state')).monitors.length, 0);
    const created = await request(base, '/api/monitors', 'POST', { ...draft.monitor, webhookIds: ['hook'] });
    const id = created.monitors[0].id;
    assert.equal(created.monitors[0].kind, 'reminder');
    assert.equal(created.monitors[0].firedAt, undefined);
    assert.equal(notifications.length, 0);
    const waitMs = Math.max(0, Date.parse(draft.monitor.remindAt) - Date.now() + 1200);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const scheduled = await request(base, '/api/state');
    assert.ok(scheduled.monitors[0].firedAt);
    assert.equal(scheduled.monitors[0].pendingNotifications.length, 1);
    assert.equal(scheduled.monitors[0].completedAt, undefined);
    failWebhook = false;
    const sent = await request(base, '/api/monitors/' + id + '/check', 'POST');
    assert.equal(sent.monitors[0].pendingNotifications.length, 0);
    assert.ok(sent.monitors[0].completedAt);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].message, '去会议室开会');
    await request(base, '/api/monitors/' + id + '/check', 'POST');
    assert.equal(notifications.length, 1);
    const cleared = await request(base, '/api/ai/key', 'DELETE');
    assert.equal(cleared.settings.hasAiKey, false);
    assert.equal(JSON.stringify(cleared).includes('private-test-key'), false);
  } finally {
    child.kill();
    await new Promise((resolve) => mock.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
test('AI 重复追问时会修正一次，仍重复则给出新的业务化提问', async () => {
  let calls = 0;
  const mock = http.createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls++;
    const latest = JSON.parse(raw).messages.at(-1).content;
    const reply = latest.includes('为什么')
      ? { status: 'answer', message: '需要知道从哪里读取状态。你可以提供接口地址，也可以使用本机日志。' }
      : { status: 'need_more_info', questions: ['什么情况需要提醒？'] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  });
  const port = await listen(mock);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'webhook-radar-repeat-'));
  const { base, child } = await startApp(dataDir);
  try {
    await request(base, '/api/settings', 'PUT', {
      webhooks: [], aiBaseUrl: 'http://127.0.0.1:' + port + '/v1',
      aiModel: 'test-model', aiKey: 'test-key'
    });
    const instruction = '帮我监控支付系统';
    const first = await request(base, '/api/parse', 'POST', { instruction });
    assert.equal(first.status, 'need_more_info');
    const second = await request(base, '/api/parse', 'POST', {
      instruction, conversation: [
        { role: 'assistant', content: first.questions[0] },
        { role: 'user', content: '只要支付失败就提醒我' }
      ]
    });
    assert.equal(second.status, 'need_more_info');
    assert.notEqual(second.questions[0], first.questions[0]);
    assert.equal(calls, 3);
    const answer = await request(base, '/api/parse', 'POST', {
      instruction, conversation: [{ role: 'user', content: '为什么一定要接口地址？' }]
    });
    assert.equal(answer.status, 'answer');
    assert.match(answer.message, /本机日志/);
    assert.equal(calls, 4);
  } finally {
    child.kill();
    await new Promise((resolve) => mock.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
test('循环提醒按间隔安排下次发送，失败只重试本轮', async () => {
  const notifications = [];
  let failWebhook = true;
  const mock = http.createServer(async (req, res) => {
    if (req.url !== '/hook') { res.writeHead(404); res.end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (failWebhook) { res.writeHead(500); res.end('temporary failure'); return; }
    notifications.push(JSON.parse(raw));
    res.writeHead(200); res.end('ok');
  });
  const port = await listen(mock);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'webhook-radar-recurring-'));
  const { base, child } = await startApp(dataDir);
  try {
    await request(base, '/api/settings', 'PUT', {
      webhooks: [{ id: 'hook', name: '提醒渠道', url: 'http://127.0.0.1:' + port + '/hook', enabled: true }]
    });
    const firstDue = new Date(Date.now() + 1600).toISOString();
    const created = await request(base, '/api/monitors', 'POST', {
      kind: 'reminder', label: '喝水', message: '该喝水了', remindAt: firstDue,
      repeatMinutes: 60, webhookIds: ['hook']
    });
    const id = created.monitors[0].id;
    assert.equal(created.monitors[0].repeatMinutes, 60);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(firstDue) - Date.now() + 1200)));
    const failed = (await request(base, '/api/state')).monitors[0];
    assert.equal(failed.remindAt, firstDue);
    assert.equal(failed.pendingNotifications.length, 1);
    failWebhook = false;
    const sent = await request(base, '/api/monitors/' + id + '/check', 'POST');
    assert.equal(sent.check.sentCount, 1);
    assert.equal(notifications.length, 1);
    assert.equal(sent.monitors[0].pendingNotifications.length, 0);
    assert.equal(sent.monitors[0].completedAt, null);
    assert.equal(sent.monitors[0].repeatMinutes, 60);
    assert.ok(Date.parse(sent.monitors[0].remindAt) > Date.now());
    await request(base, '/api/monitors/' + id + '/check', 'POST');
    assert.equal(notifications.length, 1);
    const edited = await request(base, '/api/monitors/' + id, 'PATCH', {
      rule: { repeatMinutes: 0, remindAt: new Date(Date.now() + 3600000).toISOString() }
    });
    assert.equal(edited.monitors[0].repeatMinutes, 0);
    assert.equal(edited.monitors[0].completedAt, null);
  } finally {
    child.kill();
    await new Promise((resolve) => mock.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
test('AI 漏掉循环提醒首次时间时按间隔自动安排', async () => {
  const mock = http.createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    for await (const chunk of req) { void chunk; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      status: 'ready', kind: 'reminder', label: '喝水提醒', message: '该喝水了', repeatMinutes: 90
    }) } }] }));
  });
  const port = await listen(mock);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'webhook-radar-ai-interval-'));
  const { base, child } = await startApp(dataDir);
  try {
    await request(base, '/api/settings', 'PUT', {
      webhooks: [], aiBaseUrl: 'http://127.0.0.1:' + port + '/v1',
      aiModel: 'test-model', aiKey: 'test-key'
    });
    const before = Date.now();
    const draft = await request(base, '/api/parse', 'POST', { instruction: '每隔90分钟提醒我喝水' });
    assert.equal(draft.status, 'ready');
    assert.equal(draft.monitor.kind, 'reminder');
    assert.equal(draft.monitor.repeatMinutes, 90);
    assert.ok(Date.parse(draft.monitor.remindAt) >= before + 90 * 60_000);
    assert.ok(Date.parse(draft.monitor.remindAt) <= Date.now() + 90 * 60_000);
  } finally {
    child.kill();
    await new Promise((resolve) => mock.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
test('已有地址时 AI 索要技术字段会改为可执行的服务监控', async () => {
  let calls = 0;
  const mock = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls++;
    const url = 'http://127.0.0.1:' + mock.address().port + '/health';
    const repairing = JSON.parse(raw).messages.some((message) =>
      message.role === 'system' && message.content.includes('上次生成的规则未通过校验'));
    const reply = repairing
      ? { status: 'ready', url, label: '服务可用性', plan: { sourceType: 'service', mode: 'unavailable' } }
      : { status: 'need_more_info', questions: ['请告诉我 JSON 字段名和 path'] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  });
  const port = await listen(mock);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'webhook-radar-field-repair-'));
  const { base, child } = await startApp(dataDir);
  try {
    await request(base, '/api/settings', 'PUT', {
      webhooks: [], aiBaseUrl: 'http://127.0.0.1:' + port + '/v1',
      aiModel: 'test-model', aiKey: 'test-key'
    });
    const draft = await request(base, '/api/parse', 'POST', {
      instruction: '帮我看这个服务有没有挂',
      sourceUrl: 'http://127.0.0.1:' + port + '/health'
    });
    assert.equal(draft.status, 'ready');
    assert.equal(draft.monitor.plan.sourceType, 'service');
    assert.match(draft.sourceCheck, /HTTP 200/);
    assert.equal(calls, 2);
  } finally {
    child.kill();
    await new Promise((resolve) => mock.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
test('先生成可确认草稿，补上地址即可试跑与创建，不必再调用 AI', async () => {
  let calls = 0;
  let notifications = 0;
  const mock = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.writeHead(503); res.end('private-body-not-for-ai'); return; }
    if (req.url === '/hook') { notifications++; res.writeHead(200); res.end('ok'); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    for await (const chunk of req) { void chunk; }
    calls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      status: 'draft', message: '我先按打不开时提醒来安排。补上你平时访问的网址即可。',
      assumptions: ['每 5 分钟检查', '无法访问时立即通知'],
      monitor: { label: '支付系统', url: 'https://invented.example.com', plan: { sourceType: 'service', mode: 'unavailable', initial: 'notify' } }
    }) } }] }));
  });
  const port = await listen(mock);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'webhook-radar-draft-'));
  const { base, child } = await startApp(dataDir);
  try {
    await request(base, '/api/settings', 'PUT', {
      webhooks: [{ id: 'hook', name: '通知', url: 'http://127.0.0.1:' + port + '/hook', enabled: true }],
      aiBaseUrl: 'http://127.0.0.1:' + port + '/v1', aiModel: 'test-model', aiKey: 'test-key'
    });
    const draft = await request(base, '/api/parse', 'POST', { instruction: '帮我看看支付系统有没有挂，我不懂技术细节' });
    assert.equal(draft.status, 'draft');
    assert.equal(draft.monitor.url, '');
    assert.equal(draft.monitor.intervalMinutes, 5);
    assert.match(draft.message, /平时访问/);
    assert.deepEqual(draft.assumptions, ['每 5 分钟检查', '无法访问时立即通知']);
    assert.equal((await request(base, '/api/state')).monitors.length, 0);
    const rule = { ...draft.monitor, url: 'http://127.0.0.1:' + port + '/health', webhookIds: ['hook'] };
    const trial = await request(base, '/api/preview-check', 'POST', rule);
    assert.equal(trial.healthy, false);
    assert.equal(notifications, 0);
    assert.equal((await request(base, '/api/state')).monitors.length, 0);
    const created = await request(base, '/api/monitors', 'POST', rule);
    assert.equal(created.monitors.length, 1);
    assert.equal(notifications, 1);
    assert.equal(calls, 1);
  } finally {
    child.kill();
    await new Promise((resolve) => mock.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('AI 追问可默认的参数时先尝试生成，并保留本次方案说明', async () => {
  let calls = 0;
  const mock = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    calls++;
    const repairing = JSON.parse(body).messages.some((message) => message.role === 'system' && message.content.includes('上次生成的规则未通过校验'));
    const reply = repairing ? {
      status: 'ready', message: '我先按超过 3 秒算慢来试跑，可以随时改。',
      assumptions: ['响应超过 3 秒时通知', '每 5 分钟检查'],
      url: 'http://127.0.0.1:' + mock.address().port + '/health',
      plan: { sourceType: 'service', mode: 'slow', thresholdMs: 3000, initial: 'notify' }
    } : { status: 'need_more_info', questions: ['需要几秒报警？检测周期是多少？'] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  });
  const port = await listen(mock);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'webhook-radar-defaults-'));
  const { base, child } = await startApp(dataDir);
  try {
    await request(base, '/api/settings', 'PUT', {
      webhooks: [], aiBaseUrl: 'http://127.0.0.1:' + port + '/v1', aiModel: 'test-model', aiKey: 'test-key'
    });
    const ready = await request(base, '/api/parse', 'POST', { instruction: '这个服务变慢就通知我', sourceUrl: 'http://127.0.0.1:' + port + '/health' });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.monitor.plan.thresholdMs, 3000);
    assert.match(ready.message, /先按超过 3 秒/);
    assert.equal(ready.assumptions.length, 2);
    assert.equal(calls, 2);
  } finally {
    child.kill();
    await new Promise((resolve) => mock.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('动态通知预览、模拟发送与正式通知一致；编辑文案保留检测状态且账户隔离', async () => {
  const messages = [];
  let state = 'out';
  const mock = http.createServer(async (req, res) => {
    if (req.url === '/source') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ products: [{ id: 'a', name: '服务 A', state }, { id: 'b', name: '服务 B', state: 'out' }] })); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    messages.push({ body, headers: req.headers });
    res.end('ok');
  });
  const port = await listen(mock);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'radar-notification-'));
  const { base, child } = await startApp(dataDir);
  try {
    await request(base, '/api/settings', 'PUT', { webhooks: [{ id: 'hook', name: '频道', url: 'http://127.0.0.1:' + port + '/hook', format: 'ntfy', priority: 4 }] });
    const rule = { kind: 'generated', label: '状态变化', url: 'http://127.0.0.1:' + port + '/source', intervalMinutes: 5, webhookIds: ['hook'],
      plan: { sourceType: 'json', mode: 'item-transition', initial: 'baseline', path: 'products', filters: [], idPath: 'id', statePath: 'state', fromValues: ['out'], toValues: ['ready'] },
      notification: { title: '状态更新', body: '准备就绪：{{items}}' } };
    const created = await request(base, '/api/monitors', 'POST', rule);
    const monitor = created.monitors[0];
    assert.equal(messages.length, 0);
    const preview = await request(base, '/api/notification-preview', 'POST', { monitorId: monitor.id });
    assert.equal(preview.basis, 'sample');
    assert.match(preview.payload.message, /示例条目/);
    assert.equal(preview.channels[0].headers['x-priority'], '4');
    const before = JSON.stringify(monitor);
    const sent = await request(base, '/api/notification-simulate', 'POST', { previewId: preview.id });
    assert.equal(sent.sent.length, 1);
    assert.equal(messages[0].body, preview.channels[0].body);
    const title = Buffer.from(messages[0].headers['x-title'].split('?')[3], 'base64').toString();
    assert.equal(title, preview.simulationTitle);
    assert.equal(JSON.stringify((await request(base, '/api/state')).monitors[0]), before);
    const duplicate = await fetch(base + '/api/notification-simulate', { method: 'POST', headers: { cookie: cookies.get(base), 'content-type': 'application/json' }, body: JSON.stringify({ previewId: preview.id }) });
    assert.equal(duplicate.status, 404);
    state = 'ready';
    const trial = await request(base, '/api/preview-check', 'POST', rule);
    assert.equal(trial.notificationPreview.basis, 'observed');
    assert.equal(trial.notificationPreview.payload.message, '准备就绪：服务 A');
    assert.equal(messages.length, 1);
    const live = await request(base, '/api/monitors/' + monitor.id + '/check', 'POST');
    assert.equal(live.check.sentCount, 1);
    assert.equal(messages[1].body, trial.notificationPreview.channels[0].body);
    const edited = await request(base, '/api/monitors/' + monitor.id, 'PATCH', { rule: { notification: { title: '新标题', body: '本次详情：{{details}}' } } });
    assert.deepEqual(edited.monitors[0].snapshot, live.monitors[0].snapshot);
    assert.equal(edited.monitors[0].lastCheckAt, live.monitors[0].lastCheckAt);
    const token = await request(base, '/api/notification-preview', 'POST', { monitorId: monitor.id });
    assert.equal(token.payload.title, '新标题');
    const alice = cookies.get(base);
    await request(base, '/api/auth/register', 'POST', { username: 'bob', password: 'another-secure-password' });
    for (const [endpoint, body] of [['/api/notification-preview', { monitorId: monitor.id }], ['/api/notification-simulate', { previewId: token.id }]]) {
      const denied = await fetch(base + endpoint, { method: 'POST', headers: { cookie: cookies.get(base), 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(denied.status, 404);
    }
    cookies.set(base, alice);
    const reminder = (await request(base, '/api/monitors', 'POST', { kind: 'reminder', label: '喝水', message: '喝一杯水', remindAt: new Date(Date.now() + 86400000).toISOString(), repeatMinutes: 60, webhookIds: ['hook'] })).monitors[0];
    const reminderPreview = await request(base, '/api/notification-preview', 'POST', { monitorId: reminder.id });
    assert.equal(reminderPreview.payload.message, '喝一杯水');
    await request(base, '/api/notification-simulate', 'POST', { previewId: reminderPreview.id });
    const after = (await request(base, '/api/state')).monitors.find((item) => item.id === reminder.id);
    assert.deepEqual(after, reminder);
  } finally {
    child.kill();
    await new Promise((resolve) => mock.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('AI 调整文案继承当前草稿，未输出通知设置时保留用户编辑；不发送检测原文', async () => {
  const calls = [];
  const mock = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.end('private-source-body'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push(JSON.parse(raw));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'ready', message: '继续使用你编辑的通知内容，每10分钟检查。', monitor: { kind: 'generated', url: 'http://127.0.0.1:' + mock.address().port + '/health', label: '服务检查', intervalMinutes: 10, plan: { sourceType: 'service', mode: 'unavailable', initial: 'notify' } } }) } }] }));
  });
  const port = await listen(mock);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'radar-ai-edit-'));
  const { base, child } = await startApp(dataDir);
  try {
    await request(base, '/api/settings', 'PUT', { aiBaseUrl: 'http://127.0.0.1:' + port, aiModel: 'test', aiKey: 'test-key' });
    const draft = { kind: 'generated', label: '服务检查', url: 'http://127.0.0.1:' + port + '/health', plan: { sourceType: 'service', mode: 'unavailable' }, notification: { title: '请关注服务', body: '我关心的结果：{{details}}' } };
    const result = await request(base, '/api/parse', 'POST', { instruction: '帮我关注服务是否正常', sourceUrl: draft.url, draft, conversation: [{ role: 'user', content: '每10分钟一次，保留我修改的文案' }] });
    assert.equal(result.monitor.intervalMinutes, 10);
    assert.deepEqual(result.monitor.notification, draft.notification);
    assert.match(JSON.stringify(calls[0]), /我关心的结果/);
    assert.doesNotMatch(JSON.stringify(calls[0]), /private-source-body/);
  } finally {
    child.kill();
    await new Promise((resolve) => mock.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('AI 修改已创建任务只生成草稿，确认后更新原 ID，并保护暂停状态、版本及账户隔离', async () => {
  const calls = [];
  const mock = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.end('healthy'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.url === '/hook') { res.end('ok'); return; }
    calls.push(JSON.parse(raw));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      status: 'ready', message: '已改为每15分钟检查，连续失败3次提醒，其他设置保留。',
      monitor: { kind: 'generated', intervalMinutes: 15, plan: { failureThreshold: 3 } }
    }) } }] }));
  });
  const port = await listen(mock);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'radar-refine-'));
  const { base, child } = await startApp(dataDir);
  const denied = async (endpoint, method, body, status) => {
    const response = await fetch(base + endpoint, { method, headers: { cookie: cookies.get(base), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, status, await response.text());
  };
  try {
    await request(base, '/api/settings', 'PUT', { aiBaseUrl: 'http://127.0.0.1:' + port, aiModel: 'test-model', aiKey: 'test-key', webhooks: [{ id: 'hook', name: '频道', url: 'http://127.0.0.1:' + port + '/hook' }] });
    const created = await request(base, '/api/monitors', 'POST', { kind: 'generated', label: '订单服务', url: 'http://127.0.0.1:' + port + '/health', intervalMinutes: 10, plan: { sourceType: 'service', mode: 'unavailable', initial: 'baseline', failureThreshold: 1 }, notification: { title: '我的标题', body: '{{details}}' }, webhookIds: ['hook'] });
    const id = created.monitors[0].id;
    const paused = (await request(base, '/api/monitors/' + id, 'PATCH', { enabled: false })).monitors[0];
    const draft = await request(base, '/api/parse', 'POST', { monitorId: id, expectedRevision: paused.revision, instruction: '每15分钟检查，连续失败3次再通知' });
    assert.equal(draft.status, 'ready');
    assert.equal(draft.editing.monitorId, id);
    assert.equal(draft.monitor.plan.sourceType, 'service');
    assert.equal(draft.monitor.plan.failureThreshold, 3);
    assert.equal(draft.monitor.plan.initial, 'baseline');
    assert.equal(draft.monitor.url, paused.url);
    assert.deepEqual(draft.monitor.notification, paused.notification);
    assert.match(JSON.stringify(calls[0]), /订单服务/);
    assert.deepEqual((await request(base, '/api/state')).monitors[0], paused);
    await denied('/api/monitors/' + id, 'PATCH', { rule: { label: '不应保存' }, webhookIds: ['unknown'], expectedRevision: paused.revision }, 400);
    assert.deepEqual((await request(base, '/api/state')).monitors[0], paused);
    const saved = await request(base, '/api/monitors/' + id, 'PATCH', { rule: draft.monitor, webhookIds: ['hook'], expectedRevision: paused.revision });
    assert.equal(saved.monitors.length, 1);
    assert.equal(saved.monitors[0].id, id);
    assert.equal(saved.monitors[0].enabled, false);
    assert.equal(saved.monitors[0].plan.failureThreshold, 3);
    assert.equal(saved.monitors[0].revision, paused.revision + 1);
    await denied('/api/monitors/' + id, 'PATCH', { rule: { intervalMinutes: 60 }, expectedRevision: paused.revision }, 409);
    const count = calls.length;
    await denied('/api/parse', 'POST', { monitorId: id, expectedRevision: paused.revision, instruction: '再改一下' }, 409);
    assert.equal(calls.length, count);
    await request(base, '/api/auth/register', 'POST', { username: 'bob', password: 'another-secure-password' });
    await denied('/api/parse', 'POST', { monitorId: id, instruction: '修改这个规则' }, 404);
    await denied('/api/monitors/' + id, 'PATCH', { rule: draft.monitor }, 404);
    assert.equal(calls.length, count);
  } finally { child.kill(); await new Promise((resolve) => mock.close(resolve)); await rm(dataDir, { recursive: true, force: true }); }
});

test('旧规则可由 AI 转成新检测逻辑；循环提醒只改内容时保留时间与暂停状态', async () => {
  let reply;
  const mock = http.createServer(async (req, res) => {
    if (req.url === '/source') { res.end('<p>normal</p>'); return; }
    for await (const chunk of req) { /* consume */ }
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/hook' ? '{}' : JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  });
  const port = await listen(mock), dataDir = await mkdtemp(path.join(tmpdir(), 'radar-refine-legacy-'));
  const { base, child } = await startApp(dataDir);
  try {
    await request(base, '/api/settings', 'PUT', { aiBaseUrl: 'http://127.0.0.1:' + port, aiModel: 'test', aiKey: 'test-key', webhooks: [{ id: 'hook', name: '频道', url: 'http://127.0.0.1:' + port + '/hook' }] });
    const legacy = (await request(base, '/api/monitors', 'POST', { kind: 'webpage', label: '服务页面', url: 'http://127.0.0.1:' + port + '/source', intervalMinutes: 15, keyword: 'down', notification: { title: '服务异常', body: '保留文案：{{details}}' }, webhookIds: ['hook'] })).monitors[0];
    reply = { status: 'ready', monitor: { kind: 'generated', notification: { title: '新的标题' }, plan: { sourceType: 'service', mode: 'unavailable', initial: 'baseline', failureThreshold: 3 } } };
    const draft = await request(base, '/api/parse', 'POST', { monitorId: legacy.id, instruction: '改成访问失败3次后提醒' });
    const saved = await request(base, '/api/monitors/' + legacy.id, 'PATCH', { rule: draft.monitor, expectedRevision: 0 });
    assert.equal(saved.monitors[0].kind, 'generated');
    assert.equal(saved.monitors[0].id, legacy.id);
    assert.equal(saved.monitors[0].keyword, undefined);
    assert.equal(saved.monitors[0].label, legacy.label);
    assert.equal(saved.monitors[0].intervalMinutes, 15);
    assert.deepEqual(saved.monitors[0].notification, { title: '新的标题', body: '保留文案：{{details}}' });
    const remindAt = new Date(Date.now() + 86400123).toISOString();
    const reminder = (await request(base, '/api/monitors', 'POST', { kind: 'reminder', label: '休息', message: '休息一下', remindAt, repeatMinutes: 90, webhookIds: ['hook'] })).monitors[0];
    const paused = (await request(base, '/api/monitors/' + reminder.id, 'PATCH', { enabled: false })).monitors[0];
    reply = { status: 'ready', message: '只调整提醒内容。', monitor: { kind: 'reminder', message: '站起来走一走' } };
    const modified = await request(base, '/api/parse', 'POST', { monitorId: reminder.id, expectedRevision: paused.revision, instruction: '内容改成站起来走一走' });
    assert.equal(modified.monitor.remindAt, remindAt);
    assert.equal(modified.monitor.repeatMinutes, 90);
    const result = (await request(base, '/api/monitors/' + reminder.id, 'PATCH', { rule: modified.monitor, expectedRevision: paused.revision })).monitors.find((item) => item.id === reminder.id);
    assert.equal(result.enabled, false);
    assert.equal(result.remindAt, remindAt);
    assert.equal(result.message, '站起来走一走');
  } finally { child.kill(); await new Promise((resolve) => mock.close(resolve)); await rm(dataDir, { recursive: true, force: true }); }
});

test('保存纯自定义通知后，预览、模拟和正式发送均无固定地址；地址可插入、替换和删除', async () => {
  const messages = [];
  let stock = false;
  const mock = http.createServer(async (req, res) => {
    if (req.url === '/source') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ products: [{ name: '产品 A', available: stock }] })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    messages.push({ path: req.url, body, headers: req.headers });
    res.end('ok');
  });
  const port = await listen(mock), dataDir = await mkdtemp(path.join(tmpdir(), 'radar-editable-notification-'));
  const { base, child } = await startApp(dataDir);
  try {
    const source = 'http://127.0.0.1:' + port + '/source';
    await request(base, '/api/settings', 'PUT', { webhooks: [
      { id: 'ntfy', name: '手机', url: 'http://127.0.0.1:' + port + '/ntfy', format: 'ntfy' },
      { id: 'generic', name: '自定义接口', url: 'http://127.0.0.1:' + port + '/generic', format: 'generic' }
    ] });
    const monitor = (await request(base, '/api/monitors', 'POST', {
      kind: 'generated', label: '内部任务名称', url: source, intervalMinutes: 5, webhookIds: ['ntfy', 'generic'],
      plan: { sourceType: 'json', mode: 'any', initial: 'baseline', path: 'products', filters: [{ path: 'available', operator: 'equals', expected: true }] }
    })).monitors[0];
    const notification = { title: '', body: '仅发送我写的内容' };
    await request(base, '/api/monitors/' + monitor.id, 'PATCH', { rule: { notification } });
    const preview = await request(base, '/api/notification-preview', 'POST', { monitorId: monitor.id });
    assert.equal(preview.payload.title, '');
    assert.equal(preview.payload.message, notification.body);
    assert.equal(preview.payload.url, undefined);
    assert.equal(preview.channels.find(h => h.id === 'ntfy').headers['x-title'], undefined);
    assert.ok(preview.channels.every(h => !JSON.stringify(h.body).includes(source)));
    await request(base, '/api/notification-simulate', 'POST', { previewId: preview.id });
    assert.equal(messages.find(m => m.path === '/ntfy').body, notification.body);
    assert.equal(JSON.parse(messages.find(m => m.path === '/generic').body).text, '【模拟】\n' + notification.body);
    messages.length = 0;
    stock = true;
    const checked = await request(base, '/api/monitors/' + monitor.id + '/check', 'POST');
    assert.equal(checked.check.sentCount, 2);
    const ntfy = messages.find(m => m.path === '/ntfy'), generic = JSON.parse(messages.find(m => m.path === '/generic').body);
    assert.equal(ntfy.body, notification.body);
    assert.equal(ntfy.headers['x-title'], undefined);
    assert.equal(generic.text, notification.body);
    assert.equal(generic.url, undefined);
    assert.ok(messages.every(m => !m.body.includes(source)));
    for (const body of ['型号：{{items}}\n{{source}}', '型号：{{items}}\nhttps://example.com/buy', '型号：{{items}}']) {
      await request(base, '/api/monitors/' + monitor.id, 'PATCH', { rule: { notification: { title: '', body } } });
      const updated = await request(base, '/api/notification-preview', 'POST', { monitorId: monitor.id });
      assert.equal(updated.channels.find(h => h.id === 'ntfy').body, body.replace('{{items}}', '产品 A').replace('{{source}}', source));
    }
    const saved = (await request(base, '/api/state')).monitors[0];
    assert.equal(saved.url, source);
    assert.deepEqual(saved.notification, { title: '', body: '型号：{{items}}' });
    assert.deepEqual(saved.snapshot, checked.monitors[0].snapshot);
  } finally { child.kill(); await new Promise(resolve => mock.close(resolve)); await rm(dataDir, { recursive: true, force: true }); }
});

test('Cloudflare 验证保留有效状态、延迟重试；手动检查可恢复且不会误发库存通知', async () => {
  let challenge = false, stock = false;
  const deliveries = [];
  const source = http.createServer(async (req, res) => {
    if (req.url === '/stock') {
      if (challenge) { res.writeHead(200, { 'cf-mitigated': 'challenge', 'content-type': 'text/html', 'cf-ray': 'test-ray' }); res.end('<html><title>Just a moment</title><script>_cf_chl_opt={}</script>Buy now</html>'); }
      else { res.setHeader('content-type', 'text/html'); res.end(stock ? '<p>Buy now</p>' : '<p>Out of stock</p>'); }
      return;
    }
    let data = ''; for await (const part of req) data += part;
    deliveries.push(JSON.parse(data)); res.end('ok');
  });
  const port = await listen(source);
  const dir = await mkdtemp(path.join(tmpdir(), 'radar-cf-test-'));
  const { base, child } = await startApp(dir, { env: { MONITOR_BROWSER_ENABLED: '0' } });
  try {
    await request(base, '/api/settings', 'PUT', { webhooks: [{ id: 'hook', name: 'Hook', url: 'http://127.0.0.1:' + port + '/hook', format: 'generic' }] });
    const created = await request(base, '/api/monitors', 'POST', { kind: 'webpage', label: 'Stock', url: 'http://127.0.0.1:' + port + '/stock', keyword: 'Buy now', mode: 'contains', intervalMinutes: 5, fetch: { mode: 'http' }, webhookIds: ['hook'] });
    const id = created.monitors[0].id, before = created.monitors[0].snapshot;
    challenge = true;
    const failed = await request(base, '/api/monitors/' + id + '/check', 'POST');
    assert.equal(failed.check.checked, false);
    assert.equal(failed.check.errorCode, 'SOURCE_CHALLENGE');
    assert.deepEqual(failed.monitors[0].snapshot, before);
    assert.equal(failed.monitors[0].baselined, true);
    assert.ok(Date.parse(failed.monitors[0].sourceRetryAt) > Date.now());
    assert.equal(deliveries.length, 0);
    const raw = failed.logs.find((item) => item.kind === 'monitor' && item.status === 'error').raw;
    assert.equal(raw.fetch.cfRay, 'test-ray');
    assert.equal(raw.fetch.attempts[0].outcome, 'challenge');
    const again = await request(base, '/api/monitors/' + id + '/check', 'POST');
    assert.equal(again.monitors[0].sourceFailures, 2);
    challenge = false; stock = true;
    const recovered = await request(base, '/api/monitors/' + id + '/check', 'POST');
    assert.equal(recovered.check.sentCount, 1);
    assert.equal(recovered.monitors[0].sourceRetryAt, null);
    assert.equal(recovered.monitors[0].lastSourceError, '');
    assert.equal(deliveries.length, 1);
    const patched = await request(base, '/api/monitors/' + id, 'PATCH', { expectedRevision: recovered.monitors[0].revision, rule: { fetch: { mode: 'auto', proxy: 'direct' } } });
    assert.deepEqual(patched.monitors[0].snapshot, recovered.monitors[0].snapshot);
    assert.equal(deliveries.length, 1);
  } finally {
    child.kill(); source.closeAllConnections(); await new Promise((resolve) => source.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('账户代理覆盖监控与试跑，通知不走代理；公开状态和日志不泄露凭据', async () => {
  const proxyRequests = [], deliveries = [];
  const source = http.createServer(async (req, res) => {
    if (req.url === '/proxy-probe') { res.setHeader('content-type', 'application/json'); res.end('{"ip":"203.0.113.10"}'); return; }
    if (req.url === '/source') { res.setHeader('content-type', 'text/html'); res.end('<p>Buy now</p>'); return; }
    let data = ''; for await (const part of req) data += part; deliveries.push(data); res.end('ok');
  });
  const sourcePort = await listen(source);
  const proxy = http.createServer();
  const sockets = new Set();
  proxy.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (req, socket, head) => {
    proxyRequests.push({ target: req.url, auth: req.headers['proxy-authorization'] });
    const upstream = net.connect(sourcePort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  const dir = await mkdtemp(path.join(tmpdir(), 'radar-proxy-test-'));
  const { base, child } = await startApp(dir, { env: { MONITOR_PROXY_TEST_URL: 'http://127.0.0.1:' + sourcePort + '/proxy-probe' } });
  try {
    const proxyUrl = 'http://proxy-user:super-private-pass@127.0.0.1:' + proxyPort;
    const saved = await request(base, '/api/source-proxy', 'PUT', { proxyUrl });
    assert.equal(saved.settings.hasSourceProxy, true);
    assert.equal(saved.settings.sourceProxy, undefined);
    assert.equal(saved.settings.sourceProxyEndpoint, 'http://127.0.0.1:' + proxyPort);
    assert.equal(JSON.stringify(saved).includes('super-private-pass'), false);
    await request(base, '/api/settings', 'PUT', { webhooks: [{ id: 'hook', name: 'Hook', url: 'http://127.0.0.1:' + sourcePort + '/hook', format: 'generic' }] });
    assert.equal((await request(base, '/api/state')).settings.hasSourceProxy, true);
    const result = await request(base, '/api/source-proxy/test', 'POST', { targetUrl: 'http://127.0.0.1:' + sourcePort + '/source' });
    assert.equal(result.status, 200);
    assert.equal(proxyRequests[0].auth, 'Basic ' + Buffer.from('proxy-user:super-private-pass').toString('base64'));
    const created = await request(base, '/api/monitors', 'POST', { kind: 'webpage', label: 'Stock', url: 'http://127.0.0.1:' + sourcePort + '/source', keyword: 'Buy now', intervalMinutes: 5, webhookIds: ['hook'] });
    assert.equal(created.monitors[0].lastFetch.route, 'proxy');
    const monitorId = created.monitors[0].id, calls = proxyRequests.length;
    await request(base, '/api/monitors/' + monitorId + '/check', 'POST');
    assert.equal(proxyRequests.length, calls + 1);
    assert.equal(deliveries.length, 1);
    await request(base, '/api/monitors/' + monitorId, 'PATCH', { rule: { fetch: { mode: 'http', proxy: 'direct' } } });
    assert.equal(proxyRequests.length, calls + 1);
    assert.equal(JSON.stringify(await request(base, '/api/state')).includes('super-private-pass'), false);
    const aliceCookie = cookies.get(base);
    await request(base, '/api/auth/logout', 'POST');
    const bob = await request(base, '/api/auth/register', 'POST', { username: 'bob', password: 'another-long-password' });
    assert.equal(bob.settings.hasSourceProxy, false);
    assert.equal(bob.monitors.length, 0);
    cookies.set(base, aliceCookie);
    const cleared = await request(base, '/api/source-proxy', 'DELETE');
    assert.equal(cleared.settings.hasSourceProxy, false);
  } finally {
    child.kill(); source.closeAllConnections(); for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise((resolve) => source.close(resolve)), new Promise((resolve) => proxy.close(resolve))]);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('AI 连接测试修复完整地址斜杠，并保留脱敏原始响应与网络错误', async () => {
  const calls = [];
  let mode = 'success';
  const ai = http.createServer(async (req, res) => {
    if (req.url === '/proxy-probe') { res.setHeader('content-type', 'application/json'); res.end('{"ip":"203.0.113.10"}'); return; }
    calls.push({ url: req.url, authorization: req.headers.authorization });
    if (mode === 'reset') { req.socket.destroy(); return; }
    if (mode === 'provider') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid token ai-secret-for-regression' } })); return; }
    if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>upstream not ready</html>'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
  });
  const aiPort = await listen(ai);
  const proxy = await localMonitoringProxy(aiPort);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'radar-ai-connection-'));
  const { base, child } = await startApp(dataDir, { env: { MONITOR_PROXY_TEST_URL: 'http://127.0.0.1:' + aiPort + '/proxy-probe' } });
  try {
    await request(base, '/api/settings', 'PUT', { aiBaseUrl: 'http://127.0.0.1:' + aiPort + '/v1/chat/completions/', aiModel: 'example-model', aiKey: 'ai-secret-for-regression' });
    // A broken monitoring proxy must never change the AI request's route.
    await request(base, '/api/source-proxy', 'PUT', { proxyUrl: proxy.url });
    await proxy.stop();
    const report = await request(base, '/api/ai/test', 'POST', {});
    assert.equal(report.ok, true);
    assert.equal(calls[0].url, '/v1/chat/completions');
    assert.equal(calls[0].authorization, 'Bearer ai-secret-for-regression');
    let logs = (await request(base, '/api/logs')).logs;
    assert.equal(logs[0].raw.httpStatus, 200);
    assert.equal(logs[0].raw.requestId, report.requestId);
    assert.equal(JSON.parse(logs[0].raw.responseBody).choices[0].message.content, 'OK');
    for (const next of ['provider', 'html', 'reset']) {
      mode = next;
      const response = await fetch(base + '/api/ai/test', { method: 'POST', headers: { cookie: cookies.get(base), 'content-type': 'application/json', 'x-radar-request-id': 'regression-' + mode }, body: '{}' });
      assert.equal(response.status, 502);
      const failure = await response.json();
      assert.equal(failure.requestId, 'regression-' + mode);
      logs = (await request(base, '/api/logs')).logs;
      assert.equal(logs[0].raw.requestId, failure.requestId);
      assert.equal(JSON.stringify(logs).includes('ai-secret-for-regression'), false);
      assert.equal(JSON.stringify(failure).includes('ai-secret-for-regression'), false);
      if (next === 'provider') { assert.equal(failure.upstreamStatus, 401); assert.match(logs[0].raw.responseBody, /已隐藏的 API Key/); }
      if (next === 'html') { assert.match(failure.error, /不是 JSON/); assert.match(logs[0].raw.responseBody, /upstream not ready/); }
      if (next === 'reset') assert.ok(logs[0].raw.networkCode);
    }
  } finally {
    child.kill(); await proxy.stop(); ai.closeAllConnections(); await new Promise(resolve => ai.close(resolve));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('代理一键应用仅修改本账户网页任务并保留检测基线，代理凭据不回显', async () => {
  const source = http.createServer((req, res) => {
    if (req.url === '/proxy-probe') { res.setHeader('content-type', 'application/json'); res.end('{"ip":"203.0.113.10"}'); return; }
    res.end('no stock');
  });
  const port = await listen(source);
  const proxy = await localMonitoringProxy(port, 'apply-private-secret');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'radar-apply-proxy-'));
  const { base, child } = await startApp(dataDir, { env: { MONITOR_PROXY_TEST_URL: 'http://127.0.0.1:' + port + '/proxy-probe' } });
  try {
    await request(base, '/api/settings', 'PUT', { webhooks: [{ id: 'hook', name: '测试渠道', url: 'http://127.0.0.1:' + port + '/hook', enabled: true }] });
    const created = await request(base, '/api/monitors', 'POST', { kind: 'webpage', url: 'http://127.0.0.1:' + port, label: '普通任务', keyword: 'stock', mode: 'contains', intervalMinutes: 5, webhookIds: ['hook'], fetch: { mode: 'http', proxy: 'direct' } });
    const previous = created.monitors[0], aliceCookie = cookies.get(base);
    await request(base, '/api/auth/register', 'POST', { username: 'second-user', password: 'a-strong-password-123' });
    const bobCookie = cookies.get(base);
    await request(base, '/api/settings', 'PUT', { webhooks: [{ id: 'hook', name: '测试渠道', url: 'http://127.0.0.1:' + port + '/hook', enabled: true }] });
    const bobCreated = await request(base, '/api/monitors', 'POST', { kind: 'webpage', url: 'http://127.0.0.1:' + port, label: '其他账户任务', keyword: 'stock', mode: 'contains', intervalMinutes: 5, webhookIds: ['hook'], fetch: { mode: 'http', proxy: 'direct' } });
    cookies.set(base, aliceCookie);
    const saved = await request(base, '/api/source-proxy', 'PUT', { proxyUrl: proxy.url, applyAll: true });
    assert.equal(saved.settings.hasSourceProxy, true);
    assert.equal(saved.settings.sourceProxyEndpoint, proxy.endpoint);
    assert.equal(JSON.stringify(saved).includes('apply-private-secret'), false);
    assert.equal(saved.monitors[0].fetch.proxy, 'default');
    assert.equal(saved.monitors[0].fetch.mode, 'http');
    assert.deepEqual(saved.monitors[0].snapshot, previous.snapshot);
    assert.equal(saved.monitors[0].baselined, previous.baselined);
    assert.deepEqual(saved.monitors[0].pendingNotifications, previous.pendingNotifications);
    const again = await request(base, '/api/source-proxy', 'PUT', { applyAll: true });
    assert.equal(again.settings.hasSourceProxy, true);
    cookies.set(base, bobCookie);
    const bob = await request(base, '/api/state');
    assert.equal(bob.settings.hasSourceProxy, false);
    assert.deepEqual(bob.monitors[0].fetch, bobCreated.monitors[0].fetch);
    cookies.set(base, aliceCookie);
    assert.equal((await request(base, '/api/source-proxy', 'DELETE')).settings.hasSourceProxy, false);
  } finally {
    child.kill(); await proxy.stop(); source.closeAllConnections(); await new Promise(resolve => source.close(resolve));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
