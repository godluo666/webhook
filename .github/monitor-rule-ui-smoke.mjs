import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

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
  if (!await page.locator('#create-source-settings').evaluate(node => node.open)) await page.locator('#create-source-settings > summary').click();
  await page.locator('#create-proxy-mode').selectOption('custom');
  await page.locator('#create-source-proxy').fill(proxyA.url);
  await page.locator('#parse-button').click();
  await page.locator('#preview .rule-evidence').first().waitFor();
  await page.waitForFunction(() => document.querySelector('#preview-result')?.textContent.includes('成功') || document.querySelector('#preview-result')?.textContent.includes('当前库存'));
  assert.match(await page.locator('#preview').innerText(), /无货/);
  assert.match(await page.locator('#preview').innerText(), /依据评分/);
  assert.match(await page.locator('#preview > .rule-validation summary').innerText(), /场景验证/);
  await page.locator('#create-button').click();
  await page.locator('.monitor-item').first().waitFor();
  let state = await (await context.request.get(base + '/api/state')).json();
  const stockId = state.monitors[0].id;
  assert.equal(state.monitors[0].type, 'product_stock');
  assert.equal(state.monitors[0].interval, 30);
  assert.equal(state.monitors[0].sourceProxyEndpoint, proxyA.endpoint);
  assert.match(await page.locator('.monitor-source-route').first().innerText(), /独立代理/);
  await page.locator('.monitor-route summary').first().click();
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
  if (!await page.locator('#create-source-settings').evaluate(node => node.open)) await page.locator('#create-source-settings > summary').click();
  await page.locator('#create-proxy-mode').selectOption('custom');
  await page.locator('#create-source-proxy').fill(proxyB.url);
  await page.locator('#parse-button').click();
  await page.locator('#preview .rule-evidence').first().waitFor();
  await page.locator('#preview .rule-editor > summary').click();
  await page.locator('#preview [role="tab"]').filter({ hasText: '提醒条件' }).click();
  await page.locator('#preview [data-rule-pick]').click();
  await page.locator('.picker-status').filter({ hasText: '页面已加载' }).waitFor();
  await page.frameLocator('.element-frame').locator('.price').click();
  await page.locator('[data-picker-confirm]').click();
  await page.waitForFunction(() => !document.querySelector('.rule-dialog'));
  assert.equal(await page.locator('#preview [data-unified-key="condition.operator"]').inputValue(), 'changed');
  await page.locator('#preview [data-unified-key="condition.operator"]').selectOption('lt');
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
  await page.locator('[data-action="rule-repair"][data-id="' + stockId + '"]').click();
  await page.locator('[data-repair-apply]').waitFor();
  await page.locator('[data-repair-apply]').click();
  await page.waitForFunction(() => !document.querySelector('.rule-dialog'));
  state = await (await context.request.get(base + '/api/state')).json();
  assert.equal(state.monitors.find(m => m.id === stockId).status, 'active');
  await page.locator('[data-action="rule-logs"][data-id="' + stockId + '"]').click();
  await page.locator('.check-record').first().waitFor();
  assert.match(await page.locator('.rule-dialog-body').innerText(), /检测|当前|库存/);
  await page.locator('[data-rule-close]').click();
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
  const apiCard = page.locator('.monitor-item').filter({ has: page.locator('[data-action="proxy"][data-id="' + apiId + '"]') });
  await apiCard.locator('.monitor-more > summary').click();
  await apiCard.locator('[data-action="proxy"]').click();
  await apiCard.locator('.source-fetch-proxy').selectOption('custom');
  await apiCard.locator('.source-proxy-input').fill(proxyB.url);
  await apiCard.locator('[data-source-proxy-test]').click();
  await apiCard.locator('.rule-proxy-result').filter({ hasText: '连接成功' }).waitFor();
  await apiCard.locator('[data-action="save-rule"]').click();
  await page.waitForFunction(({ apiId, endpoint }) => document.querySelector('[data-action="proxy"][data-id="' + apiId + '"]')?.closest('article').querySelector('.monitor-source-route')?.textContent.includes(endpoint), { apiId, endpoint: proxyB.endpoint });
  state = await (await context.request.get(base + '/api/state')).json();
  assert.equal(state.monitors.find(m => m.id === apiId).sourceProxyEndpoint, proxyB.endpoint);
  const oldA = proxyA.requests.length, oldB = proxyB.requests.length;
  const apiChecked = await context.request.post(base + '/api/monitors/' + apiId + '/check');
  assert.equal(apiChecked.status(), 200);
  assert.equal(proxyA.requests.length, oldA);
  assert.ok(proxyB.requests.length > oldB);
  const stockCard = page.locator('.monitor-item').filter({ has: page.locator('[data-action="proxy"][data-id="' + stockId + '"]') });
  if (!await stockCard.locator('.monitor-more').evaluate(node => node.open)) await stockCard.locator('.monitor-more > summary').click();
  await stockCard.locator('[data-action="proxy"]').click();
  await stockCard.locator('.source-fetch-mode').selectOption('browser');
  await stockCard.locator('[data-action="save-rule"]').click();
  await page.waitForFunction(({ stockId }) => window.document.querySelector('[data-action="proxy"][data-id="' + stockId + '"]')?.closest('article').querySelector('.source-fetch-mode')?.value === 'browser', { stockId });
  await page.waitForFunction(() => !document.querySelector('[data-action="save-rule"]:disabled'));
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
  if (!await page.locator('#create-source-settings').evaluate(node => node.open)) await page.locator('#create-source-settings > summary').click();
  await page.locator('#create-proxy-mode').selectOption('custom');
  await page.locator('#create-source-proxy').fill(proxyA.url);
  const probeBefore = proxyA.requests.length;
  await page.locator('#parse-button').click();
  await page.locator('#preview > .stock-models[open]').waitFor();
  assert.equal(await page.locator('#preview > .stock-models li').count(), 5);
  assert.match(await page.locator('#preview > .stock-models').innerText(), /0 Available/);
  assert.match(await page.locator('#preview > .rule-evidence').innerText(), /全部无货/);
  assert.match(await page.locator('#preview > .plain-rule-summary').innerText(), /30 秒/);
  await page.locator('[data-source-preview]').click();
  await page.locator('.picker-status').filter({ hasText: '页面已加载' }).waitFor();
  assert.match(await page.locator('.picker-status').innerText(), /任务代理出口.*en.*5 个区域/);
  const iframe = page.frameLocator('.element-frame');
  assert.equal(await iframe.locator('[data-radar-monitored]').count(), 5);
  await iframe.locator('#product0 .qty').click();
  assert.equal(await page.locator('.picker-scope').inputValue(), 'all_models');
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
  const desktopCards = await page.locator('.monitor-item').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, height: r.height }; }));
  assert.ok(Math.abs(desktopCards[0].y - desktopCards[1].y) < 2 && desktopCards[0].x !== desktopCards[1].x, 'Desktop task list uses two columns');
  assert.ok(desktopCards.slice(0,2).every(card => card.height < 430), 'Default overview omits the full configuration and action list');
  await page.screenshot({ path: path.join(output, 'desktop-task-grid.png'), fullPage: true });
  await page.locator('.monitor-more > summary').first().click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.monitor-more').first().evaluate(node => node.open), false);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: path.join(output, 'mobile-task-list.png'), fullPage: true });
  const mobileCards = await page.locator('.monitor-item').evaluateAll(nodes => nodes.slice(0,2).map(node => { const r=node.getBoundingClientRect(); return {x:r.x,y:r.y}; }));
  assert.ok(Math.abs(mobileCards[0].x-mobileCards[1].x) < 2 && mobileCards[1].y > mobileCards[0].y);
  assert.deepEqual(errors, []);
  console.log('PASS ten-task desktop grid, compact overview, secondary menu keyboard dismissal and mobile list without overflow');

} finally {
  await browser?.close();
  if (child) { child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)); }
  for (const proxy of proxies) { for (const socket of proxy.sockets) socket.destroy(); await new Promise(resolve => proxy.server.close(resolve)); }
  mock.closeAllConnections?.(); await new Promise(resolve => mock.close(resolve));
  const resolved = path.resolve(dataDir);
  assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('radar-rule-ui-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
