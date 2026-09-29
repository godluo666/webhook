import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGeneratedPlan, inspectGenerated } from '../lib/generated.js';
import { validateNotification, renderNotification, notificationSample } from '../lib/notification.js';

test('通知保留匹配名称和逐项变化，只包含本次变化的型号', () => {
  const plan = validateGeneratedPlan({ sourceType: 'json', mode: 'item-transition', path: 'products', filters: [], idPath: 'id', namePath: 'spec.model', statePath: 'stock', fromValues: [0], toValues: [1] });
  const before = inspectGenerated(plan, JSON.stringify({ products: [{ id: 'a', spec: { model: '型号 A' }, stock: 0 }, { id: 'b', spec: { model: '型号 B' }, stock: 1 }] }));
  const after = inspectGenerated(plan, JSON.stringify({ products: [{ id: 'a', spec: { model: '型号 A' }, stock: 1 }, { id: 'b', spec: { model: '型号 B' }, stock: 1 }] }));
  const rule = { kind: 'generated', label: '库存变化', plan, notification: { title: '{{name}}', body: '本次：{{items}}，共 {{count}} 条。' } };
  const payload = renderNotification(rule, after, before);
  assert.equal(payload.message, '本次：型号 A，共 1 条。');
  assert.doesNotMatch(payload.message, /型号 B/);
  assert.match(renderNotification({ ...rule, notification: null }, after, before).message, /型号 A · 0 → 1/);
});

test('任意匹配自动识别名称，同时尊重用户自定义正文', () => {
  const plan = validateGeneratedPlan({ sourceType: 'json', mode: 'any', path: 'jobs', filters: [{ path: 'status', operator: 'equals', expected: 'failed' }] });
  const current = inspectGenerated(plan, '{"jobs":[{"name":"备份任务","status":"failed"},{"model":"迁移任务","status":"failed"},{"name":"正常任务","status":"ok"}]}');
  assert.deepEqual(current.names, ['备份任务', '迁移任务']);
  const monitor = { kind: 'generated', label: '任务失败', plan, notification: { title: '需要处理', body: '请检查任务。\n{{details}}' } };
  const payload = renderNotification(monitor, current);
  assert.match(payload.message, /备份任务/);
  assert.match(payload.message, /迁移任务/);
  assert.doesNotMatch(payload.message, /正常任务/);
  assert.equal(renderNotification({ ...monitor, notification: { body: '只发送我写的这句话' } }, current).message, '只发送我写的这句话');
  assert.equal(notificationSample(monitor, current).basis, 'observed');
  assert.equal(notificationSample(monitor, { matched: false, count: 0 }).basis, 'sample');
});

test('预览及实际渲染兼容数值、网页、服务、日志、订阅和日历提醒', () => {
  const changed = { kind: 'generated', label: '版本', plan: { sourceType: 'json', mode: 'changed' }, notification: { body: '{{previous}} → {{value}}' } };
  assert.match(renderNotification(changed, { value: 'v2' }, { value: 'v1' }).message, /v1 → v2/);
  const html = { kind: 'generated', label: '网页', plan: { sourceType: 'html', mode: 'contains', keyword: '恢复' } };
  const inspected = inspectGenerated(html.plan, '<p>服务A恢复，已完成处理</p>');
  assert.match(renderNotification(html, inspected).message, /服务A恢复/);
  const log = { kind: 'generated', label: '错误日志', plan: { sourceType: 'log', mode: 'new-line', keyword: 'ERROR' } };
  assert.match(renderNotification(log, { matches: 1, summary: 'ERROR payment timeout' }).message, /payment timeout/);
  const service = { kind: 'generated', label: '服务', plan: { sourceType: 'service', mode: 'unavailable' } };
  assert.match(renderNotification(service, { summary: 'HTTP 503 · 12 ms' }).message, /HTTP 503/);
  const feed = { kind: 'generated', label: '新闻', plan: { sourceType: 'rss', mode: 'new-item' } };
  assert.match(renderNotification(feed, { entries: [{ title: '刚发布的文章', link: 'https://example.com/news' }] }).message, /刚发布的文章/);
  const reminder = { kind: 'reminder', label: '开会', message: '带上会议材料', notification: { title: '该出发了', body: '{{message}}' } };
  assert.equal(renderNotification(reminder).message, '带上会议材料');
  assert.equal(notificationSample(reminder).basis, 'reminder');
  assert.equal(renderNotification({ ...reminder, message: '长'.repeat(2000), notification: null }).message.length, 2000);
});

test('动态变量仅作文本替换，禁止任意模板变量并限制消息长度', () => {
  assert.throws(() => validateNotification({ body: '{{constructor}}' }), /不支持/);
  assert.throws(() => validateNotification({ body: '{{unfinished' }), /格式无效/);
  const monitor = { kind: 'generated', label: 'test', plan: { mode: 'any' } };
  const payload = renderNotification(monitor, { count: 100, names: Array.from({ length: 20 }, (_, i) => 'name-' + i + 'x'.repeat(160)) });
  assert.ok(payload.message.length <= 1800);
  assert.match(payload.message, /截断/);
  assert.equal(validateGeneratedPlan({ sourceType: 'service', mode: 'slow' }).thresholdMs, 3000);
});
