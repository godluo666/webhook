import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function assertPrivate(value, ...secrets) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, 'Proxy credentials must not appear in public responses or logs');
}

function monitorState(monitor) {
  return {
    fetch: monitor.fetch, snapshot: monitor.snapshot, baselined: monitor.baselined,
    lastResult: monitor.lastResult, sourceRetryAt: monitor.sourceRetryAt,
    sourceFailures: monitor.sourceFailures, lastSourceError: monitor.lastSourceError,
    lastFetch: monitor.lastFetch, pendingNotifications: monitor.pendingNotifications,
    revision: monitor.revision
  };
}

async function createFixture() {
  const sockets = new Set(), proxyCalls = [], probeCalls = [];
  const fixture = { mode: 'json', challenge: false, gate: null, aiCalls: 0, notifications: 0 };
  const target = http.createServer(async (request, response) => {
    if (request.url === '/probe') {
      probeCalls.push({ headers: request.headers, at: Date.now() });
      const gate = fixture.gate;
      if (gate) {
        gate.count++;
        gate.first.resolve();
        if (gate.count >= 2) gate.second.resolve();
        await gate.release.promise;
      }
      response.setHeader('content-type', fixture.mode === 'json' ? 'application/json' : 'text/plain');
      const bodies = { json: '{"ip":"203.0.113.10"}', text: '203.0.113.10\n', trace: 'fl=fixture\nip=2001:db8::10\ntls=TLSv1.3\n', invalid: '{"ip":"not-an-address"}' };
      response.end(bodies[fixture.mode]);
      return;
    }
    if (request.url === '/source') {
      if (fixture.challenge) {
        response.setHeader('cf-mitigated', 'challenge');
        response.setHeader('content-type', 'text/html');
        response.end('<html><title>Just a moment</title>Cloudflare</html>');
      } else response.end('<p>no inventory</p>');
      return;
    }
    if (request.url === '/hook') { fixture.notifications++; response.end('ok'); return; }
    if (request.url.startsWith('/v1/')) { fixture.aiCalls++; response.setHeader('content-type', 'application/json'); response.end('{"choices":[]}'); return; }
    response.writeHead(404); response.end();
  });
  const targetPort = await listen(target), proxies = [];
  const addProxy = async ({ username = 'fixture-user', password = 'fixture-private-password', reject = false } = {}) => {
    const server = http.createServer((_request, response) => { response.writeHead(405); response.end(); });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('connect', (request, socket, head) => {
      proxyCalls.push({ target: request.url, auth: request.headers['proxy-authorization'] });
      if (reject || request.headers['proxy-authorization'] !== 'Basic ' + Buffer.from(username + ':' + password).toString('base64')) {
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      // CONNECT must retain the requested destination; the fixture never forwards externally.
      if (request.url !== '127.0.0.1:' + targetPort) { socket.destroy(); return; }
      const upstream = net.connect(targetPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.once('close', () => upstream.destroy());
    });
    const port = await listen(server);
    proxies.push(server);
    return { url: 'http://' + username + ':' + password + '@127.0.0.1:' + port, endpoint: 'http://127.0.0.1:' + port, username, password };
  };
  return Object.assign(fixture, {
    base: 'http://127.0.0.1:' + targetPort, proxyCalls, probeCalls, addProxy,
    hold() {
      const gate = { count: 0, first: deferred(), second: deferred(), release: deferred() };
      fixture.gate = gate;
      return gate;
    },
    async close() {
      fixture.gate?.release.resolve();
      for (const socket of sockets) socket.destroy();
      target.closeAllConnections();
      await Promise.all([target, ...proxies].map(server => new Promise(resolve => server.close(resolve))));
    }
  });
}

async function startApp(probeUrl) {
  const directory = await mkdtemp(path.join(tmpdir(), 'radar-proxy-connectivity-'));
  const reservation = http.createServer(), port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, stdio: 'ignore', env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: directory,
      RESEND_API_KEY: '', MAIL_FROM: '', MONITOR_BROWSER_ENABLED: '0',
      MONITOR_SS_EXECUTABLE: '', MONITOR_PROXY_TEST_URL: probeUrl
    }
  });
  const base = 'http://127.0.0.1:' + port;
  async function request(session, endpoint, method = 'GET', body) {
    const response = await fetch(base + endpoint, {
      method, headers: { ...(session.cookie ? { cookie: session.cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (response.headers.get('set-cookie')) session.cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: await response.json() };
  }
  async function ok(session, endpoint, method, body) {
    const result = await request(session, endpoint, method, body);
    assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
    return result.body;
  }
  async function register(username) {
    const session = {};
    await ok(session, '/api/auth/register', 'POST', { username, password: 'a-strong-fixture-password-123' });
    return session;
  }
  async function close() {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill();
      await within(closed, 1500, 'Application shutdown timed out').catch(() => {});
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await ok({}, '/api/auth/status'); return { request, ok, register, close }; }
      catch { if (child.exitCode !== null) break; await delay(50); }
    }
    throw new Error('Proxy test application did not start');
  } catch (error) { await close(); throw error; }
}

test('proxy connectivity needs no target, reports exit IP without saving, and import always verifies', async () => {
  const fixture = await createFixture(), proxy = await fixture.addProxy();
  const app = await startApp(fixture.base + '/probe');
  try {
    const alice = await app.register('alice');
    await app.ok(alice, '/api/settings', 'PUT', { aiBaseUrl: fixture.base + '/v1', aiModel: 'fixture-model', aiKey: 'fixture-ai-private-key', webhooks: [{ id: 'hook', name: 'Fixture', url: fixture.base + '/hook' }] });
    const created = await app.ok(alice, '/api/monitors', 'POST', { kind: 'webpage', label: 'Inventory', url: fixture.base + '/source', keyword: 'in stock', intervalMinutes: 5, webhookIds: ['hook'], fetch: { mode: 'http', proxy: 'direct' } });
    const previousMonitor = monitorState(created.monitors[0]);
    const report = await app.ok(alice, '/api/source-proxy/test', 'POST', { proxyUrl: proxy.url });
    assert.equal(report.ok, true);
    assert.equal(report.purpose, 'connectivity');
    assert.equal(report.ip, '203.0.113.10');
    assert.equal(report.endpoint, proxy.endpoint);
    assert.ok(Number.isFinite(Date.parse(report.testedAt)));
    assert.ok(report.durationMs >= 0);
    assert.equal(fixture.probeCalls.length, 1);
    assert.equal(fixture.proxyCalls[0].auth, 'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64'));
    assert.equal(fixture.probeCalls[0].headers['proxy-authorization'], undefined);
    const tested = await app.ok(alice, '/api/state');
    assert.equal(tested.settings.hasSourceProxy, false);
    assert.deepEqual(monitorState(tested.monitors[0]), previousMonitor);
    assertPrivate(report, proxy.password, proxy.username, proxy.url);
    const saved = await app.ok(alice, '/api/source-proxy', 'PUT', { proxyUrl: proxy.url, applyAll: true });
    assert.equal(fixture.probeCalls.length, 2, 'Import must verify again rather than trust a previous test');
    assert.equal(saved.settings.hasSourceProxy, true);
    assert.equal(saved.settings.sourceProxyEndpoint, proxy.endpoint);
    assert.equal(saved.settings.sourceProxyTest.ip, report.ip);
    assert.ok(Number.isFinite(Date.parse(saved.settings.sourceProxyTest.testedAt)));
    assert.equal(saved.monitors[0].fetch.proxy, 'direct');
    assert.deepEqual(monitorState(saved.monitors[0]), previousMonitor);
    assert.deepEqual(saved.monitors[0].snapshot, created.monitors[0].snapshot);
    assert.equal(saved.monitors[0].baselined, created.monitors[0].baselined);
    const again = await app.ok(alice, '/api/source-proxy', 'PUT', { applyAll: true });
    assert.equal(fixture.probeCalls.length, 3, 'Repeated import must not use a cached connectivity result');
    const savedMarker = again.settings.sourceProxyTest;
    for (const [mode, expectedIP] of [['text', '203.0.113.10'], ['trace', '2001:db8::10']]) {
      fixture.mode = mode;
      const retest = await app.ok(alice, '/api/source-proxy/test', 'POST', {});
      assert.equal(retest.ip, expectedIP);
      assert.deepEqual((await app.ok(alice, '/api/state')).settings.sourceProxyTest, savedMarker, 'Test must not update saved proxy metadata');
    }
    assert.equal(fixture.aiCalls, 0);
    assert.equal(fixture.notifications, 0);
    assertPrivate(await app.ok(alice, '/api/state'), proxy.password, proxy.username, proxy.url, 'fixture-ai-private-key');
    const bob = await app.register('bob');
    const bobState = await app.ok(bob, '/api/state');
    assert.equal(bobState.settings.hasSourceProxy, false);
    assert.equal(bobState.monitors.length, 0);
    assert.equal(bobState.logs.length, 0);
  } finally { await app.close(); await fixture.close(); }
});

