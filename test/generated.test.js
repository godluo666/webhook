import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGeneratedPlan, inspectGenerated, transitionGenerated, describeGeneratedPlan } from '../lib/generated.js';

test('按需生成的任意有货逻辑在首次满足时通知，持续有货不重复通知', () => {
  const plan = validateGeneratedPlan({ sourceType: 'json', mode: 'any', initial: 'notify', path: 'products', filters: [
    { path: 'provider', operator: 'equals', expected: 'dmit' },
    { path: 'stale', operator: 'equals', expected: 0 },
    { path: 'last_check_at', operator: 'withinMinutes', expected: 120 },
    { path: 'status', operator: 'in', expected: ['有货', 'available'] }
  ] });
  const fixture = (status) => JSON.stringify({ products: [{ provider: 'dmit', stale: 0, last_check_at: new Date().toISOString(), status }] });
  const available = inspectGenerated(plan, fixture('有货'));
  const out = inspectGenerated(plan, fixture('无货'));
  assert.match(describeGeneratedPlan(plan), /首次检查满足时立即通知/);
  assert.equal(transitionGenerated(plan, null, available), true);
  assert.equal(transitionGenerated(plan, available, available), false);
  assert.equal(transitionGenerated(plan, available, out), false);
  assert.equal(transitionGenerated(plan, out, available), true);
});

test('按需生成的逐项补货逻辑只在指定状态变化时通知', () => {
  const plan = validateGeneratedPlan({ sourceType: 'json', mode: 'item-transition', initial: 'baseline', path: 'products', filters: [], idPath: 'id', statePath: 'status', fromValues: ['无货'], toValues: ['有货'] });
  const before = inspectGenerated(plan, '{"products":[{"id":"a","status":"无货"}]}');
  const after = inspectGenerated(plan, '{"products":[{"id":"a","status":"有货"}]}');
  assert.equal(transitionGenerated(plan, null, after), false);
  assert.equal(transitionGenerated(plan, before, after), true);
  assert.equal(transitionGenerated(plan, after, after), false);
});

test('字段变化逻辑首次只记录，适用于版本号等来源', () => {
  const plan = validateGeneratedPlan({ sourceType: 'json', mode: 'changed', initial: 'notify', path: 'tag_name' });
  const old = inspectGenerated(plan, '{"tag_name":"v1"}');
  const next = inspectGenerated(plan, '{"tag_name":"v2"}');
  assert.equal(plan.initial, 'baseline');
  assert.equal(transitionGenerated(plan, null, old), false);
  assert.equal(transitionGenerated(plan, old, next), true);
});

test('拒绝超出受约束逻辑范围的生成结果', () => {
  assert.throws(() => validateGeneratedPlan({ sourceType: 'javascript', mode: 'eval' }), /不支持/);
  assert.throws(() => validateGeneratedPlan({ sourceType: 'json', mode: 'compare', path: '__proto__.x', operator: 'equals', expected: 'yes' }), /字段路径/);
});


test('服务连续失败达到指定次数才通知，恢复后重新计数', () => {
  const plan = validateGeneratedPlan({ sourceType: 'service', mode: 'unavailable', initial: 'notify', failureThreshold: 3 });
  const failed = () => ({ matched: true, summary: '不可用' });
  const healthy = () => ({ matched: false, summary: '可用' });
  const first = failed();
  assert.equal(transitionGenerated(plan, null, first), false);
  const second = failed();
  assert.equal(transitionGenerated(plan, first, second), false);
  const third = failed();
  assert.equal(transitionGenerated(plan, second, third), true);
  const fourth = failed();
  assert.equal(transitionGenerated(plan, third, fourth), false);
  const recovered = healthy();
  assert.equal(transitionGenerated(plan, fourth, recovered), false);
  const again = failed();
  assert.equal(transitionGenerated(plan, recovered, again), false);
  assert.equal(again.consecutiveFailures, 1);
  assert.match(describeGeneratedPlan(plan), /连续 3 次不可用/);
});
