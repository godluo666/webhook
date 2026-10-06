import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const choose = async (field, value) => field.locator('..').locator('.choice-control [data-choice-value="' + value + '"]').click();

const root = process.cwd();
const dataRoot = path.resolve(process.env.DATA_DIR || path.join(root, 'release', 'ui-smoke-data'));
await fs.mkdir(dataRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(dataRoot, 'ui-smoke-'));
const password = 'ui-smoke-password-2026';
const messages = [], pageErrors = [], settingsRequests = [];
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const closeServer = server => new Promise(resolve => {
  server.closeAllConnections?.();
  server.close(resolve);
});
let providerHold = null;
const mock = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname.startsWith('/source-')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<html><body>waiting for a change</body></html>');
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    if (pathname === '/hook') {
      messages.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    if (pathname === '/v1/chat/completions') {
      const hold = providerHold;
      providerHold = null;
      if (hold) {
        hold.entered.resolve();
        await hold.release.promise;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  } catch (error) {
    response.writeHead(500);
    response.end(error.message);
  }
});
let child, browser, context, childExited;
let releaseChannel = null, releaseRecovery = null, releaseProvider = null;
const waitForSignal = async (signal, label) => {
  let timer;
  try {
    return await Promise.race([
      signal.promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' did not arrive')), 15000); })
    ]);
  } finally { clearTimeout(timer); }
};
let serverOutput = '';
const screenshotDir = process.env.UI_SMOKE_SCREENSHOT_DIR ? path.resolve(process.env.UI_SMOKE_SCREENSHOT_DIR) : null;
if (screenshotDir) await fs.mkdir(screenshotDir, { recursive: true });
try {
  const mockPort = await listen(mock);
  const mockBase = 'http://127.0.0.1:' + mockPort;
  const reservation = http.createServer();
  const appPort = await listen(reservation);
  await closeServer(reservation);
  const base = 'http://127.0.0.1:' + appPort;
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(appPort), DATA_DIR: dataDir,
      RESEND_API_KEY: '', MAIL_FROM: '', SIGNUP_CODE: '', COOKIE_SECURE: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  childExited = new Promise(resolve => child.once('exit', resolve));
  child.on('error', error => { serverOutput += error.message; });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { serverOutput = (serverOutput + chunk.toString()).slice(-8192); });
  }
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(base + '/api/auth/status', { signal: AbortSignal.timeout(1000) });
      if (response.ok) { started = true; break; }
    } catch { /* wait for the isolated application */ }
    if (child.exitCode != null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(started, 'Isolated UI smoke server did not start: ' + serverOutput);

  const executablePath = process.env.MONITOR_BROWSER_EXECUTABLE;
  assert.ok(executablePath, 'MONITOR_BROWSER_EXECUTABLE must point to Chromium');
  browser = await chromium.launch({
    executablePath, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Public IP deployments over HTTP do not expose these secure-context APIs.
  await context.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    window.__copyFallbackCalls = 0;
    const original = document.execCommand.bind(document);
    document.execCommand = (command, ...args) => {
      if (command === 'copy') window.__copyFallbackCalls++;
      return original(command, ...args);
    };
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  let nextChannelHold = null, nextRecoveryHold = null;
  await page.route('**/api/settings', async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    const body = route.request().postDataJSON();
    settingsRequests.push(body);
    const hold = body.webhooks && nextChannelHold;
    if (!hold) { await route.continue(); return; }
    nextChannelHold = null;
    const response = await route.fetch();
    hold.entered.resolve();
    await hold.release.promise;
    await route.fulfill({ response });
  });
  await page.route('**/api/auth/recovery-code/rotate', async route => {
    const hold = nextRecoveryHold;
    nextRecoveryHold = null;
    if (!hold) { await route.continue(); return; }
    const response = await route.fetch();
    hold.entered.resolve();
    await hold.release.promise;
    await route.fulfill({ response });
  });
  const state = async () => {
    const response = await context.request.get(base + '/api/state');
    assert.ok(response.ok(), await response.text());
    return response.json();
  };
  const post = async (endpoint, body) => {
    const response = await context.request.post(base + endpoint, { data: body });
    assert.ok(response.ok(), await response.text());
    return response.json();
  };
  const navigate = async hash => {
    await page.evaluate(value => { location.hash = value; }, '#' + hash);
    await page.waitForFunction(value => document.querySelector('.app-shell').dataset.view === value, hash);
  };
  const register = async username => {
    await page.locator('#auth-screen').waitFor({ state: 'visible' });
    await page.locator('#show-register').click();
    await page.locator('#auth-username').fill(username);
    await page.locator('#auth-password').fill(password);
    await page.locator('#auth-submit').click();
    await page.waitForFunction(value => document.querySelector('#account-name').textContent === value, username);
    await page.locator('#close-recovery-code').click();
    await page.locator('#recovery-code-screen').waitFor({ state: 'hidden' });
  };
  const flushUi = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  console.log('UI smoke: HTTP compatibility and independent settings');
  await page.goto(base);
  await register('ui-smoke-alice');
  await navigate('ai-settings');
  await page.locator('#ai-base-url').fill(mockBase + '/v1');
  await page.locator('#ai-model').fill('smoke-model');
  await page.locator('#ai-key').fill('ui-smoke-ai-private');
  const aiSave = page.waitForResponse(response => response.url() === base + '/api/settings' && response.request().method() === 'PUT');
  await page.locator('#save-button').click();
  await (await aiSave).finished();
  await page.waitForFunction(() => !document.querySelector('#save-button').disabled);
  assert.equal((await state()).settings.aiModel, 'smoke-model');
  assert.equal(settingsRequests.at(-1).webhooks, undefined, 'Saving AI settings must not submit channels');

  await page.locator('#ai-test-button').click();
  await page.waitForFunction(() => document.querySelector('#ai-test-result').textContent.includes('连接成功'));
  await page.locator('#ai-base-url').fill('unfinished-api-address');
  await page.locator('#ai-model').fill('unsaved-model-draft');
  await navigate('channels');
  assert.equal(await page.locator('#ai-base-url').inputValue(), 'unfinished-api-address');

  const channelHold = { entered: deferred(), release: deferred() };
  nextChannelHold = channelHold;
  releaseChannel = channelHold.release;
  await page.locator('#add-webhook').click();
  await page.locator('#webhook-drawer').waitFor({ state: 'visible' });
  await page.locator('#drawer-fields .hook-name').fill('常用通知渠道');
  await page.locator('#drawer-fields .hook-url').fill(mockBase + '/hook?token=' + 'x'.repeat(180));
  await choose(page.locator('#drawer-fields .hook-format'), 'generic');
  await page.locator('#drawer-save').click();
  await waitForSignal(channelHold.entered, 'Channel save');
  for (const selector of ['#drawer-save', '#drawer-test', '#drawer-fields .hook-name', '#drawer-fields .hook-url']) {
    assert.equal(await page.locator(selector).isDisabled(), true, selector + ' must lock during a channel mutation');
  }
  const requestCount = settingsRequests.length;
  await page.evaluate(() => {
    document.querySelector('#drawer-save').click();
    document.querySelector('#drawer-test').click();
    document.querySelector('#drawer-delete').click();
  });
  await flushUi();
  assert.equal(settingsRequests.length, requestCount, 'A pending channel save must reject concurrent drawer actions');
  const channelPayload = settingsRequests.at(-1);
  assert.ok(Array.isArray(channelPayload.webhooks));
  for (const key of ['aiBaseUrl', 'aiModel', 'aiKey']) {
    assert.equal(Object.hasOwn(channelPayload, key), false, 'Channel save must not submit AI draft field ' + key);
  }
  channelHold.release.resolve();
  await page.locator('#webhook-drawer').waitFor({ state: 'hidden' });
  let current = await state();
  assert.equal(current.settings.webhooks.length, 1);
  assert.equal(current.settings.aiBaseUrl, mockBase + '/v1');
  assert.equal(current.settings.aiModel, 'smoke-model');
  assert.equal(current.settings.hasAiKey, true);
  assert.equal(await page.locator('#ai-base-url').inputValue(), 'unfinished-api-address', 'Channel save must preserve unrelated AI draft');

  await navigate('notifications');
  await page.locator('#send-title').fill('UI smoke delivery');
  await page.locator('#send-message').fill('A real local webhook notification');
  const settingsBeforeSend = settingsRequests.length;
  await page.locator('#send-button').click();
  await page.waitForFunction(() => !document.querySelector('#send-button').disabled && document.querySelector('#send-message').value === '');
  assert.equal(messages.length, 1, 'Quick send must deliver to the actual local webhook');
  assert.equal(messages[0].title, 'UI smoke delivery');
  assert.equal(messages[0].message, 'A real local webhook notification');
  assert.equal(settingsRequests.length, settingsBeforeSend, 'Quick send must not save unrelated configuration');
  current = await state();
  assert.equal(current.settings.aiModel, 'smoke-model');
  assert.equal(current.settings.aiBaseUrl, mockBase + '/v1');

  await navigate('activity');
  await page.locator('[data-view-log]').first().click();
  await page.locator('.rule-dialog [data-copy-log]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已复制'));
  assert.ok(await page.evaluate(() => window.__copyFallbackCalls > 0), 'HTTP deployments must use the clipboard fallback');
  await page.locator('[data-rule-close]').click();

  console.log('UI smoke: editing drafts, independent proxy controls and 30 second intervals');
  const hookId = current.settings.webhooks[0].id;
  const task = label => ({
    kind: 'webpage', label, url: mockBase + '/source-' + label.at(-1),
    keyword: 'available', mode: 'contains', intervalMinutes: 5,
    webhookIds: [hookId], fetch: { mode: 'http', proxy: 'direct' }
  });
  const firstTask = await post('/api/monitors', task('任务 A'));
  const taskA = firstTask.monitors[0];
  const secondTask = await post('/api/monitors', task('任务 B'));
  const taskB = secondTask.monitors[0];
  await page.reload();
  await navigate('monitors');
  const articleA = page.locator('.monitor-item').filter({ has: page.locator('.monitor-name').filter({ hasText: '任务 A' }) });
  const listBounds = await page.locator('#monitor-list').boundingBox();
  await articleA.locator('[data-action="edit"]').click();
  const editorA = page.locator('#task-workspace');
  await editorA.locator('.edit-label').fill('还没有保存的任务 A 草稿');
  const checkedTask = await context.request.post(base + '/api/monitors/' + encodeURIComponent(taskB.id) + '/check');
  assert.ok(checkedTask.ok());
  await page.evaluate(async () => { appState = await api('/api/state'); render(); });
  const stableLists = await page.evaluate(() => {
    render();
    const nodes = ['#monitor-list', '#activity-list', '#log-list'].map(selector => document.querySelector(selector).firstElementChild);
    render();
    return nodes.every((node, index) => node === document.querySelector(['#monitor-list', '#activity-list', '#log-list'][index]).firstElementChild);
  });
  assert.equal(stableLists, true, 'Unchanged lists retain their DOM nodes');
  const pollStatuses = [];
  const observePoll = response => { if (new URL(response.url()).pathname === '/api/state') pollStatuses.push(response.status()); };
  page.on('response', observePoll);
  try {
    const stablePolling = await page.evaluate(async () => {
      workspaceTag = null;
      await refreshWorkspace();
      const nodes = ['#monitor-list', '#activity-list', '#log-list'].map(selector => document.querySelector(selector).firstElementChild);
      await refreshWorkspace();
      return Boolean(workspaceTag?.etag) && nodes.every((node, index) => node === document.querySelector(['#monitor-list', '#activity-list', '#log-list'][index]).firstElementChild);
    });
    assert.equal(stablePolling, true, 'Conditional polling preserves nodes and an unsaved editor');
    assert.deepEqual(pollStatuses, [200, 304]);
    assert.equal(await editorA.locator('.edit-label').inputValue(), '还没有保存的任务 A 草稿');
  } finally { page.removeListener('response', observePoll); }
  console.log('PASS unchanged lists and conditional state polling preserve nodes and editing drafts');
  assert.equal(await editorA.locator('.edit-label').inputValue(), '还没有保存的任务 A 草稿', 'Background checks must preserve task A editing draft');
  assert.equal(await editorA.isVisible(), true);
  assert.equal(await page.locator('#task-list-view').isVisible(), false);
  assert.equal(await page.locator('#task-workspace [role=tab], #task-workspace details, #task-workspace dialog').count(), 0, 'All rule sections remain on a single page');
  assert.equal((await state()).monitors.find(monitor => monitor.id === taskA.id).label, '任务 A', 'Preserved editing drafts must remain unsaved');

  // The proxy API has its own real-network regression tests. This UI check
  // verifies credential handling and that the selected candidate reaches it.
  const proxyCandidates = [];
  await page.route('**/api/source-proxy/test', async route => {
    proxyCandidates.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, purpose: 'connectivity', ip: '203.0.113.12', durationMs: 17 })
    });
  });
  await choose(editorA.locator('.source-fetch-proxy'), 'custom');
  const proxyInput = editorA.locator('.source-proxy-input');
  assert.equal(await proxyInput.isVisible(), true);
  assert.equal(await proxyInput.getAttribute('type'), 'password', 'Independent proxy credentials must remain masked');
  const candidate = 'http://smoke-user:smoke-password@127.0.0.1:9';
  await proxyInput.fill(candidate);
  await editorA.locator('[data-source-proxy-test]').click();
  await page.waitForFunction(id => {
    const editor = document.querySelector('.monitor-route[data-id="' + id + '"]');
    return editor.querySelector('.rule-proxy-result').textContent.includes('203.0.113.12');
  }, taskA.id);
  assert.equal(proxyCandidates.length, 1);
  assert.equal(proxyCandidates[0].proxyUrl, candidate, 'Independent proxy testing must submit the entered candidate');
  assert.equal(proxyCandidates[0].monitorId, undefined, 'A new candidate must not accidentally test an old saved proxy');
  assert.equal((await state()).monitors.find(monitor => monitor.id === taskA.id).fetch.proxy, 'direct', 'Testing a proxy must not save it');
  if (screenshotDir) { await proxyInput.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(screenshotDir, 'proxy-desktop.png'), fullPage: true }); }
  await choose(editorA.locator('.source-fetch-proxy'), 'direct');
  assert.equal(await proxyInput.isVisible(), false);

  await editorA.locator('.edit-label').fill('任务 A');
  await editorA.locator('.edit-interval').fill('30');
  await choose(editorA.locator('.interval-unit'), 'seconds');
  const beforeInterval = (await state()).monitors.find(monitor => monitor.id === taskA.id);
  const intervalSaved = page.waitForResponse(response =>
    response.url() === base + '/api/monitors/' + encodeURIComponent(taskA.id)
    && response.request().method() === 'PATCH');
  await editorA.locator('[data-action="save-rule"]').click();
  await (await intervalSaved).finished();
  await editorA.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('#task-save').disabled);
  const savedInterval = (await state()).monitors.find(monitor => monitor.id === taskA.id);
  assert.equal(savedInterval.intervalMinutes, 0.5, 'A 30 second interval must be saved without being clamped to whole minutes');
  assert.equal(savedInterval.baselined, beforeInterval.baselined);
  assert.deepEqual(savedInterval.snapshot, beforeInterval.snapshot, 'Changing an interval must retain the monitoring baseline');
  await articleA.locator('[data-action="edit"]').click();
  assert.equal(await editorA.locator('.edit-interval').inputValue(), '30');
  assert.equal(await editorA.locator('.interval-unit').inputValue(), 'seconds', 'Reopened editing must retain the saved unit');
  await page.locator('#task-close').click();
  assert.deepEqual(await page.locator('#monitor-list').boundingBox(), listBounds, 'Returning from editing must preserve list geometry');

  console.log('UI smoke: reminder and generated rule editing on one page');
  const reminder = (await post('/api/monitors', {
    kind: 'reminder', label: '会议提醒', message: '带上会议材料',
    remindAt: new Date(Date.now() + 86400000).toISOString(), webhookIds: [hookId],
    notification: { title: '{{name}}', body: '{{message}}' }
  })).monitors[0];
  const service = (await post('/api/monitors', {
    kind: 'generated', label: '接口响应', url: mockBase + '/source-service', intervalMinutes: 5,
    plan: { sourceType: 'service', mode: 'unavailable', initial: 'baseline', failureThreshold: 3 },
    webhookIds: [hookId], notification: { title: '{{name}}', body: '{{summary}}' }
  })).monitors[0];
  await page.reload();
  await page.locator('[data-action="edit"][data-id="' + reminder.id + '"]').click();
  assert.equal(await editorA.locator('[data-rule-section="source"]').count(), 0);
  await choose(editorA.locator('.edit-repeat-mode'), 'interval');
  await choose(editorA.locator('.edit-repeat-unit'), '1440');
  await editorA.locator('.edit-repeat-value').fill('2');
  await editorA.locator('.edit-message').fill('更新后的会议材料提醒');
  await editorA.locator('.notification-body').fill('{{message}} · 会议安排');
  await page.locator('#task-save').click();
  await editorA.waitFor({ state: 'hidden' });
  const savedReminder = (await state()).monitors.find(m => m.id === reminder.id);
  assert.equal(savedReminder.repeatMinutes, 2880);
  assert.equal(savedReminder.message, '更新后的会议材料提醒');
  assert.equal(savedReminder.notification.body, '{{message}} · 会议安排');
  await page.locator('[data-action="edit"][data-id="' + service.id + '"]').click();
  await choose(editorA.locator('[data-plan-key="mode"]'), 'slow');
  await editorA.locator('[data-plan-key="thresholdMs"]').fill('5.5');
  await choose(editorA.locator('[data-plan-key="initial"]'), 'notify');
  await page.locator('#task-save').click();
  await editorA.waitFor({ state: 'hidden' });
  const savedService = (await state()).monitors.find(m => m.id === service.id);
  assert.equal(savedService.plan.mode, 'slow');
  assert.equal(savedService.plan.thresholdMs, 5500);
  assert.equal(savedService.plan.initial, 'notify');
  await navigate('create');
  await page.evaluate(rule => { previewMonitor = rule; renderPreview(rule); }, { ...savedReminder, id: undefined, label: '新的会议提醒' });
  await page.locator('#rule-message').fill('新的提醒正文');
  await choose(page.locator('.rule-repeat-mode'), 'once');
  await page.locator('#create-button').click();
  await page.waitForFunction(() => document.querySelector('.app-shell').dataset.view === 'monitors');
  const newReminder = (await state()).monitors.find(m => m.label === '新的会议提醒');
  assert.equal(newReminder.message, '新的提醒正文');
  assert.equal(newReminder.repeatMinutes, 0);

  console.log('UI smoke: desktop headings and mobile layouts');
  const headings = {
    top: '#overview h1', channels: '#settings-page-title', 'ai-settings': '#settings-page-title',
    create: '#create-heading', monitors: '#task-list-view h2', notifications: '#notifications h2',
    'fetch-settings': '#fetch-settings h2', activity: '#activity h2'
  };
  for (const [view, selector] of Object.entries(headings)) {
    await navigate(view);
    assert.equal(await page.locator(selector).isVisible(), true, 'Desktop page title must be visible for ' + view);
    // Shadowsocks encryption is intentionally a native dropdown, as requested.
    assert.equal(await page.locator('details, select:visible:not(#source-ss-method)').count(), 0, 'No unexpected dropdown controls on ' + view);
    if(view==='fetch-settings'){
      const cipher=page.locator('#source-ss-method');assert.equal(await cipher.isVisible(),true);assert.equal(await cipher.getAttribute('data-native-select'),'');
      assert.equal(await cipher.locator('option[value="aes-256-gcm"]').count(),1);assert.equal(await cipher.locator('option[value="chacha20-ietf-poly1305"]').count(),1);
    }
  }
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  mobile.on('pageerror', error => pageErrors.push(error.message));
  if (screenshotDir) {
    await mobile.goto(base + '/#monitors');
    await mobile.waitForFunction(() => !document.querySelector('.app-shell').classList.contains('auth-hidden'));
    const mobileArticle = mobile.locator('.monitor-item').filter({ has: mobile.locator('.monitor-name').filter({ hasText: '任务 A' }) });
    await mobileArticle.locator('[data-action="edit"]').click();
    const mobileEditor = mobile.locator('#task-workspace');
    await choose(mobileEditor.locator('.source-fetch-proxy'), 'custom');
    await mobileEditor.locator('.source-proxy-input').fill(candidate);
    await mobileEditor.locator('.source-proxy-input').scrollIntoViewIfNeeded();
    await mobile.screenshot({ path: path.join(screenshotDir, 'proxy-mobile.png'), fullPage: true });
    await mobile.locator('#task-close').click();
  }
  for (const view of ['channels', 'ai-settings', 'monitors', 'notifications', 'create', 'fetch-settings', 'activity']) {
    await mobile.goto(base + '/#' + view);
    await mobile.waitForFunction(() => !document.querySelector('.app-shell').classList.contains('auth-hidden'));
    const width = await mobile.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
    }));
    assert.ok(width.document <= width.viewport + 2, 'Mobile horizontal overflow on ' + view + ': ' + JSON.stringify(width));
  }
  await mobile.close();

  console.log('UI smoke: delayed responses across logout and account switch');
  await navigate('ai-settings');
  await page.locator('#ai-base-url').fill(mockBase + '/v1');
  await page.locator('#ai-model').fill('smoke-model');
  const lateAi = { entered: deferred(), release: deferred() };
  providerHold = lateAi;
  releaseProvider = lateAi.release;
  const lateAiFinished = page.waitForResponse(response => response.url() === base + '/api/ai/test');
  await page.locator('#ai-test-button').click();
  await waitForSignal(lateAi.entered, 'Delayed AI provider request');
  await navigate('account');
  await page.locator('#account [data-feature-tab][aria-controls="account-panel-2"]').click();
  const lateRecovery = { entered: deferred(), release: deferred() };
  nextRecoveryHold = lateRecovery;
  releaseRecovery = lateRecovery.release;
  const lateRecoveryFinished = page.waitForResponse(response => response.url() === base + '/api/auth/recovery-code/rotate');
  await page.locator('#rotate-code-password').fill(password);
  await page.locator('#rotate-code-form button').click();
  await waitForSignal(lateRecovery.entered, 'Delayed recovery code request');
  await navigate('channels');
  await page.locator('[data-hook-action="edit"]').first().click();
  assert.equal(await page.locator('#drawer-fields .hook-name').inputValue(), '常用通知渠道');
  // Trigger the actual logout handler while a drawer is open; the security cleanup
  // must not depend on the user closing overlays first.
  await page.evaluate(() => document.querySelector('#logout-button').click());
  await page.locator('#auth-screen').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#drawer-fields').textContent(), '');
  assert.equal(await page.locator('#recovery-code-value').textContent(), '');
  await register('ui-smoke-bob');
  const bobBefore = await state();
  assert.equal(bobBefore.settings.webhooks.length, 0);
  assert.equal(bobBefore.settings.hasAiKey, false);
  assert.equal(await page.locator('#webhook-drawer').isVisible(), false);

  lateAi.release.resolve();
  lateRecovery.release.resolve();
  await (await lateAiFinished).finished();
  await (await lateRecoveryFinished).finished();
  await flushUi();
  assert.equal(await page.locator('#account-name').textContent(), 'ui-smoke-bob');
  assert.equal(await page.locator('#ai-test-result').textContent(), '', 'An old account AI response must not update the new account UI');
  assert.equal(await page.locator('#recovery-code-value').textContent(), '', 'An old recovery response must not disclose a previous account code');
  assert.equal(await page.locator('#recovery-code-screen').isVisible(), false);
  assert.equal(await page.locator('#webhook-list tr').count(), 0);
  const bobAfter = await state();
  assert.equal(bobAfter.user.id, bobBefore.user.id);
  assert.equal(bobAfter.settings.hasAiKey, false);
  assert.equal(bobAfter.monitors.length, 0);
  assert.deepEqual(pageErrors, [], 'The UI must not produce uncaught JavaScript errors');

  console.log('UI smoke passed: HTTP fallbacks, independent settings, drawer concurrency, draft preservation, account isolation and responsive pages.');
} catch (error) {
  if (pageErrors.length) console.error('Uncaught browser errors:', JSON.stringify(pageErrors));
  throw error;
} finally {
  providerHold?.release.resolve();
  releaseProvider?.resolve();
  releaseChannel?.resolve();
  releaseRecovery?.resolve();
  if (browser) await browser.close();
  if (child && child.exitCode == null) child.kill();
  if (childExited) await childExited;
  await closeServer(mock);
  const resolved = path.resolve(dataDir);
  assert.equal(path.dirname(resolved), dataRoot, 'Refusing to remove a directory outside the UI smoke data root');
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