test('refused, unauthenticated, invalid-IP and unavailable-SS imports preserve the previous proxy and monitor state', async () => {
  const fixture = await createFixture();
  const proxy = await fixture.addProxy(), unauthenticated = await fixture.addProxy({ password: 'rejected-private-password', reject: true });
  const app = await startApp(fixture.base + '/probe');
  try {
    const alice = await app.register('alice');
    await app.ok(alice, '/api/settings', 'PUT', { webhooks: [{ id: 'hook', name: 'Fixture', url: fixture.base + '/hook' }] });
    const created = await app.ok(alice, '/api/monitors', 'POST', { kind: 'webpage', label: 'Inventory', url: fixture.base + '/source', keyword: 'in stock', intervalMinutes: 5, webhookIds: ['hook'], fetch: { mode: 'http', proxy: 'direct' } });
    await app.ok(alice, '/api/source-proxy', 'PUT', { proxyUrl: proxy.url });
    fixture.challenge = true;
    const checked = await app.ok(alice, '/api/monitors/' + created.monitors[0].id + '/check', 'POST');
    assert.ok(checked.monitors[0].sourceRetryAt);
    const previous = await app.ok(alice, '/api/state'), previousMonitor = monitorState(previous.monitors[0]);
    const assertUnchanged = async () => {
      const state = await app.ok(alice, '/api/state');
      assert.equal(state.settings.hasSourceProxy, true);
      assert.equal(state.settings.sourceProxyEndpoint, proxy.endpoint);
      assert.deepEqual(state.settings.sourceProxyTest, previous.settings.sourceProxyTest);
      assert.deepEqual(monitorState(state.monitors[0]), previousMonitor);
      return state;
    };
    for (const candidate of ['http://127.0.0.1:1', unauthenticated.url]) {
      const failure = await app.request(alice, '/api/source-proxy', 'PUT', { proxyUrl: candidate, applyAll: true });
      assert.ok(failure.status >= 400);
      if (candidate === 'http://127.0.0.1:1') assert.equal(failure.body.code, 'PROXY_CONNECTION_REFUSED');
      if (candidate === unauthenticated.url) {
        assert.equal(failure.body.code, 'PROXY_AUTH_FAILED');
        const logs = (await app.ok(alice, '/api/logs')).logs;
        const authenticationFailure = logs.find(log => log.kind === 'proxy-test' && log.status === 'error');
        assert.equal(authenticationFailure.raw.errorCode, 'PROXY_AUTH_FAILED');
        assert.equal(authenticationFailure.raw.fetch.attempts[0].errorCode, 'PROXY_AUTH_FAILED');
      }
      assertPrivate(failure, proxy.password, unauthenticated.password, unauthenticated.url);
      assertPrivate(await assertUnchanged(), proxy.password, unauthenticated.password, unauthenticated.url);
    }
    fixture.mode = 'invalid';
    const invalid = await app.request(alice, '/api/source-proxy', 'PUT', { proxyUrl: proxy.url, applyAll: true });
    assert.ok(invalid.status >= 400, 'HTTP 200 with an invalid IP must not count as a healthy proxy');
    assert.equal(invalid.body.code, 'PROXY_PROBE_RESPONSE');
    await assertUnchanged();
    const beforeSS = fixture.probeCalls.length;
    const ssPassword = 'unavailable-ss-private-password';
    const unavailable = await app.request(alice, '/api/source-proxy', 'PUT', { proxyUrl: 'ss://aes-256-gcm:' + ssPassword + '@127.0.0.1:8388', applyAll: true });
    assert.ok(unavailable.status >= 400);
    assert.match(unavailable.body.error, /SS|Shadowsocks/i);
    assert.equal(unavailable.body.code, 'SOURCE_PROXY_UNAVAILABLE');
    assert.equal(fixture.probeCalls.length, beforeSS);
    assertPrivate(unavailable, ssPassword);
    for (const [endpoint, method] of [['/api/source-proxies','POST'],['/api/source-proxy','PUT'],['/api/source-proxy/test','POST']]) {
      const generated=await app.request(alice,endpoint,method,{shadowsocks:{server:'127.0.0.1',port:8388,method:'aes-256-gcm',password:ssPassword}});
      assert.equal(generated.body.code,'SOURCE_PROXY_UNAVAILABLE','Structured SS input must reach the SS bridge');
      assertPrivate(generated,ssPassword);await assertUnchanged();
      const rejected=await app.request(alice,endpoint,method,{proxyUrl:proxy.url,shadowsocks:{server:'127.0.0.1',port:0,method:'aes-256-gcm',password:ssPassword}});
      assert.equal(rejected.status,400);assert.match(rejected.body.error,/端口/);assertPrivate(rejected,ssPassword);await assertUnchanged();
    }
    assert.equal(fixture.probeCalls.length,beforeSS,'Invalid or unavailable SS candidates must never probe the saved HTTP proxy');
    assertPrivate(await assertUnchanged(), proxy.password, unauthenticated.password, ssPassword);
    const cleared = await app.ok(alice, '/api/source-proxy', 'DELETE');
    assert.equal(cleared.settings.hasSourceProxy, false, 'Clear must not require a successful probe');
    assert.equal(fixture.probeCalls.length, beforeSS);
    assert.equal(fixture.aiCalls, 0);
    assert.equal(fixture.notifications, 0);
  } finally { await app.close(); await fixture.close(); }
});

