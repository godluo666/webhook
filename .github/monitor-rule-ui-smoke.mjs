import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const choose = async (field, value) => field.locator('..').locator('.choice-control [data-choice-value="' + value + '"]').click();
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const root = process.cwd(), dataDir = await fs.mkdtemp(path.join(tmpdir(), 'radar-rule-ui-'));
const errors = [], notifications = [], proxies = [], aiRequests = [];
let stock = false, stockClass = 'stock', modelCounts = [0,0,0,0,0];
const mock = http.createServer(async (req, res) => {
  assert.equal(req.headers['proxy-authorization'], undefined);
  if (req.url === '/proxy-probe') { res.setHeader('content-type', 'application/json'); res.end('{"ip":"203.0.113.43"}'); return; }
  if (req.url === '/models') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<html lang="en"><body><h1>TRI</h1><main id="products">' + ['Basic','Core','Pro','Elite','Ultra'].map((name,i) => '<article class="product" id="product' + i + '"><h3>TRI.' + name + '</h3><a href="/cart.php?a=add&pid=' + i + '">Order Now</a><small class="qty">' + modelCounts[i] + ' Available</small></article>').join('') + '</main></body></html>'); return;
  }
  if (req.url === '/health') { res.end('healthy'); return; }
  if (req.url === '/dynamic-product') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<h1>Dynamic Product</h1><main id="product"></main><script>fetch("/stock-api").then(r=>r.json()).then(data=>{document.querySelector("#product").innerHTML="<button id=dynamic-buy>"+(data.product.available?"Add To Cart":"Sold Out")+"</button>"})</script>');
    return;
  }
  if (req.url === '/stock-api') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ product: { name: 'Dynamic Product', available: stock, price: 199 } })); return; }
  if (req.url === '/product') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<h1>Nintendo Switch</h1><main><span class="' + stockClass + '">' + (stock ? 'In Stock' : 'Sold Out') + '</span><p>当前价格：<span class="price">￥300</span></p></main>');
    return;
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url === '/hook') { notifications.push(JSON.parse(raw)); res.end('ok'); return; }
  aiRequests.push(raw);
  const input = JSON.parse(raw || '{}');
  const users = (input.messages || []).filter(m => m.role === 'user').map(m => m.content).join(' ');
  const goal = /价格|低于/.test(users) ? { type: 'price_change', condition: { operator: 'lt', value: /200/.test(users) ? 200 : 300 } } : { type: 'product_stock', condition: { operator: 'transition' } };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'ready', message: '已根据真实页面拟定监控并测试。', goal }) } }] }));
});
async function makeProxy(label, mockPort) {
  const password = label + '-private-password', token = 'Basic ' + Buffer.from(label + ':' + password).toString('base64');
  const requests = [], sockets = new Set();
  const server = http.createServer((req, res) => {
    const target = new URL(req.url);
    if (req.headers['proxy-authorization'] !== token || target.hostname !== '127.0.0.1' || Number(target.port) !== mockPort) { res.writeHead(407, { 'proxy-authenticate': 'Basic realm="rule-smoke"' }); res.end(); return; }
    requests.push(target.pathname);
    const headers = { ...req.headers }; delete headers['proxy-authorization'];
    const upstream = http.request({ hostname: '127.0.0.1', port: mockPort, method: req.method, path: target.pathname + target.search, headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.on('connect', (req, socket, head) => {
    if (req.headers['proxy-authorization'] !== token || req.url !== '127.0.0.1:' + mockPort) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="rule-smoke"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
    requests.push(req.url);
    const upstream = net.connect(mockPort, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
    sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.once('close', () => upstream.destroy());
  });
  const port = await listen(server);
  const proxy = { url: 'http://' + label + ':' + password + '@127.0.0.1:' + port, endpoint: 'http://127.0.0.1:' + port, password, requests, server, sockets };
  proxies.push(proxy); return proxy;
}
let child, browser;
try {
  const mockPort = await listen(mock), sourceUrl = 'http://127.0.0.1:' + mockPort;
  const proxyA = await makeProxy('rule-a', mockPort), proxyB = await makeProxy('rule-b', mockPort);
  const reserved = http.createServer(), port = await listen(reserved);
  await new Promise(resolve => reserved.close(resolve));
  child = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, DATA_DIR: dataDir, MONITOR_PROXY_TEST_URL: sourceUrl + '/proxy-probe', PORT: String(port), HOST: '127.0.0.1', MONITOR_BROWSER_ENABLED: '1', MONITOR_BROWSER_EXECUTABLE: process.env.UI_BROWSER_EXECUTABLE || process.env.MONITOR_BROWSER_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : '/usr/bin/chromium'), RESEND_API_KEY: '', MAIL_FROM: '', SIGNUP_CODE: '' } });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
  const paths = [process.env.UI_BROWSER_EXECUTABLE, process.env.MONITOR_BROWSER_EXECUTABLE, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].filter(Boolean);
  let executablePath;
  for (const candidate of paths) { try { await fs.access(candidate); executablePath = candidate; break; } catch {} }
  if (!executablePath) throw new Error('UI smoke requires a local Chromium browser');
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const register = await context.request.post(base + '/api/auth/register', { data: { username: 'rule-ui-user', password: 'rule-ui-password-123' } });
  assert.equal(register.status(), 201);
  const configure = await context.request.put(base + '/api/settings', { data: { aiKey: 'fixture-key', aiModel: 'test', aiBaseUrl: sourceUrl + '/v1', webhooks: [{ id: 'hook', name: '我的通知', url: sourceUrl + '/hook', format: 'generic', enabled: true }] } });
  assert.equal(configure.status(), 200);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/#create');
  await page.locator('[data-monitor-type="product_stock"]').click();
  await page.locator('#instruction-url').fill(sourceUrl + '/product');
  await choose(page.locator('#create-proxy-mode'), 'custom');
  await page.locator('#create-source-proxy').fill(proxyA.url);
  await page.locator('#parse-button').click();
  await page.locator('#preview .rule-evidence').first().waitFor();
  await page.waitForFunction(() => document.querySelector('#preview-result')?.textContent.includes('成功') || document.querySelector('#preview-result')?.textContent.includes('当前库存'));
  assert.match(await page.locator('#preview').innerText(), /无货/);
  assert.match(await page.locator('#preview').innerText(), /依据评分/);
  assert.match(await page.locator('#preview .draft-evidence .rule-validation h4').innerText(), /场景验证/);
  await page.locator('#create-button').click();
  await page.locator('.monitor-item').first().waitFor();
  let state = await (await context.request.get(base + '/api/state')).json();
  const stockId = state.monitors[0].id;
  assert.equal(state.monitors[0].type, 'product_stock');
  assert.equal(state.monitors[0].interval, 30);
  assert.equal(state.monitors[0].sourceProxyEndpoint, proxyA.endpoint);
  assert.match(await page.locator('.monitor-source-route').first().innerText(), /独立代理/);
  await page.locator('[data-action="edit"][data-id="' + stockId + '"]').click();
  await page.locator('.monitor-route .edit-interval').first().fill('10');
  await page.locator('[data-action="save-rule"]').first().click();
  await page.waitForFunction(() => document.querySelector('.monitor-meta')?.textContent.includes('10 秒'));
  state = await (await context.request.get(base + '/api/state')).json();
  assert.equal(state.monitors[0].id, stockId);
  assert.equal(state.monitors[0].interval, 10);
  console.log('PASS desktop create, verified preview, simple interval edit');

  await page.goto(base + '/#create');
  await page.locator('[data-monitor-type="price_change"]').click();
  await page.locator('#instruction-url').fill(sourceUrl + '/product');
  await choose(page.locator('#create-proxy-mode'), 'custom');
  await page.locator('#create-source-proxy').fill(proxyB.url);
  await page.locator('#parse-button').click();
  await page.locator('#preview .rule-evidence').first().waitFor();
  await page.locator('#preview [data-rule-pick]').click();
  await page.locator('.picker-status').filter({ hasText: '页面已加载' }).waitFor();
  await page.locator('.picker-count').filter({ hasText: '已选 1 个区域' }).waitFor();
  await page.frameLocator('.element-frame').locator('.price').click();
  assert.equal(await page.locator('[data-picker-confirm]').isDisabled(), true);
  await page.frameLocator('.element-frame').locator('.price').click();
  await page.locator('[data-picker-confirm]').click();
  await page.waitForFunction(() => !document.querySelector('.rule-dialog'));
  assert.equal(await page.locator('#preview [data-unified-key="condition.operator"]').inputValue(), 'changed');
  await choose(page.locator('#preview [data-unified-key="condition.operator"]'), 'lt');
  await page.locator('#preview [data-unified-key="condition.value"]').fill('200');
  await page.locator('#create-button').click();
  await page.waitForFunction(() => document.querySelectorAll('.monitor-item').length === 2);
  state = await (await context.request.get(base + '/api/state')).json();
  assert.equal(state.monitors[0].type, 'price_change');
  assert.equal(state.monitors[0].condition.value, 200);
  assert.equal(state.monitors[0].sourceProxyEndpoint, proxyB.endpoint);
  assert.ok(state.monitors[0].target_element.xpath);
  console.log('PASS element selection, price threshold edit, save canonical rule');

  stockClass = 'inventory-status';
  await context.request.post(base + '/api/monitors/' + stockId + '/check');
  await page.reload();
  await page.locator('[data-action="edit"][data-id="' + stockId + '"]').click();
  await page.locator('[data-action="rule-repair"][data-id="' + stockId + '"]').click();
  await page.locator('[data-repair-apply]').waitFor();
  await page.locator('[data-repair-apply]').click();
  await page.waitForFunction(() => !document.querySelector('.rule-dialog'));
  state = await (await context.request.get(base + '/api/state')).json();
  assert.equal(state.monitors.find(m => m.id === stockId).status, 'active');
  await page.locator('[data-action="rule-logs"][data-id="' + stockId + '"]').click();
  await page.locator('.check-record').first().waitFor();
  assert.match(await page.locator('.task-records').innerText(), /检测|当前|库存/);
  await page.locator('#task-close').click();
  const output = process.env.UI_SMOKE_SCREENSHOT_DIR ? path.resolve(process.env.UI_SMOKE_SCREENSHOT_DIR) : path.join(root, 'release', 'monitor-rule-ui-smoke');
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + '/#create');
  await page.locator('[data-monitor-type="product_stock"]').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const dynamic = await context.request.post(base + '/api/analyze', { data: { type: 'product_stock', url: sourceUrl + '/dynamic-product' }, timeout: 60000 });
  assert.equal(dynamic.status(), 200, await dynamic.text());
  const dynamicRule = await dynamic.json();
  assert.equal(dynamicRule.monitor.detection_method, 'api');
  assert.equal(dynamicRule.monitor.extraction_rule.endpoint, sourceUrl + '/stock-api');
  assert.equal(dynamicRule.monitor.last_test_result.current_value, 'out_of_stock');
  console.log('PASS repair confirmation, detection logs, mobile layout, no browser errors');
  console.log('PASS real Chromium rendering, discovery and replay validation of stock API');
  await context.request.delete(base + '/api/ai/key');
  await page.goto(base + '/#create');
  await page.locator('[data-monitor-type="product_stock"]').click();
  await page.locator('#instruction-url').fill(sourceUrl + '/product');
  await page.locator('#create-pick-element').click();
  await page.locator('.picker-status').filter({ hasText: '页面已加载' }).waitFor();
  await page.frameLocator('.element-frame').locator('.inventory-status').click();
  await page.locator('[data-picker-confirm]').click();
  await page.waitForFunction(() => !document.querySelector('.rule-dialog'));
  await page.locator('#create-button').click();
  await page.waitForFunction(() => document.querySelectorAll('.monitor-item').length === 3);
  assert.deepEqual(errors, []);
  console.log('PASS selecting and creating a validated stock task without model configuration');
  await context.request.patch(base + '/api/monitors/' + stockId, { data: { rule: { intervalMinutes: 5 } } });
  const apiDraftResponse = await context.request.post(base + '/api/analyze', { data: { type: 'api_monitor', url: sourceUrl + '/health', rule: { fetch: { mode: 'http', proxy: 'custom' }, sourceProxy: proxyA.url } } });
  assert.equal(apiDraftResponse.status(), 200, await apiDraftResponse.text());
  const apiDraft = await apiDraftResponse.json();
  const apiCreated = await context.request.post(base + '/api/monitors', { data: { ...apiDraft.monitor, sourceProxy: proxyA.url, webhookIds: ['hook'] } });
  assert.equal(apiCreated.status(), 201);
  const apiId = (await apiCreated.json()).monitors[0].id;
  await page.goto(base + '/#monitors');
  const taskEditor = page.locator('#task-workspace');
  await page.locator('[data-action="edit"][data-id="' + apiId + '"]').click();
  await choose(taskEditor.locator('.source-fetch-proxy'), 'custom');
  await taskEditor.locator('.source-proxy-input').fill(proxyB.url);
  await taskEditor.locator('[data-source-proxy-test]').click();
  await taskEditor.locator('.rule-proxy-result').filter({ hasText: '连接成功' }).waitFor();
  await page.locator('#task-save').click();
  await taskEditor.waitFor({ state: 'hidden' });
  await page.waitForFunction(({ apiId, endpoint }) => document.querySelector('[data-monitor-id="' + apiId + '"] .monitor-source-route')?.textContent.includes(endpoint), { apiId, endpoint: proxyB.endpoint });
  state = await (await context.request.get(base + '/api/state')).json();
  assert.equal(state.monitors.find(m => m.id === apiId).sourceProxyEndpoint, proxyB.endpoint);
  const oldA = proxyA.requests.length, oldB = proxyB.requests.length;
  const apiChecked = await context.request.post(base + '/api/monitors/' + apiId + '/check');
  assert.equal(apiChecked.status(), 200);
  assert.equal(proxyA.requests.length, oldA);
  assert.ok(proxyB.requests.length > oldB);
  await page.locator('[data-action="edit"][data-id="' + stockId + '"]').click();
  await choose(taskEditor.locator('.source-fetch-mode'), 'browser');
  await page.locator('#task-save').click();
  await taskEditor.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('#task-save').disabled);
  state = await (await context.request.get(base + '/api/state')).json();
  const browserRule = state.monitors.find(m => m.id === stockId);
  assert.equal(browserRule.fetch.mode, 'browser');
  assert.equal(browserRule.sourceProxyEndpoint, proxyA.endpoint);
  assert.equal(browserRule.last_test_result.snapshot.fetch.method, 'browser');
  assert.equal(browserRule.last_test_result.snapshot.fetch.route, 'proxy');
  assert.ok(proxyA.requests.length > oldA);
  assert.deepEqual(errors, []);
  for (const proxy of proxies) { assert.equal(JSON.stringify(aiRequests).includes(proxy.password), false); assert.equal(JSON.stringify(state).includes(proxy.password), false); }
  console.log('PASS separate authenticated proxies for stock, price and API rules, proxy controls and real browser routing');

  await context.request.put(base + '/api/settings', { data: { aiKey: 'fixture-key', aiModel: 'test', aiBaseUrl: sourceUrl + '/v1' } });
  await page.reload();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '/#create');
  await page.locator('[data-monitor-type="product_stock"]').click();
  await page.locator('#instruction').fill('每30秒检查，任意型号显示有货就通知我，并附上链接 https://app.vmiss.com/aff.php?aff=5982');
  await page.locator('#instruction-url').fill(sourceUrl + '/models');
  await choose(page.locator('#create-proxy-mode'), 'custom');
  await page.locator('#create-source-proxy').fill(proxyA.url);
  const probeBefore = proxyA.requests.length;
  await page.locator('#parse-button').click();
  await page.locator('#preview .draft-evidence .stock-models').waitFor();
  assert.equal(await page.locator('#preview .draft-evidence .stock-models li').count(), 5);
  assert.match(await page.locator('#preview .draft-evidence .stock-models').innerText(), /0 Available/);
  assert.match(await page.locator('#preview > .rule-evidence').innerText(), /全部无货/);
  assert.match(await page.locator('#preview > .plain-rule-summary').innerText(), /30 秒/);
  await page.locator('[data-source-preview]').click();
  await page.locator('.picker-status').filter({ hasText: '页面已加载' }).waitFor();
  assert.match(await page.locator('.picker-status').innerText(), /任务代理出口.*en.*5 个区域/);
  const iframe = page.frameLocator('.element-frame');
  assert.equal(await iframe.locator('[data-radar-monitored]').count(), 5);
  assert.equal(await page.locator('.picker-count').innerText(), '已选 5 个区域');
  await page.locator('[data-picker-scope="all_models"]').click();
  assert.equal(await page.locator('.picker-scope').getAttribute('data-value'), 'all_models');
  assert.match(await page.locator('.picker-scope-help').innerText(), /5 个型号/);
  await page.locator('[data-picker-confirm]').click();
  await page.waitForFunction(() => !document.querySelector('.rule-dialog'));
  await page.locator('#create-button').click();
  state = await (await context.request.get(base + '/api/state')).json();
  await page.locator('.monitor-item').filter({ has: page.locator('.monitor-name').filter({ hasText: /^TRI$/ }) }).waitFor();
  state = await (await context.request.get(base + '/api/state')).json();
  const multi = state.monitors.find(monitor => monitor.label === 'TRI');
  assert.ok(multi);
  assert.equal(multi.extraction_rule.kind, 'stock_items');
  assert.equal(multi.interval, 30);
  assert.equal(multi.snapshot.items.length, 5);
  assert.equal(multi.sourceProxyEndpoint, proxyA.endpoint);
  assert.ok(proxyA.requests.length > probeBefore);
  modelCounts = [0, 1, 0, 0, 0];
  await context.request.post(base + '/api/monitors/' + multi.id + '/check');
  const sent = notifications.filter(item => item.monitorId === multi.id);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /TRI.Core.*无货 → 有货/);
  assert.match(sent[0].message, /aff=5982/);
  await context.request.post(base + '/api/monitors/' + multi.id + '/check');
  assert.equal(notifications.filter(item => item.monitorId === multi.id).length, 1);
  console.log('PASS cloud English stock evidence, five highlighted regions, all-model selection, independent proxy and correct restock notification');

  // Review the list with enough real saved tasks to assess density and overflow.
  for (let i = 0; i < 6; i++) {
    const create = await context.request.post(base + '/api/monitors', { data: { ...multi, id: undefined, label: '监控任务 ' + (i + 1), intervalMinutes: 60, notification: multi.notification, fetch: { mode: 'http', proxy: 'direct' }, sourceProxy: '', webhookIds: ['hook'] } });
    assert.equal(create.status(), 201, await create.text());
  }
  await page.goto(base + '/#monitors');
  await page.reload();
  await page.locator('.monitor-item').nth(9).waitFor();
  const cardGeometry = () => page.locator('.monitor-item').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { id: node.dataset.monitorId, x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height }; }));
  const desktopCards = await cardGeometry();
  assert.equal(desktopCards[0].x, desktopCards[1].x, 'Tasks share a centered column');
  assert.ok(desktopCards[1].y - desktopCards[0].y - desktopCards[0].height >= 24, 'Tasks have clear space between them');
  assert.equal(desktopCards[0].height, desktopCards[1].height, 'Different task types use stable overview geometry');
  assert.equal(await page.locator('details, select:visible, .monitor-more, .monitor-item .monitor-route').count(), 0);
  await page.screenshot({ path: path.join(output, 'desktop-task-list.png'), fullPage: true });
  const toggleSaved = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith('/api/monitors/' + stockId));
  await page.locator('[data-action="toggle"][data-id="' + stockId + '"]').click();
  await (await toggleSaved).finished();
  await page.waitForFunction(id => document.querySelector('[data-action="toggle"][data-id="' + id + '"]')?.textContent === '继续', stockId);
  assert.deepEqual(await cardGeometry(), desktopCards, 'Pausing does not move or resize task cards');
  const checked = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/monitors/' + stockId + '/check'));
  await page.locator('[data-action="check"][data-id="' + stockId + '"]').click();
  await (await checked).finished();
  await page.waitForFunction(() => !document.querySelector('[data-action="check"]:disabled'));
  assert.deepEqual(await cardGeometry(), desktopCards, 'Checking does not move or resize task cards');
  await page.locator('[data-action="edit"][data-id="' + multi.id + '"]').click();
  await page.locator('.task-records .check-record').first().waitFor();
  const sectionKeys = await taskEditor.locator('[data-rule-section]').evaluateAll(nodes => nodes.map(n => n.dataset.ruleSection));
  assert.deepEqual(sectionKeys, ['basics', 'conditions', 'notifications', 'source', 'evidence', 'order', 'records']);
  assert.equal(await taskEditor.locator('[role=tab], details, dialog, select:visible').count(), 0);
  for (const section of await taskEditor.locator('[data-rule-section]').all()) assert.ok(await section.isVisible());
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'desktop-rule-page.png'), fullPage: true });
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Rule editor has no overflow at ' + width);
    if (width === 390) await page.screenshot({ path: path.join(output, 'mobile-rule-page.png'), fullPage: true });
  }
  await page.locator('#task-close').click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Task list has no overflow at ' + width);
    const mobileCards = await cardGeometry();
    assert.equal(mobileCards[0].x, mobileCards[1].x);
    assert.equal(mobileCards[0].height, mobileCards[1].height);
    if (width === 390) await page.screenshot({ path: path.join(output, 'mobile-task-list.png'), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('PASS ten-task centered list, stable pause/check geometry, complete single-page rule editor, tablet and mobile without overflow');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('[data-action="edit"][data-id="' + multi.id + '"]').click();
  await taskEditor.locator('[data-rule-pick]').click();
  await page.locator('.picker-status').filter({ hasText: '页面已加载' }).waitFor();
  await page.locator('.picker-count').filter({ hasText: '已选 5 个区域' }).waitFor();
  const multiFrame = page.frameLocator('.element-frame');
  for (const i of [0, 2, 4]) await multiFrame.locator('#product' + i + ' .qty').click();
  assert.equal(await multiFrame.locator('.radar-selected').count(), 2);
  assert.equal(await page.locator('.picker-count').innerText(), '已选 2 个区域');
  assert.equal(await page.locator('.picker-selected-item').count(), 2);
  assert.equal(await page.locator('.picker-scope').getAttribute('data-value'), 'selected');
  await multiFrame.locator('#product1 .qty').click();
  assert.equal(await multiFrame.locator('.radar-selected').count(), 1);
  await multiFrame.locator('#product1 .qty').click();
  assert.equal(await multiFrame.locator('.radar-selected').count(), 2);
  await page.locator('[data-picker-confirm]').click();
  await page.waitForFunction(() => !document.querySelector('.rule-dialog'));
  await page.locator('#task-save').click();
  await taskEditor.waitFor({ state: 'hidden' });
  state = await (await context.request.get(base + '/api/state')).json();
  const subset = state.monitors.find(m => m.id === multi.id);
  assert.equal(subset.extraction_rule.kind, 'elements');
  assert.equal(subset.snapshot.items.length, 2);
  assert.deepEqual(new Set(subset.snapshot.items.map(item => item.name)), new Set(['TRI.Core', 'TRI.Elite']));
  const sentBefore = notifications.filter(n => n.monitorId === multi.id).length;
  modelCounts = [1, 1, 0, 0, 0];
  await context.request.post(base + '/api/monitors/' + multi.id + '/check');
  assert.equal(notifications.filter(n => n.monitorId === multi.id).length, sentBefore);
  modelCounts = [1, 1, 0, 2, 0];
  await context.request.post(base + '/api/monitors/' + multi.id + '/check');
  assert.equal(notifications.filter(n => n.monitorId === multi.id).length, sentBefore + 1);
  assert.match(notifications.filter(n => n.monitorId === multi.id).at(-1).message, /TRI.Elite.*无货 → 有货/);
  await page.locator('[data-action="edit"][data-id="' + multi.id + '"]').click();
  await taskEditor.locator('[data-rule-pick]').click();
  await page.locator('.picker-count').filter({ hasText: '已选 2 个区域' }).waitFor();
  assert.equal(await multiFrame.locator('.radar-selected').count(), 2);
  await page.screenshot({ path: path.join(output, 'desktop-multi-picker.png'), fullPage: true });
  await page.locator('[data-picker-clear]').click();
  assert.equal(await multiFrame.locator('.radar-selected').count(), 0);
  assert.equal(await page.locator('[data-picker-confirm]').isDisabled(), true);
  await multiFrame.locator('#product1 .qty').click();
  await multiFrame.locator('#product3 .qty').click();
  await page.locator('.picker-selected-item').first().click();
  assert.equal(await multiFrame.locator('.radar-selected').count(), 1);
  await multiFrame.locator('#product1 .qty').click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.equal(await page.locator('select:visible, dialog, details').count(), 0);
  await page.screenshot({ path: path.join(output, 'mobile-multi-picker.png'), fullPage: true });
  await page.locator('[data-rule-close]').click();
  await page.locator('#task-close').click();
  assert.deepEqual(errors, []);
  console.log('PASS multi-selection, toggling, clear/remove, saved selection restoration, subset restock notifications and mobile picker');


} finally {
  await browser?.close();
  if (child) { child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)); }
  for (const proxy of proxies) { for (const socket of proxy.sockets) socket.destroy(); await new Promise(resolve => proxy.server.close(resolve)); }
  mock.closeAllConnections?.(); await new Promise(resolve => mock.close(resolve));
  const resolved = path.resolve(dataDir);
  assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('radar-rule-ui-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
