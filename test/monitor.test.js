import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPage, isTransition, restockedItems } from '../lib/monitor.js';

test('库存变化才发送通知，初次观察和重复检查不触发', () => {
  const monitor = { kind: 'dmit' };
  const fixture = (status) => JSON.stringify({ ok: true, products: [
    { provider: 'dmit', product_key: 'plan-1', name: 'TINY', status, last_check_at: new Date().toISOString(), stale: 0 },
    { provider: 'dmit', product_key: 'plan-2', name: 'MINI', status: '有货', last_check_at: new Date().toISOString(), stale: 0 }
  ] });
  const out = inspectPage(monitor, fixture('无货'));
  const restocked = inspectPage(monitor, fixture('有货'));
  assert.deepEqual([out.out, out.available], [1, 1]);
  assert.equal(isTransition(monitor, null, out), false);
  assert.equal(isTransition(monitor, out, restocked), true);
  assert.deepEqual(restockedItems(out, restocked).map((item) => item.name), ['TINY']);
  assert.equal(isTransition(monitor, restocked, restocked), false);
});

test('旧版 DMIT 任意有货规则首次有货即触发，持续有货不重复提醒', () => {
  const rule = { kind: 'dmit', triggerMode: 'any-available' };
  const fixture = (status) => JSON.stringify({ ok: true, products: [
    { provider: 'dmit', product_key: 'plan-1', name: 'TINY', status, last_check_at: new Date().toISOString(), stale: 0 }
  ] });
  const available = inspectPage(rule, fixture('有货'));
  const out = inspectPage(rule, fixture('无货'));
  assert.equal(isTransition(rule, null, available), true);
  assert.equal(isTransition(rule, available, available), false);
  assert.equal(isTransition(rule, available, out), false);
  assert.equal(isTransition(rule, out, available), true);
});

test('普通网页关键词规则仅在从不满足变为满足时触发', () => {
  const monitor = { kind: 'webpage', keyword: '有货', mode: 'contains' };
  const before = inspectPage(monitor, '<p>暂时缺货</p>');
  const after = inspectPage(monitor, '<p>现在有货</p>');
  assert.equal(isTransition(monitor, before, after), true);
  assert.equal(isTransition(monitor, after, after), false);
});

test('JSON、RSS 和 GitHub Release 在真实变化后触发', () => {
  const json = { kind: 'json', jsonPath: 'data.stock', operator: 'gt', expected: '0' };
  const empty = inspectPage(json, '{"data":{"stock":0}}');
  const filled = inspectPage(json, '{"data":{"stock":2}}');
  assert.equal(isTransition(json, empty, filled), true);
  assert.equal(isTransition(json, filled, filled), false);
  const rss = { kind: 'rss', keyword: '新品' };
  const feed = (title) => `<rss><channel><item><title>${title}</title><link>https://example.com/${title}</link></item></channel></rss>`;
  assert.equal(isTransition(rss, inspectPage(rss, feed('旧闻')), inspectPage(rss, feed('新品上线'))), true);
  const github = { kind: 'github' };
  const release = (id) => inspectPage(github, JSON.stringify({ id, tag_name: `v${id}`, html_url: `https://github.com/a/b/releases/tag/v${id}` }));
  assert.equal(isTransition(github, release(1), release(2)), true);
});
