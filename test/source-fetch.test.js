import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceFetcher, isChallengePage, retryAfterMs, validateFetchOptions } from '../lib/source-fetch.js';

const challenge = '<!doctype html><html><title>Just a moment...</title><script>window._cf_chl_opt = {};</script>Buy now</html>';

test('验证页检测同时覆盖响应头和 HTML，不误判普通 Cloudflare 文本或 JSON', () => {
  assert.equal(isChallengePage('anything', new Headers({ 'cf-mitigated': 'challenge' })), true);
  assert.equal(isChallengePage(challenge), true);
  assert.equal(isChallengePage('<html><body>Cloudflare documentation</body></html>'), false);
  assert.equal(isChallengePage('{"name":"Just a moment","description":"cloudflare"}', { 'content-type': 'application/json' }), false);
  assert.deepEqual(validateFetchOptions(), { mode: 'auto', proxy: 'default' });
  assert.throws(() => validateFetchOptions({ mode: 'auto', proxy: 'random' }));
  assert.equal(retryAfterMs('120'), 120000);
  assert.equal(retryAfterMs('999999'), 3600000);
});

test('自动读取遇到验证时转浏览器，账户与出口参数保留，元数据不含凭据', async () => {
  let options;
  const read = createSourceFetcher({
    fetchImpl: async () => new Response(challenge, { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
    browserFetch: async (url, value) => { options = value; return { body: '{"stock":1}', status: 200, headers: {}, finalUrl: url }; }
  });
  const result = await read('https://example.com/products', { userId: 'alice', expectsJson: true, proxyUrl: 'http://proxy-user:proxy-secret@127.0.0.1:9999' });
  assert.equal(options.userId, 'alice');
  assert.equal(options.expectsJson, true);
  assert.match(options.proxyUrl, /proxy-secret/);
  assert.equal(JSON.parse(result.body).stock, 1);
  assert.deepEqual(result.metadata.attempts.map((a) => a.outcome), ['challenge', 'success']);
  assert.equal(result.metadata.route, 'proxy');
  assert.equal(JSON.stringify(result.metadata).includes('proxy-secret'), false);
});

test('浏览器和 HTTP 返回 200 验证页仍失败，故障输出隐藏代理认证', async () => {
  const read = createSourceFetcher({
    fetchImpl: async () => new Response(challenge, { status: 200 }),
    browserFetch: async () => ({ body: challenge, status: 200, headers: {} })
  });
  await assert.rejects(read('https://example.com', { userId: 'alice' }), (e) => e.code === 'SOURCE_CHALLENGE' && e.fetchDetails.attempts.length === 2);
  await assert.rejects(read('https://example.com', { userId: 'alice', mode: 'http' }), (e) => e.code === 'SOURCE_CHALLENGE' && e.fetchDetails.attempts.length === 1);
  const failed = createSourceFetcher({ browserFetch: async () => { throw new Error('proxy http://user:secret@127.0.0.1:1 rejected secret'); } });
  await assert.rejects(failed('https://example.com', { userId: 'alice', mode: 'browser', proxyUrl: 'http://user:secret@127.0.0.1:1' }), (e) => !JSON.stringify({ message: e.message, details: e.fetchDetails }).includes('secret'));
});

test('限流遵守 Retry-After，短暂故障最多重试一次', async () => {
  let count = 0, waits = [];
  const read = createSourceFetcher({ fetchImpl: async () => ++count === 1 ? new Response('retry', { status: 503 }) : new Response('ready'), wait: async (ms) => waits.push(ms) });
  assert.equal((await read('https://example.com')).body, 'ready');
  assert.equal(count, 2);
  assert.deepEqual(waits, [250]);
  const rateLimited = createSourceFetcher({ fetchImpl: async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } }) });
  await assert.rejects(rateLimited('https://example.com'), (e) => e.code === 'SOURCE_RATE_LIMITED' && e.fetchDetails.retryAfterMs === 120000 && e.fetchDetails.attempts.length === 1);
});
