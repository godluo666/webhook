import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function fixture(t) {
  const controls = { probe: null, source: null, aiRequests: [], received: [], reads: 0, stock: false, stockClass: 'stock', price: 300, health: 200, aiReply: null };
  const target = http.createServer(async (req, res) => {
    if (req.url === '/probe') {
      const pending = controls.probe;
      if (pending) { controls.probe = null; pending.started.resolve(); await pending.release.promise; }
      res.setHeader('content-type', 'application/json'); res.end('{"ip":"203.0.113.21"}'); return;
    }
    if (req.url === '/source') {
      const pending = controls.source;
      if (pending) { controls.source = null; pending.started.resolve(); await pending.release.promise; }
      controls.reads++;
      assert.equal(req.headers['proxy-authorization'], undefined);
      res.setHeader('content-type', 'text/html'); res.end('<p>Sold out</p>'); return;
    }
    if (req.url === '/product') {
      controls.reads++;
      assert.equal(req.headers['proxy-authorization'], undefined);
      res.setHeader('content-type', 'text/html');
      res.end('<h1>Switch</h1><main><span class="' + controls.stockClass + '">' + (controls.stock ? 'In Stock' : 'Sold Out') + '</span><span class="price">' + controls.price + '</span></main>'); return;
    }
    if (req.url === '/health') {
      controls.reads++;
      assert.equal(req.headers['proxy-authorization'], undefined);
      res.writeHead(controls.health); res.end('health'); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.url === '/v1/chat/completions') {
      controls.aiRequests.push(raw); res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(controls.aiReply || { status: 'ready', kind: 'generated', label: 'Revised rule', plan: { sourceType: 'html', mode: 'contains', keyword: 'Available', initial: 'baseline' } }) } }] })); return;
    }
    if (req.url === '/hook') { controls.received.push(raw); res.end('ok'); return; }
    res.writeHead(404); res.end();
  });
  const port = await listen(target), targetUrl = 'http://127.0.0.1:' + port;
  const proxies = [];
  async function makeProxy(label) {
    const sockets = new Set(), requests = [], server = http.createServer();
    const password = label + '-private-password';
    const token = 'Basic ' + Buffer.from(label + ':' + password).toString('base64');
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('connect', (req, socket, head) => {
      requests.push(req.url);
      if (req.headers['proxy-authorization'] !== token || req.url !== '127.0.0.1:' + port) {
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return;
      }
      const upstream = net.connect(port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.once('close', () => upstream.destroy());
    });
    const proxyPort = await listen(server);
    const proxy = { url: 'http://' + label + ':' + password + '@127.0.0.1:' + proxyPort, endpoint: 'http://127.0.0.1:' + proxyPort, password, token, requests, server, sockets };
    proxies.push(proxy); return proxy;
  }
  const temp = await mkdtemp(path.join(tmpdir(), 'radar-monitor-proxy-'));
  const reservation = http.createServer(), appPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DATA_DIR: temp, RESEND_API_KEY: '', MAIL_FROM: '', SIGNUP_CODE: '', MONITOR_PROXY_TEST_URL: targetUrl + '/probe' }, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + appPort;
  t.after(async () => {
    controls.probe?.release.resolve(); controls.source?.release.resolve();
    const exited = once(child, 'exit'); child.kill(); await exited;
    for (const proxy of proxies) { for (const socket of proxy.sockets) socket.destroy(); await new Promise(resolve => proxy.server.close(resolve)); }
    target.closeAllConnections(); await new Promise(resolve => target.close(resolve));
    const resolved = path.resolve(temp);
    assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('radar-monitor-proxy-'));
    await rm(resolved, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { if (attempt === 99) throw Error('Application did not start'); } await delay(40); }
  const cookies = new Map();
  async function request(user, endpoint, method = 'GET', body, expectedStatus = 200) {
    const response = await fetch(base + endpoint, { method, headers: { cookie: cookies.get(user) || '', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.has('set-cookie')) cookies.set(user, response.headers.get('set-cookie').split(';')[0]);
    const data = await response.json(); assert.equal(response.status, expectedStatus, JSON.stringify(data)); return data;
  }
  await request('alice', '/api/auth/register', 'POST', { username: 'alice', password: 'test-password-123' }, 201);
  await request('bob', '/api/auth/register', 'POST', { username: 'bob', password: 'test-password-123' }, 201);
  const hook = { id: 'hook', name: 'Primary', url: targetUrl + '/hook', format: 'generic', enabled: true };
  await request('alice', '/api/settings', 'PUT', { webhooks: [hook], aiBaseUrl: targetUrl + '/v1', aiModel: 'test-model', aiKey: 'test-key' });
  const rule = { kind: 'webpage', label: 'Stock', url: targetUrl + '/source', keyword: 'Available', mode: 'contains', intervalMinutes: 5, fetch: { mode: 'http', proxy: 'default' }, webhookIds: ['hook'] };
  return { request, targetUrl, controls, makeProxy, rule, temp };
}
function privateFree(data, proxies) {
  const text = JSON.stringify(data);
  for (const proxy of proxies) for (const secret of [proxy.url, proxy.password, proxy.token.slice(6)]) assert.equal(text.includes(secret), false, 'Private proxy material must not appear publicly');
}

test('每任务独立出口覆盖账户代理，默认/直接连接可共存，账户更新不覆盖独立任务', async t => {
  const f = await fixture(t), a = await f.makeProxy('account-a'), b = await f.makeProxy('rule-b'), c = await f.makeProxy('account-c');
  await f.request('alice', '/api/source-proxy', 'PUT', { proxyUrl: a.url });
  const inherited = (await f.request('alice', '/api/monitors', 'POST', f.rule, 201)).monitors[0];
  const direct = (await f.request('alice', '/api/monitors', 'POST', { ...f.rule, label: 'Direct', fetch: { mode: 'http', proxy: 'direct' } }, 201)).monitors[0];
  const custom = (await f.request('alice', '/api/monitors', 'POST', { ...f.rule, label: 'Custom', fetch: { mode: 'http', proxy: 'custom' }, sourceProxy: b.url }, 201)).monitors[0];
  assert.equal(custom.fetch.proxy, 'custom'); assert.equal(custom.hasSourceProxy, true); assert.equal(custom.sourceProxyEndpoint, b.endpoint); assert.equal(custom.sourceProxyTest.ip, '203.0.113.21'); assert.equal(custom.sourceProxy, undefined);
  assert.equal(a.requests.length, 2); assert.equal(b.requests.length, 2);
  const before = { a: a.requests.length, b: b.requests.length };
  await f.request('alice', '/api/monitors/' + inherited.id + '/check', 'POST');
  await f.request('alice', '/api/monitors/' + direct.id + '/check', 'POST');
  await f.request('alice', '/api/monitors/' + custom.id + '/check', 'POST');
  assert.equal(a.requests.length, before.a + 1); assert.equal(b.requests.length, before.b + 1);
  const current = (await f.request('alice', '/api/state')).monitors.find(m => m.id === custom.id);
  const applied = await f.request('alice', '/api/source-proxy', 'PUT', { proxyUrl: c.url, applyAll: true });
  assert.deepEqual(applied.monitors.find(m => m.id === custom.id), current);
  assert.equal(applied.monitors.find(m => m.id === direct.id).fetch.proxy, 'direct');
  await f.request('alice', '/api/source-proxy', 'DELETE');
  const last = b.requests.length;
  const checked = await f.request('alice', '/api/monitors/' + custom.id + '/check', 'POST');
  assert.equal(b.requests.length, last + 1);
  privateFree(checked, [a, b, c]);
  const saved = JSON.parse(await readFile(path.join(f.temp, 'state.json'), 'utf8'));
  assert.equal(saved.users.find(u => u.username === 'alice').monitors.find(m => m.id === custom.id).sourceProxy, b.url + '/');
  assert.equal((await f.request('bob', '/api/state')).monitors.length, 0);
  await f.request('bob', '/api/monitors/' + custom.id, 'PATCH', { rule: { label: 'Hijacked' } }, 404);
});

test('独立代理失败不创建或破坏规则；切换出口保留基线，可明确清除私有节点', async t => {
  const f = await fixture(t), b = await f.makeProxy('rule-b');
  const bad = b.url.replace(b.password, 'incorrect-authentication');
  await f.request('alice', '/api/monitors', 'POST', { ...f.rule, fetch: { mode: 'http', proxy: 'custom' }, sourceProxy: bad }, 400);
  assert.equal((await f.request('alice', '/api/state')).monitors.length, 0);
  const custom = (await f.request('alice', '/api/monitors', 'POST', { ...f.rule, fetch: { mode: 'http', proxy: 'custom' }, sourceProxy: b.url }, 201)).monitors[0];
  await f.request('alice', '/api/monitors/' + custom.id, 'PATCH', { rule: { sourceProxy: bad }, expectedRevision: custom.revision || 0 }, 400);
  assert.deepEqual((await f.request('alice', '/api/state')).monitors[0], custom);
  await f.request('alice', '/api/monitors/' + custom.id, 'PATCH', { rule: { sourceProxy: null } }, 400);
  const direct = (await f.request('alice', '/api/monitors/' + custom.id, 'PATCH', { rule: { fetch: { mode: 'http', proxy: 'direct' } } })).monitors[0];
  assert.equal(direct.hasSourceProxy, true); assert.equal(direct.sourceProxyEndpoint, b.endpoint); assert.deepEqual(direct.snapshot, custom.snapshot); assert.equal(direct.baselined, true);
  const restored = (await f.request('alice', '/api/monitors/' + custom.id, 'PATCH', { rule: { fetch: { mode: 'http', proxy: 'custom' }, sourceProxy: '' } })).monitors[0];
  assert.equal(restored.fetch.proxy, 'custom'); assert.equal(restored.hasSourceProxy, true);
  const cleared = (await f.request('alice', '/api/monitors/' + custom.id, 'PATCH', { rule: { fetch: { mode: 'http', proxy: 'direct' }, sourceProxy: null } })).monitors[0];
  assert.equal(cleared.hasSourceProxy, false); assert.equal(cleared.sourceProxyTest, null);
  const missing = await f.request('alice', '/api/monitors/' + custom.id, 'PATCH', { rule: { fetch: { mode: 'http', proxy: 'custom' } } }, 400);
  assert.equal(missing.code, 'SOURCE_PROXY_MISSING');
  await f.request('alice', '/api/monitors', 'POST', { kind: 'reminder', label: 'Meeting', message: 'Meeting now', remindAt: new Date(Date.now() + 3600000).toISOString(), fetch: { mode: 'http', proxy: 'custom' }, sourceProxy: b.url, webhookIds: ['hook'] }, 400);
  await f.request('alice', '/api/monitors', 'POST', { ...f.rule, kind: 'generated', plan: { sourceType: 'service', mode: 'unavailable', initial: 'baseline' }, fetch: { mode: 'http', proxy: 'custom' }, sourceProxy: b.url }, 201);
  privateFree(await f.request('alice', '/api/state'), [b]);
});

test('来源试跑与 AI 修改使用任务独立代理，但模型、预览、通知和日志不接收凭据', async t => {
  const f = await fixture(t), a = await f.makeProxy('account-a'), b = await f.makeProxy('rule-b');
  await f.request('alice', '/api/source-proxy', 'PUT', { proxyUrl: a.url });
  const custom = (await f.request('alice', '/api/monitors', 'POST', { ...f.rule, fetch: { mode: 'http', proxy: 'custom' }, sourceProxy: b.url }, 201)).monitors[0];
  const tested = await f.request('alice', '/api/source-proxy/test', 'POST', { monitorId: custom.id });
  assert.equal(tested.endpoint, b.endpoint); privateFree(tested, [a, b]);
  await f.request('bob', '/api/source-proxy/test', 'POST', { monitorId: custom.id, proxyUrl: a.url }, 404);
  const ordinary = (await f.request('alice', '/api/monitors', 'POST', f.rule, 201)).monitors[0];
  await f.request('alice', '/api/source-proxy/test', 'POST', { monitorId: ordinary.id }, 400);
  const count = b.requests.length;
  const preview = await f.request('alice', '/api/preview-check', 'POST', { ...custom, monitorId: custom.id, expectedRevision: custom.revision || 0 });
  assert.equal(preview.fetch.route, 'proxy'); assert.equal(b.requests.length, count + 2);
  await f.request('bob', '/api/preview-check', 'POST', { ...custom, monitorId: custom.id }, 404);
  await f.request('alice', '/api/preview-check', 'POST', { ...f.rule, fetch: { mode: 'http', proxy: 'custom' } }, 400);
  const before = b.requests.length, accountBefore = a.requests.length;
  const parsed = await f.request('alice', '/api/parse', 'POST', { monitorId: custom.id, instruction: 'Change the label and keep everything else' });
  assert.equal(parsed.monitor.fetch.proxy, 'custom');
  assert.equal(parsed.monitor.hasSourceProxy, true); assert.equal(parsed.monitor.sourceProxyEndpoint, b.endpoint); assert.equal(parsed.monitor.sourceProxy, undefined);
  assert.equal(b.requests.length, before + 1); assert.equal(a.requests.length, accountBefore);
  privateFree(f.controls.aiRequests, [a, b]);
  privateFree(parsed, [a, b]); privateFree(preview, [a, b]);
  const notification = await f.request('alice', '/api/notification-preview', 'POST', { monitorId: custom.id, rule: { notification: { title: 'Custom title', body: 'User text only' } } });
  await f.request('alice', '/api/notification-simulate', 'POST', { previewId: notification.id });
  privateFree(notification, [a, b]); privateFree(f.controls.received, [a, b]); privateFree(await f.request('alice', '/api/state'), [a, b]);
});

test('独立代理验证等待期间的修改、正在检查和删除均阻止过期保存', async t => {
  const f = await fixture(t), b = await f.makeProxy('rule-b'), c = await f.makeProxy('candidate-c');
  const custom = (await f.request('alice', '/api/monitors', 'POST', { ...f.rule, fetch: { mode: 'http', proxy: 'custom' }, sourceProxy: b.url }, 201)).monitors[0];
  const first = { started: gate(), release: gate() }; f.controls.probe = first;
  const stale = f.request('alice', '/api/monitors/' + custom.id, 'PATCH', { rule: { sourceProxy: c.url }, expectedRevision: 0 }, 409);
  await first.started.promise;
  const renamed = await f.request('alice', '/api/monitors/' + custom.id, 'PATCH', { rule: { label: 'Kept newer label' }, expectedRevision: 0 });
  first.release.resolve();
  assert.equal((await stale).code, 'MONITOR_CHANGED');
  assert.deepEqual((await f.request('alice', '/api/state')).monitors[0], renamed.monitors[0]);
  const second = { started: gate(), release: gate() }, reading = { started: gate(), release: gate() }; f.controls.probe = second;
  const busy = f.request('alice', '/api/monitors/' + custom.id, 'PATCH', { rule: { sourceProxy: c.url }, expectedRevision: renamed.monitors[0].revision }, 409);
  await second.started.promise;
  f.controls.source = reading;
  const check = f.request('alice', '/api/monitors/' + custom.id + '/check', 'POST');
  await reading.started.promise;
  second.release.resolve();
  assert.equal((await busy).code, 'MONITOR_BUSY');
  reading.release.resolve(); await check;
  const third = { started: gate(), release: gate() }; f.controls.probe = third;
  const deleted = f.request('alice', '/api/monitors/' + custom.id, 'PATCH', { rule: { sourceProxy: c.url } }, 404);
  await third.started.promise;
  assert.equal((await f.request('alice', '/api/monitors/' + custom.id, 'DELETE')).monitors.length, 0);
  third.release.resolve(); await deleted;
  assert.equal((await f.request('alice', '/api/state')).monitors.length, 0);
});


test('统一库存与价格规则各用独立出口；AI修改、修复和账户设置不会串用代理', async t => {
  const f = await fixture(t), a = await f.makeProxy('stock-a'), b = await f.makeProxy('price-b'), c = await f.makeProxy('account-c');
  await f.request('alice', '/api/source-proxy', 'PUT', { proxyUrl: c.url });
  async function create(type, proxy, condition) {
    const parsed = await f.request('alice', '/api/analyze', 'POST', { type, url: f.targetUrl + '/product', condition, rule: { fetch: { mode: 'http', proxy: 'custom' }, sourceProxy: proxy.url } });
    assert.equal(parsed.monitor.last_test_result.passed, true);
    return (await f.request('alice', '/api/monitors', 'POST', { ...parsed.monitor, sourceProxy: proxy.url, webhookIds: ['hook'] }, 201)).monitors[0];
  }
  const stock = await create('product_stock', a);
  const price = await create('price_change', b, { operator: 'lt', value: 250 });
  const accountReads = c.requests.length;
  let stockReads = a.requests.length, priceReads = b.requests.length;
  await f.request('alice', '/api/monitors/' + stock.id + '/check', 'POST');
  assert.equal(a.requests.length, stockReads + 1); assert.equal(b.requests.length, priceReads); assert.equal(c.requests.length, accountReads);
  stockReads = a.requests.length;
  f.controls.aiReply = { status: 'ready', goal: { type: 'price_change', condition: { operator: 'lt', value: 200 } }, fetch: { mode: 'http', proxy: 'default' } };
  const revised = await f.request('alice', '/api/parse', 'POST', { monitorId: price.id, instruction: '改成低于200提醒' });
  assert.equal(revised.monitor.fetch.proxy, 'custom'); assert.equal(revised.monitor.sourceProxyEndpoint, b.endpoint);
  assert.ok(b.requests.length > priceReads); assert.equal(a.requests.length, stockReads); assert.equal(c.requests.length, accountReads);
  const updated = (await f.request('alice', '/api/monitors/' + price.id, 'PATCH', { rule: revised.monitor, expectedRevision: price.revision || 0 })).monitors.find(m => m.id === price.id);
  assert.equal(updated.sourceProxyEndpoint, b.endpoint);
  f.controls.stockClass = 'inventory-status';
  const broken = await f.request('alice', '/api/monitors/' + stock.id + '/check', 'POST');
  const proposal = broken.monitors.find(m => m.id === stock.id).repair_suggestion;
  assert.equal(proposal.rule.fetch.proxy, 'custom');
  const repaired = await f.request('alice', '/api/monitors/' + stock.id, 'PATCH', { rule: proposal.rule, expectedRevision: proposal.revision });
  assert.equal(repaired.monitors.find(m => m.id === stock.id).sourceProxyEndpoint, a.endpoint);
  await f.request('alice', '/api/source-proxy', 'DELETE');
  stockReads = a.requests.length; priceReads = b.requests.length;
  f.controls.stock = true; f.controls.price = 199;
  await f.request('alice', '/api/monitors/' + stock.id + '/check', 'POST');
  await f.request('alice', '/api/monitors/' + price.id + '/check', 'POST');
  assert.equal(a.requests.length, stockReads + 1); assert.equal(b.requests.length, priceReads + 1);
  assert.equal(f.controls.received.length, 2);
  privateFree(await f.request('alice', '/api/state'), [a, b, c]);
  privateFree(f.controls.aiRequests, [a, b, c]);
});

test('统一接口、旧HTTP服务和TCP服务均使用各自代理，接口异常仍可正常推送', async t => {
  const f = await fixture(t), a = await f.makeProxy('api-a'), b = await f.makeProxy('service-b'), c = await f.makeProxy('account-c');
  await f.request('alice', '/api/source-proxy', 'PUT', { proxyUrl: c.url });
  const native = (await f.request('alice', '/api/monitors', 'POST', {
    kind: 'unified', type: 'api_monitor', name: 'API health', url: f.targetUrl + '/health', detection_method: 'api',
    target_element: { label: '接口状态' }, extraction_rule: { kind: 'service' }, condition: { operator: 'unavailable', failure_threshold: 2 }, interval: 300,
    fetch: { mode: 'http', proxy: 'custom' }, sourceProxy: a.url, webhookIds: ['hook']
  }, 201)).monitors[0];
  const legacy = (await f.request('alice', '/api/monitors', 'POST', {
    ...f.rule, kind: 'generated', label: 'HTTP service', url: f.targetUrl + '/health',
    plan: { sourceType: 'service', mode: 'unavailable', initial: 'baseline' }, fetch: { mode: 'http', proxy: 'custom' }, sourceProxy: b.url
  }, 201)).monitors[0];
  const tcp = (await f.request('alice', '/api/monitors', 'POST', {
    ...f.rule, kind: 'generated', label: 'TCP service', url: f.targetUrl.replace('http:', 'tcp:'),
    plan: { sourceType: 'service', mode: 'unavailable', initial: 'baseline' }, fetch: { mode: 'http', proxy: 'custom' }, sourceProxy: b.url
  }, 201)).monitors[0];
  assert.equal(native.snapshot.healthy, true); assert.equal(native.lastFetch.route, 'proxy');
  assert.equal(legacy.snapshot.healthy, true); assert.equal(tcp.snapshot.healthy, true);
  assert.equal(tcp.lastFetch.method, 'tcp'); assert.equal(tcp.lastFetch.route, 'proxy');
  const ac = a.requests.length, bc = b.requests.length, cc = c.requests.length;
  const preview = await f.request('alice', '/api/preview-check', 'POST', { ...native, monitorId: native.id });
  assert.equal(preview.fetch.route, 'proxy'); assert.equal(preview.healthy, true);
  assert.equal(a.requests.length, ac + 2); assert.equal(b.requests.length, bc); assert.equal(c.requests.length, cc);
  await f.request('alice', '/api/monitors/' + tcp.id + '/check', 'POST');
  assert.equal(b.requests.length, bc + 1); assert.equal(c.requests.length, cc);
  f.controls.health = 500;
  await f.request('alice', '/api/monitors/' + native.id + '/check', 'POST');
  assert.equal(f.controls.received.length, 0);
  await f.request('alice', '/api/monitors/' + native.id + '/check', 'POST');
  assert.equal(f.controls.received.length, 1);
  const direct = (await f.request('alice', '/api/monitors/' + legacy.id, 'PATCH', { rule: { fetch: { mode: 'http', proxy: 'direct' } } })).monitors.find(m => m.id === legacy.id);
  const afterB = b.requests.length;
  await f.request('alice', '/api/monitors/' + direct.id + '/check', 'POST');
  assert.equal(b.requests.length, afterB);
  privateFree(await f.request('alice', '/api/state'), [a, b, c]);
  privateFree(f.controls.received, [a, b, c]);
});

test('统一规则更换私有出口先验证目标；仅改代理保留检测基线，草稿代理仅发送给后端', async t => {
  const f = await fixture(t), b = await f.makeProxy('rule-b'), c = await f.makeProxy('candidate-c');
  const analyzed = await f.request('alice', '/api/analyze', 'POST', { type: 'price_change', url: f.targetUrl + '/product', condition: { operator: 'lt', value: 200 }, rule: { fetch: { mode: 'http', proxy: 'custom' }, sourceProxy: b.url } });
  const old = (await f.request('alice', '/api/monitors', 'POST', { ...analyzed.monitor, sourceProxy: b.url, webhookIds: ['hook'] }, 201)).monitors[0];
  f.controls.aiReply = { status: 'ready', goal: { type: 'price_change', name: '新名字' } };
  const beforeB = b.requests.length, beforeC = c.requests.length;
  const parsed = await f.request('alice', '/api/parse', 'POST', { monitorId: old.id, instruction: '只修改名称', draft: old, sourceProxy: c.url });
  assert.ok(c.requests.length > beforeC); assert.equal(b.requests.length, beforeB);
  assert.equal(parsed.monitor.sourceProxyEndpoint, c.endpoint);
  privateFree(parsed, [b, c]); privateFree(f.controls.aiRequests, [b, c]);
  f.controls.price = 'Loading';
  await f.request('alice', '/api/monitors/' + old.id, 'PATCH', { rule: { sourceProxy: c.url }, expectedRevision: old.revision || 0 }, 400);
  assert.deepEqual((await f.request('alice', '/api/state')).monitors[0], old);
  f.controls.price = 300;
  const changed = (await f.request('alice', '/api/monitors/' + old.id, 'PATCH', { rule: { sourceProxy: c.url }, expectedRevision: old.revision || 0 })).monitors[0];
  assert.deepEqual(changed.snapshot, old.snapshot); assert.equal(changed.lastCheckAt, old.lastCheckAt);
  assert.equal(changed.sourceProxyEndpoint, c.endpoint); assert.equal(changed.last_test_result.passed, true);
  const originalExtraction = changed.extraction_rule;
  await f.request('alice', '/api/monitors/' + old.id, 'PATCH', { rule: { extraction_rule: { ...originalExtraction, kind: 'number', attribute: 'data-missing' } } }, 400);
  assert.deepEqual((await f.request('alice', '/api/state')).monitors[0], changed);
  const direct = (await f.request('alice', '/api/monitors/' + old.id, 'PATCH', { rule: { fetch: { mode: 'http', proxy: 'direct' } } })).monitors[0];
  assert.deepEqual(direct.snapshot, changed.snapshot); assert.equal(direct.lastCheckAt, changed.lastCheckAt);
  privateFree(await f.request('alice', '/api/logs'), [b, c]);
});


test('创建前选择的独立代理贯穿AI页面分析、候选验证与保存，不发送凭据给模型', async t => {
  const f = await fixture(t), a = await f.makeProxy('account-a'), b = await f.makeProxy('new-rule-b');
  await f.request('alice', '/api/source-proxy', 'PUT', { proxyUrl: a.url });
  f.controls.aiReply = { status: 'ready', goal: { type: 'product_stock', condition: { operator: 'transition' } } };
  const count = a.requests.length;
  const parsed = await f.request('alice', '/api/parse', 'POST', { instruction: '商品库存补货提醒', sourceUrl: f.targetUrl + '/product', fetch: { mode: 'http', proxy: 'custom' }, sourceProxy: b.url });
  assert.equal(parsed.monitor.fetch.proxy, 'custom'); assert.equal(parsed.monitor.sourceProxyEndpoint, b.endpoint);
  assert.equal(parsed.monitor.last_test_result.passed, true);
  assert.equal(a.requests.length, count); assert.ok(b.requests.length >= 3);
  const saved = (await f.request('alice', '/api/monitors', 'POST', { ...parsed.monitor, sourceProxy: b.url, webhookIds: ['hook'] }, 201)).monitors[0];
  assert.equal(saved.sourceProxyEndpoint, b.endpoint);
  const before = b.requests.length;
  await f.request('alice', '/api/monitors/' + saved.id + '/check', 'POST');
  assert.equal(b.requests.length, before + 1); assert.equal(a.requests.length, count);
  privateFree(f.controls.aiRequests, [a, b]); privateFree(await f.request('alice', '/api/state'), [a, b]);
});
