import test from 'node:test';
import assert from 'node:assert/strict';
import { requestedInterval, resolveInterval, validateInterval } from '../lib/rule-policy.js';
import { inferGoal, analyzePage, candidateRule } from '../lib/page-analysis.js';

test('自然语言周期支持中英文、中文数字、半分钟和组合时长，数值条件不会被误当频率', () => {
  for (const [instruction, seconds] of [
    ['每半分钟监控一次', 30], ['每两分钟检查', 120], ['每十五秒检查', 15], ['每一点五秒检查', 1.5],
    ['每小时检测一次', 3600], ['每一刻钟轮询', 900], ['每半小时', 1800], ['每1分钟30秒检查一次', 90],
    ['一分三十秒检查一次', 90], ['周期改为2小时15分钟', 8100], ['每48小时检查', 172800],
    ['check every 15 seconds', 15], ['every minute', 60], ['every 1.5 hours', 5400],
    ['每5分钟检查，改为每十秒检查', 10], ['间隔为1.25秒', 1.25], ['每5秒检查，改成半分钟', 30]
  ]) assert.equal(requestedInterval(instruction), seconds, instruction);
  for (const instruction of ['价格低于100', '接口响应超过3秒提醒', '过去10分钟失败2次', 'https://example.test/every30seconds']) {
    assert.equal(requestedInterval(instruction), undefined, instruction);
  }
});

test('频率由明确要求、现有设置、类型默认值决定，保留小数且不受旧5分钟下限和24小时上限影响', () => {
  assert.equal(resolveInterval('product_stock', '每1.25秒', { interval: 75 }), 1.25);
  assert.equal(resolveInterval('product_stock', '仅改通知内容', { interval: 75 }), 75);
  assert.equal(resolveInterval('price_change', '监控价格'), 300);
  assert.equal(resolveInterval('product_stock', '监控库存'), 30);
  assert.equal(resolveInterval('api_monitor', '监控接口'), 60);
  assert.equal(resolveInterval('webpage_change', '网页变化'), 300);
  assert.equal(resolveInterval('api_monitor', '每48小时'), 172800);
  for (const value of [0, -1, 0.5, Infinity, NaN, Number.MAX_VALUE]) assert.throws(() => validateInterval(value), /周期/);
});

test('共同业务需求编译为固定条件，并区分响应阈值与检查周期', () => {
  assert.deepEqual(inferGoal('这个接口异常通知我').condition, { operator: 'unavailable', failure_threshold: 1, initial: 'baseline' });
  assert.equal(inferGoal('接口连续失败2次通知').condition.failure_threshold, 2);
  assert.equal(inferGoal('接口连续3次故障通知').condition.failure_threshold, 3);
  const slow = inferGoal('每半分钟检查，接口响应超过3秒通知我');
  assert.equal(slow.interval, 30);
  assert.deepEqual(slow.condition, { operator: 'slow', value: 3000, initial: 'baseline' });
  assert.deepEqual(inferGoal('这个服务变慢就通知').condition, { operator: 'slow', value: 3000, initial: 'baseline' });
  assert.deepEqual(inferGoal('价格变化时提醒').condition, { operator: 'changed', initial: 'baseline' });
  assert.deepEqual(inferGoal('网页内容变化时提醒').condition, { operator: 'changed', initial: 'baseline' });
});

test('程序固定来源优先级，模型推荐其他候选不能把实际库存API换成页面数据', () => {
  const url = 'https://shop.example/product';
  const data = { product: { name: 'Switch', available: false } };
  const html = '<h1>Switch</h1><small class="stock">Sold Out</small><script type="application/json">' + JSON.stringify(data) + '</script>';
  const analysis = analyzePage(html, { url, apiResponses: [{ url: 'https://shop.example/inventory', body: JSON.stringify(data) }] });
  const alternative = analysis.candidates.find(candidate => candidate.type === 'product_stock' && candidate.detection_method !== 'api');
  assert.ok(alternative);
  const expected = candidateRule({ type: 'product_stock' }, analysis);
  for (const candidate_id of [undefined, alternative.id, 'fabricated']) {
    const actual = candidateRule({ type: 'product_stock', candidate_id }, analysis);
    assert.equal(actual.detection_method, 'api');
    assert.deepEqual(actual.extraction_rule, expected.extraction_rule);
    assert.deepEqual(actual.condition, expected.condition);
  }
});