test('proxy tests isolate accounts, reject another in-flight candidate, and cannot restore a proxy cleared during import', async () => {
  const fixture = await createFixture();
  const proxy = await fixture.addProxy(), replacement = await fixture.addProxy({ username: 'second-fixture-user', password: 'second-private-password' });
  const app = await startApp(fixture.base + '/probe');
  const pending = [];
  try {
    const alice = await app.register('alice');
    await app.ok(alice, '/api/source-proxy', 'PUT', { proxyUrl: proxy.url });
    const bob = await app.register('bob');
    const gate = fixture.hold();
    const importing = app.request(alice, '/api/source-proxy', 'PUT', { proxyUrl: replacement.url, applyAll: true });
    pending.push(importing);
    await within(gate.first.promise, 5000, 'Import did not reach the local probe');
    const sharedTest = app.request(alice, '/api/source-proxy/test', 'POST', { proxyUrl: replacement.url });
    pending.push(sharedTest);
    const busy = await app.request(alice, '/api/source-proxy/test', 'POST', { proxyUrl: proxy.url });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, 'PROXY_TEST_BUSY');
    const bobTest = app.request(bob, '/api/source-proxy/test', 'POST', { proxyUrl: proxy.url });
    pending.push(bobTest);
    await within(gate.second.promise, 5000, 'Another account must be able to test independently');
    const cleared = await app.ok(alice, '/api/source-proxy', 'DELETE');
    assert.equal(cleared.settings.hasSourceProxy, false);
    gate.release.resolve();
    const obsolete = await importing;
    assert.equal(obsolete.status, 409, 'An import verified before clear must not overwrite the newer settings');
    assert.equal(obsolete.body.code, 'PROXY_CONFIG_CHANGED');
    const independent = await bobTest;
    assert.equal(independent.status, 200);
    assert.equal(independent.body.ip, '203.0.113.10');
    const sharedReport = await sharedTest;
    assert.equal(sharedReport.status, 200);
    assert.equal(sharedReport.body.ip, independent.body.ip);
    assert.equal(gate.count, 2, 'Same-account tests for the same candidate must share the in-flight probe');
    const aliceState = await app.ok(alice, '/api/state'), bobState = await app.ok(bob, '/api/state');
    assert.equal(aliceState.settings.hasSourceProxy, false);
    assert.equal(bobState.settings.hasSourceProxy, false, 'A test never imports the candidate');
    assertPrivate([aliceState, bobState, obsolete, independent], proxy.password, replacement.password, proxy.username, replacement.username);
    assert.equal(fixture.aiCalls, 0);
    assert.equal(fixture.notifications, 0);
  } finally {
    fixture.gate?.release.resolve();
    await Promise.allSettled(pending);
    await app.close(); await fixture.close();
  }
});
