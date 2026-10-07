import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function harness(t, callback = (req, res) => res.end('ok')) {
  const target = http.createServer(callback), targetPort = await listen(target);
  const temp = await mkdtemp(path.join(tmpdir(), 'radar-backend-audit-'));
  const reservation = http.createServer(), port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: temp, RESEND_API_KEY: '', MAIL_FROM: '', SIGNUP_CODE: '' }, stdio: 'ignore' });
  t.after(async () => { const exited = once(child, 'exit'); child.kill(); await exited; target.closeAllConnections(); await new Promise(resolve => target.close(resolve)); await rm(temp, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + port;
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { if (attempt === 99) throw Error('Application did not start'); } await delay(40); }
  let cookie = '';
  async function request(endpoint, method = 'GET', body, expectedStatus = 200) {
    const response = await fetch(base + endpoint, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(data)); return data;
  }
  await request('/api/auth/register', 'POST', { username: 'audit-user', password: 'audit-password-123' }, 201);
  return { request, targetUrl: 'http://127.0.0.1:' + targetPort, base };
}

test('独立保存渠道或 AI 设置保留另一部分配置，空 Key 不删除已存 Key', async t => {
  const { request, targetUrl } = await harness(t);
  const key = 'original-ai-key-audit';
  const first = await request('/api/settings', 'PUT', { aiBaseUrl: targetUrl + '/v1', aiModel: 'custom-model', aiKey: key });
  const hook = { id: 'hook', name: 'Primary', url: targetUrl + '/hook', enabled: true, format: 'generic' };
  const channels = await request('/api/settings', 'PUT', { webhooks: [hook] });
  assert.equal(channels.settings.aiBaseUrl, first.settings.aiBaseUrl);
  assert.equal(channels.settings.aiModel, 'custom-model');
  assert.equal(channels.settings.hasAiKey, true);
  const ai = await request('/api/settings', 'PUT', { aiModel: 'revised-model', aiKey: '' });
  assert.deepEqual(ai.settings.webhooks, channels.settings.webhooks);
  assert.equal(ai.settings.aiBaseUrl, first.settings.aiBaseUrl);
  assert.equal(ai.settings.hasAiKey, true);
  const unchanged = await request('/api/settings', 'PUT', {});
  assert.deepEqual(unchanged.settings, ai.settings);
  await request('/api/settings', 'PUT', { aiBaseUrl: 'invalid', aiModel: 'lost-if-not-atomic', webhooks: [] }, 400);
  assert.deepEqual((await request('/api/state')).settings, unchanged.settings);
  const explicit = await request('/api/settings', 'PUT', { aiBaseUrl: '', aiModel: '' });
  assert.equal(explicit.settings.aiBaseUrl, 'https://api.openai.com/v1');
  assert.equal(explicit.settings.aiModel, '');
  assert.equal(JSON.stringify(explicit).includes(key), false);
});

test('正在读取来源或发送通知的任务不能被删除，完成后可正常删除', async t => {
  let holdRead = false, holdDelivery = false, notifications = 0;
  const readStarted = gate(), releaseRead = gate(), deliveryStarted = gate(), releaseDelivery = gate();
  const { request, targetUrl } = await harness(t, async (req, res) => {
    if (req.url === '/source') { if (holdRead) { readStarted.resolve(); await releaseRead.promise; } res.setHeader('content-type', 'text/html'); res.end(holdRead ? '<p>Available</p>' : '<p>Sold out</p>'); return; }
    if (req.url === '/hook') { for await (const _ of req) {} if (holdDelivery) { deliveryStarted.resolve(); await releaseDelivery.promise; } notifications++; res.end('ok'); return; }
    res.writeHead(404); res.end();
  });
  t.after(() => { releaseRead.resolve(); releaseDelivery.resolve(); });
  await request('/api/settings', 'PUT', { webhooks: [{ id: 'hook', name: 'Primary', url: targetUrl + '/hook', enabled: true, format: 'generic' }] });
  const created = await request('/api/monitors', 'POST', { kind: 'webpage', label: 'Stock', url: targetUrl + '/source', keyword: 'Available', mode: 'contains', intervalMinutes: 5, fetch: { mode: 'http' }, webhookIds: ['hook'] }, 201);
  const id = created.monitors[0].id;
  holdRead = true; holdDelivery = true;
  const checking = request('/api/monitors/' + id + '/check', 'POST');
  await readStarted.promise;
  const fetchingDelete = await request('/api/monitors/' + id, 'DELETE', undefined, 409);
  assert.equal(fetchingDelete.code, 'MONITOR_BUSY');
  assert.equal((await request('/api/state')).monitors.length, 1);
  releaseRead.resolve();
  await deliveryStarted.promise;
  const sendingDelete = await request('/api/monitors/' + id, 'DELETE', undefined, 409);
  assert.equal(sendingDelete.code, 'MONITOR_BUSY');
  releaseDelivery.resolve();
  const finished = await checking;
  assert.equal(finished.check.sentCount, 1);
  assert.equal(notifications, 1);
  assert.equal((await request('/api/monitors/' + id, 'DELETE')).monitors.length, 0);
  await request('/api/monitors/' + id + '/check', 'POST', undefined, 404);
  assert.equal(notifications, 1);
});

test('通知积压不延迟本轮库存读取，每轮每条只重试一次，来源失败仍重试旧通知', async t => {
  let available = false, sourceFailure = false;
  const calls = [];
  const { request, targetUrl } = await harness(t, (req, res) => {
    if (req.url === '/source') {
      calls.push('source');
      res.writeHead(sourceFailure ? 500 : 200, { 'content-type': 'text/html' });
      res.end(sourceFailure ? 'source failed' : available ? '<p>Available</p>' : '<p>Sold out</p>');
      return;
    }
    if (req.url === '/hook') { calls.push('hook'); res.writeHead(503); res.end('try later'); return; }
    res.writeHead(404); res.end();
  });
  await request('/api/settings', 'PUT', { webhooks: [{ id: 'hook', name: 'Slow channel', url: targetUrl + '/hook', enabled: true, format: 'generic' }] });
  const created = await request('/api/monitors', 'POST', { kind: 'webpage', label: 'Stock priority', url: targetUrl + '/source', keyword: 'Available', mode: 'contains', intervalMinutes: 5, fetch: { mode: 'http' }, webhookIds: ['hook'] }, 201);
  const id = created.monitors[0].id, endpoint = '/api/monitors/' + id + '/check';
  available = true;
  await request(endpoint, 'POST');
  available = false; calls.length = 0;
  await request(endpoint, 'POST');
  assert.deepEqual(calls, ['source', 'hook']);
  available = true; calls.length = 0;
  const result = await request(endpoint, 'POST');
  assert.deepEqual(calls, ['source', 'hook', 'hook']);
  assert.equal(result.check.failedCount, 2);
  assert.equal(result.monitors.find(m => m.id === id).pendingNotifications.length, 2);
  sourceFailure = true; calls.length = 0;
  const failed = await request(endpoint, 'POST');
  assert.equal(failed.check.checked, false);
  assert.equal(calls[0], 'source');
  assert.deepEqual(calls.slice(-2), ['hook', 'hook']);
  assert.equal(calls.filter(call => call === 'hook').length, 2);
});

test('AI 解析在清除或更换 Key 期间保持请求配置，响应和原始日志持续脱敏', async t => {
  const firstStarted = gate(), releaseFirst = gate(), failingStarted = gate(), releaseFailure = gate();
  const initialKey = 'audit-key-/+%secret', replacementKey = 'replacement-key-/+%secret';
  let phase = 'repair', calls = 0;
  const authorizations = [];
  const { request, targetUrl } = await harness(t, async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    authorizations.push(req.headers.authorization);
    if (phase === 'repair') {
      calls++;
      if (calls === 1) { firstStarted.resolve(); await releaseFirst.promise; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'invalid response echo ' + initialKey } }] })); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'answer', message: 'Provider echoed ' + initialKey + ' and ' + encodeURIComponent(initialKey) }) } }] })); return;
    }
    if (phase === 'question') {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'need_more_info', questions: ['You mentioned ' + replacementKey + '; what would you like to learn?'] }) } }] })); return;
    }
    failingStarted.resolve(); await releaseFailure.promise;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'old=' + initialKey + '; encoded=' + encodeURIComponent(initialKey) + '; new=' + replacementKey } }));
  });
  t.after(() => { releaseFirst.resolve(); releaseFailure.resolve(); });
  await request('/api/settings', 'PUT', { aiBaseUrl: targetUrl + '/v1', aiModel: 'audit-model', aiKey: initialKey });
  const pending = request('/api/parse', 'POST', { instruction: 'Can you explain how reminders work?' });
  await firstStarted.promise;
  await request('/api/ai/key', 'DELETE');
  releaseFirst.resolve();
  const parsed = await pending;
  assert.equal(parsed.status, 'answer');
  assert.match(parsed.message, /已隐藏的 API Key/);
  assert.deepEqual(authorizations, ['Bearer ' + initialKey, 'Bearer ' + initialKey]);
  assert.equal((await request('/api/state')).settings.hasAiKey, false);
  let serialized = JSON.stringify(await request('/api/state'));
  for (const secret of [initialKey, encodeURIComponent(initialKey)]) assert.equal(serialized.includes(secret), false);
  phase = 'failure';
  await request('/api/settings', 'PUT', { aiKey: initialKey });
  const failing = request('/api/parse', 'POST', { instruction: 'Explain reminder scheduling' }, 400);
  await failingStarted.promise;
  await request('/api/settings', 'PUT', { aiKey: replacementKey, aiModel: 'next-model' });
  releaseFailure.resolve();
  const error = await failing;
  serialized = JSON.stringify({ error, state: await request('/api/state') });
  for (const secret of [initialKey, encodeURIComponent(initialKey), replacementKey]) assert.equal(serialized.includes(secret), false);
  assert.equal(authorizations.at(-1), 'Bearer ' + initialKey);
  phase = 'question';
  const question = await request('/api/parse', 'POST', { instruction: 'Help me set up an alert' });
  assert.equal(question.status, 'need_more_info');
  assert.match(question.questions[0], /已隐藏的 API Key/);
  assert.equal(JSON.stringify({ question, state: await request('/api/state') }).includes(replacementKey), false);
});
