import { createHash } from 'node:crypto';
import { evaluateRule } from './monitor-rule.js';

// Check the user's stock contract against controlled snapshots before saving.
// These are local dry runs; they never fetch a source or send notifications.
export function stockBehaviorTests(rule, observed) {
  if (rule.type !== 'product_stock') return [];
  const c = rule.condition, collection = ['stock_items', 'elements'].includes(rule.extraction_rule.kind);
  const base = c.operator === 'transition' ? c.from[0] : c.operator === 'equals' && c.value === 'out_of_stock' ? 'in_stock' : 'out_of_stock';
  const target = c.operator === 'transition' ? c.to[0] : c.operator === 'equals' ? c.value : base === 'in_stock' ? 'out_of_stock' : 'in_stock';
  const sample = (changed = []) => {
    if (!collection) return { value: changed.length ? target : base };
    const items = observed.items.map((item, index) => ({ ...item, state: changed.includes(index) ? target : base }));
    return { items, value: items.some(item => item.state === 'in_stock') ? 'in_stock' : 'out_of_stock',
      content_hash: createHash('sha256').update(JSON.stringify(items.map(({ id, state }) => [id, state]).sort((a,b) => a[0].localeCompare(b[0])))).digest('hex') };
  };
  const tests = [], record = (name, passed) => tests.push({ name, passed: Boolean(passed) });
  const before = sample();
  record('未满足目标时不触发', !evaluateRule(rule, before).triggered);
  const count = collection ? observed.items.length : 1;
  let each = true, repeat = true;
  for (let i = 0; i < count; i++) {
    const current = sample([i]);
    each &&= evaluateRule(rule, current, before).triggered && (!collection || current.triggered_items.length === 1 && current.triggered_items[0] === observed.items[i].id);
    repeat &&= !evaluateRule(rule, sample([i]), current).triggered;
  }
  record(collection ? '任一型号单独满足条件时触发（已测试' + count + '个型号）' : '库存达到目标时触发', each);
  record('持续满足条件不重复通知', repeat);
  if (collection && count > 1) {
    const first = sample([0]); evaluateRule(rule, first, before);
    const second = sample([0,1]);
    record('另一个型号补货不会被已满足的型号掩盖', evaluateRule(rule, second, first).triggered && second.triggered_items.length === 1 && second.triggered_items[0] === observed.items[1].id);
    const reordered = sample([0]); reordered.items.reverse();
    record('型号重排不产生新告警', !evaluateRule(rule, reordered, first).triggered);
  }
  if (c.operator === 'equals') record('首次通知策略与配置一致', evaluateRule(rule, sample([0])).triggered === (c.initial === 'notify'));
  return tests;
}
