import test from 'node:test';
import assert from 'node:assert/strict';
import { createProxyTester } from '../lib/proxy-connectivity.js';

const username = 'unit-proxy-account';
const password = 'unit-private@password/2026';
const proxyUrl = 'http://' + username + ':' + encodeURIComponent(password) + '@127.0.0.1:12345';
const basicToken = Buffer.from(username + ':' + password).toString('base64');
const probeUrls = ['https://probe-one.invalid/ip', 'https://probe-two.invalid/ip'];

function assertPrivate(value, ...secrets) {
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, 'Public diagnostics must hide proxy credentials');
}

function assertClosed(dispatchers) {
  assert.ok(dispatchers.length > 0);
  for (const dispatcher of dispatchers) assert.equal(dispatcher.destroyed, true, 'Each completed probe must release its scoped dispatcher');
}

test('default proxy probes fall back after a network failure and return only redacted attempt metadata', async () => {
  const calls = [], dispatchers = [];
  const check = createProxyTester({
    fetchImpl: async (url, options) => {
      calls.push(url); dispatchers.push(options.dispatcher);
      if (calls.length === 1) {
        throw new TypeError('fetch failed ' + proxyUrl, { cause: Object.assign(new Error('reset with Proxy-Authorization: Basic ' + basicToken + ' password ' + password), { code: 'ECONNRESET' }) });
      }
      return new Response('fl=unit\nip=203.0.113.10\ntls=TLSv1.3\n', { status: 200 });
    }
  });
  const report = await check(proxyUrl);
  assert.equal(report.ok, true);
  assert.equal(report.ip, '203.0.113.10');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0], calls[1], 'Fallback must use a separate probe endpoint');
  assert.deepEqual(report.fetch.attempts.map(attempt => attempt.outcome), ['error', 'success']);
  assert.match(report.fetch.attempts[0].networkCode, /ECONNRESET/);
  assertPrivate(report, username, password, encodeURIComponent(password), proxyUrl, basicToken);
  assertClosed(dispatchers);
});

test('all failed probes reject and retain the separate HTTP and invalid-response diagnostics', async () => {
  const dispatchers = [];
  let calls = 0;
  const check = createProxyTester({
    urls: probeUrls,
    fetchImpl: async (_url, options) => {
      dispatchers.push(options.dispatcher);
      return ++calls === 1 ? new Response('temporarily unavailable', { status: 503 }) : new Response('{"ip":"not-an-ip"}', { status: 200 });
    }
  });
  await assert.rejects(check(proxyUrl), error => {
    assert.equal(error.code, 'PROXY_PROBE_RESPONSE');
    assert.equal(error.fetchDetails.route, 'proxy');
    assert.equal(error.fetchDetails.purpose, 'connectivity');
    assert.deepEqual(error.fetchDetails.attempts.map(attempt => attempt.outcome), ['error', 'error']);
    assert.deepEqual(error.fetchDetails.attempts.map(attempt => attempt.httpStatus), [503, 200]);
    assert.deepEqual(error.fetchDetails.attempts.map(attempt => attempt.errorCode), ['PROXY_PROBE_HTTP', 'PROXY_PROBE_RESPONSE']);
    assertPrivate({ message: error.message, details: error.fetchDetails }, username, password, proxyUrl, basicToken);
    return true;
  });
  assert.equal(calls, 2);
  assertClosed(dispatchers);
});

test('a probe that waits for its abort signal times out with an actionable timeout message', async () => {
  const dispatchers = [];
  const check = createProxyTester({
    urls: [probeUrls[0]], timeoutMs: 20,
    fetchImpl: async (_url, options) => {
      dispatchers.push(options.dispatcher);
      return new Promise((_resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('Probe did not receive its timeout signal')), 1000);
        const aborted = () => { clearTimeout(guard); reject(options.signal.reason); };
        if (options.signal.aborted) aborted();
        else options.signal.addEventListener('abort', aborted, { once: true });
      });
    }
  });
  await assert.rejects(check(proxyUrl), error => {
    assert.equal(error.code, 'PROXY_TIMEOUT');
    assert.match(error.message, /\u8d85\u65f6/);
    assert.match(error.fetchDetails.attempts[0].networkCode, /TimeoutError/);
    assert.equal(error.fetchDetails.attempts.length, 1);
    return true;
  });
  assertClosed(dispatchers);
});

test('a valid IP response at the size limit succeeds while a larger response is refused', async () => {
  const dispatchers = [];
  let size = 4096;
  const check = createProxyTester({
    urls: [probeUrls[0]],
    fetchImpl: async (_url, options) => {
      dispatchers.push(options.dispatcher);
      return new Response('{"ip":"203.0.113.10"}'.padEnd(size, ' '), { status: 200 });
    }
  });
  assert.equal((await check(proxyUrl)).ip, '203.0.113.10');
  size = 4097;
  await assert.rejects(check(proxyUrl), error => {
    assert.equal(error.code, 'PROXY_PROBE_RESPONSE');
    assert.match(error.message, /\u54cd\u5e94\u8fc7\u5927/);
    assert.equal(error.fetchDetails.attempts[0].httpStatus, 200);
    return true;
  });
  assertClosed(dispatchers);
});

test('nested failures hide both SS node secrets and the private local bridge URL and Basic token', async () => {
  const nodePassword = 'unit-node@private/secret-2026';
  const nodeUrl = 'ss://aes-256-gcm:' + encodeURIComponent(nodePassword) + '@node.invalid:8388';
  const bridgeUser = 'unit-bridge-account', bridgePassword = 'unit-bridge@private/password';
  const bridgeUrl = 'http://' + bridgeUser + ':' + encodeURIComponent(bridgePassword) + '@127.0.0.1:54321';
  const bridgeToken = Buffer.from(bridgeUser + ':' + bridgePassword).toString('base64');
  const dispatchers = [];
  const check = createProxyTester({
    urls: [probeUrls[0]],
    withProxy: async (_node, read) => read(bridgeUrl),
    fetchImpl: async (_url, options) => {
      dispatchers.push(options.dispatcher);
      const deepest = Object.assign(new Error('node=' + nodeUrl + ' node-password=' + nodePassword + ' local=' + bridgeUrl + ' local-password=' + bridgePassword + ' Proxy-Authorization: Basic ' + bridgeToken), { code: 'EHOSTUNREACH' });
      throw new TypeError('fetch failed', { cause: new Error('wrapper failure', { cause: new Error('another wrapper', { cause: deepest }) }) });
    }
  });
  await assert.rejects(check(nodeUrl), error => {
    assert.match(error.fetchDetails.attempts[0].networkCode, /EHOSTUNREACH/);
    assert.equal(error.fetchDetails.attempts[0].outcome, 'error');
    assertPrivate({ message: error.message, details: error.fetchDetails },
      nodeUrl, nodePassword, encodeURIComponent(nodePassword), bridgeUrl, bridgeUser, bridgePassword, encodeURIComponent(bridgePassword), bridgeToken);
    assert.match(error.fetchDetails.attempts[0].networkCause, /\[redacted\]/);
    return true;
  });
  assertClosed(dispatchers);
});
