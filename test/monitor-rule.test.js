import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMonitorRule, extractRule, evaluateRule, stockValue, numberValue, ruleSignature } from '../lib/monitor-rule.js';
import { analyzePage, candidateRule, inferGoal } from '../lib/page-analysis.js';
import { createRuleService } from '../lib/rule-service.js';
import { createScheduler } from '../lib/scheduler.js';

const html = '<h1>Nintendo Switch</h1><main><button id="buy" disabled>Sold Out</button><span class="price">￥300</span></main>';
const rule = (patch = {}) => validateMonitorRule({
  type: 'product_stock', url: 'https://shop.example/product', name: 'Switch', detection_method: 'dom',
  target_element: { selector: '#buy', label: '购买按钮' }, extraction_rule: { kind: 'stock' }, ...patch
});
test('统一规则严格限制类型、检测方式与条件，剥离模型自由字段', () => {
  const result = rule({ invented: 'ignored', condition: { operator: 'transition' } });
  assert.equal(result.interval, 30);
  assert.equal(result.intervalMinutes, 0.5);
  assert.equal(result.invented, undefined);
  assert.deepEqual(result.condition.from, ['out_of_stock']);
  assert.throws(() => rule({ type: 'custom' }));
  assert.throws(() => rule({ detection_method: 'javascript' }));
  assert.throws(() => rule({ condition: { operator: 'lt', value: 100 } }));
  assert.throws(() => rule({ extraction_rule: { kind: 'stock', path: ['__proto__'] } }));
});
test('缺货→有货只触发一次；未知、混合与不存在的元素明确失败', () => {
  const monitor = rule();
  const before = extractRule(monitor, html);
  assert.equal(before.value, 'out_of_stock');
  assert.equal(evaluateRule(monitor, before).triggered, false);
  const after = extractRule(monitor, '<button id="buy">Add To Cart</button>');
  assert.equal(after.value, 'in_stock');
  assert.equal(evaluateRule(monitor, after, before).triggered, true);
  assert.equal(evaluateRule(monitor, extractRule(monitor, '<button id="buy">Add To Cart</button>'), after).triggered, false);
  assert.throws(() => extractRule(monitor, '<button class="new">Sold Out</button>'), /不存在/);
  assert.throws(() => extractRule(monitor, '<button id="buy">Loading</button>'), /未识别/);
  assert.throws(() => extractRule(monitor, '<button id="buy">Sold Out</button><button id="buy">Buy now</button>'), /多个/);
  assert.throws(() => stockValue('Sold Out Add To Cart'), /同时/);
  assert.equal(stockValue('https://schema.org/InStock', 'availability'), 'in_stock');
});
test('真实价格提取及阈值判断，拒绝价格区间和空值', () => {
  const monitor = rule({ type: 'price_change', target_element: { selector: '.price' }, extraction_rule: { kind: 'number' }, condition: { operator: 'lt', value: 200 } });
  const before = extractRule(monitor, html);
  evaluateRule(monitor, before);
  const after = extractRule(monitor, '<span class="price">￥199</span>');
  assert.equal(evaluateRule(monitor, after, before).triggered, true);
  assert.equal(numberValue('$1,299.50'), 1299.5);
  assert.equal(numberValue('199,95 €'), 199.95);
  assert.throws(() => numberValue('100 - 200'));
  assert.throws(() => numberValue(''));
});
test('分析优先使用实际库存API，其次JSON/结构化数据，再购买按钮', () => {
  const source = html + '<script type="application/ld+json">{"@type":"Product","name":"Switch","sku":"SW","offers":{"availability":"https://schema.org/OutOfStock","price":"300"}}</script>';
  const analysis = analyzePage(source, { url: 'https://shop.example/product', apiResponses: [{ url: 'https://shop.example/api/product', body: '{"product":{"sku":"SW","available":false,"price":300}}' }] });
  const stock = analysis.candidates.filter(c => c.type === 'product_stock');
  assert.equal(stock[0].detection_method, 'api');
  assert.equal(stock[0].value, 'out_of_stock');
  assert.ok(stock.some(c => c.extraction_rule.kind === 'structured_data'));
  const candidate = candidateRule({ type: 'product_stock' }, analysis);
  assert.equal(candidate.extraction_rule.endpoint, 'https://shop.example/api/product');
  assert.equal(candidate.url, 'https://shop.example/product');
  assert.equal(candidate.interval, 30);
});
test('多SKU库存统一提取全部型号，价格仍不自动选取一个SKU', () => {
  const analysis = analyzePage('{"variants":[{"sku":"A","available":false,"price":100},{"sku":"B","available":true,"price":200}]}', { url: 'https://shop.example/data' });
  assert.equal(analysis.candidates.filter(c => c.type === 'price_change').length, 0);
  const stocks = analysis.candidates.filter(c => c.type === 'product_stock');
  assert.equal(stocks.length, 1);
  assert.equal(stocks[0].extraction_rule.kind, 'stock_items');
  assert.deepEqual(stocks[0].items.map(item => item.state), ['out_of_stock', 'in_stock']);
  assert.ok(analysis.warnings.length > 0);
});
test('页面内JSON字段与浏览器渲染后的购买按钮可提取', () => {
  const analysis = analyzePage('<script id="__NEXT_DATA__" type="application/json">{"product":{"available":true,"price":99}}</script>', { url: 'https://shop.example/product' });
  assert.ok(analysis.candidates.some(c => c.type === 'product_stock' && c.value === 'in_stock'));
  const rendered = analyzePage(html, { url: 'https://shop.example/product', method: 'browser' });
  assert.ok(rendered.candidates.some(c => c.type === 'product_stock' && c.detection_method === 'browser'));
  const renderedJson = analyzePage('<script id="__NEXT_DATA__" type="application/json">{"product":{"available":true,"price":99}}</script>', { url: 'https://shop.example/product', method: 'browser' });
  const structured = renderedJson.candidates.find(c => c.type === 'product_stock');
  assert.equal(structured.detection_method, 'browser');
  assert.equal(structured.value, 'in_stock');
  assert.equal(structured.extraction_rule.script_selector, '[id="__NEXT_DATA__"]');
});
test('规则验证使用正式执行器；无效候选最多三次，不返回可保存任务', async () => {
  let calls = 0, unreadable = false;
  const service = createRuleService({
    sourceOptions: () => ({}),
    fetchSource: async () => { calls++; return { body: unreadable ? '<h1>Product</h1><main>Loading</main>' : html, status: 200, metadata: { method: 'http' } }; },
    inspectService: async () => ({ healthy: true, summary: '可用' })
  });
  const result = await service.test({}, rule());
  assert.equal(result.passed, true);
  assert.equal(result.current_value, 'out_of_stock');
  assert.ok(Object.values(result.checks).every(Boolean));
  await assert.rejects(service.test({}, rule({ target_element: { selector: '.missing' } })), error => error.last_test_result.checks.accessible === true && error.last_test_result.checks.target_exists === false);
  unreadable = true;
  const beforeBuild = calls;
  const invalid = { url: 'https://shop.example/product', product: { name: 'Switch' }, candidates: [{ id: 'x', type: 'product_stock', detection_method: 'dom', target_element: { selector: '.missing' }, extraction_rule: { kind: 'stock' }, confidence: 0.99 }] };
  await assert.rejects(service.build({}, { type: 'product_stock' }, invalid, { fetch: { mode: 'http', proxy: 'direct' } }), error => error.attempts.length === 3 && error.code === 'RULE_VALIDATION_FAILED');
  assert.ok(calls - beforeBuild <= 3);
});
test('AI修改目标继承原阈值；仅改低于200保留URL、读取、通知', () => {
  const existing = rule({ type: 'price_change', extraction_rule: { kind: 'number' }, condition: { operator: 'lt', value: 300 } });
  const goal = inferGoal('改成低于200提醒', existing);
  assert.equal(goal.type, 'price_change');
  assert.equal(goal.condition.value, 200);
  assert.equal(goal.requested_condition, true);
  assert.equal(inferGoal('改成价格不低于400提醒', existing).condition.operator, 'gte');
  assert.notEqual(ruleSignature(existing), ruleSignature({ ...existing, condition: goal.condition }));
});
test('结构变化修复建议经过真实测试，保留原业务条件、频率和通知', async () => {
  const current = rule();
  const newHtml = '<h1>Switch</h1><span class="inventory-status">Sold Out</span>';
  const service = createRuleService({ sourceOptions: () => ({}), fetchSource: async () => ({ body: newHtml, status: 200, metadata: { method: 'http' } }), inspectService: async () => ({}) });
  const proposal = await service.repair({}, current);
  assert.equal(proposal.rule.target_element.selector, 'span.inventory-status');
  assert.deepEqual(proposal.rule.condition, current.condition);
  assert.equal(proposal.rule.interval, current.interval);
  assert.equal(proposal.rule.last_test_result.passed, true);
  assert.equal(current.target_element.selector, '#buy');
});
test('按next_run_time堆调度，任务更新不留下旧队列项且遵守并发限制', async () => {
  let clock = 1000;
  let callback;
  const executed = [];
  const scheduler = createScheduler({ now: () => clock, setTimer: fn => { callback = fn; return { unref() {} }; }, clearTimer: () => {}, concurrency: 1, run: async task => { executed.push(task); } });
  scheduler.schedule('a', 1100, 'old');
  scheduler.schedule('a', 1200, 'new');
  scheduler.schedule('b', 1100, 'b');
  assert.equal(scheduler.size, 2);
  clock = 1150; callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(executed, ['b']);
  clock = 1250; callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(executed, ['b', 'new']);
  scheduler.stop();
});

test('多个冲突DOM价格或库存不自动选择；划线旧价格不会覆盖当前售价', () => {
  const conflict = analyzePage('<span class="price">100</span><span class="price">200</span><span class="stock">In Stock</span><button>Sold Out</button>', { url: 'https://shop.example/product' });
  assert.equal(conflict.candidates.filter(c => ['price_change', 'product_stock'].includes(c.type)).length, 0);
  assert.ok(conflict.warnings.length >= 2);
  const discounted = analyzePage('<del class="old-price">300</del><span class="price">199</span>', { url: 'https://shop.example/product' });
  assert.equal(discounted.candidates.find(c => c.type === 'price_change').value, 199);
});

test('长页面全文比较保留摘要和哈希，尾部变化和尾部关键词仍可触发且不保存全文', () => {
  const monitor = rule({ type: 'webpage_change', detection_method: 'html', target_element: { selector: 'main' }, extraction_rule: { kind: 'text' }, condition: { operator: 'changed' } });
  const before = extractRule(monitor, '<main>' + 'x'.repeat(5000) + 'old</main>');
  evaluateRule(monitor, before);
  const after = extractRule(monitor, '<main>' + 'x'.repeat(5000) + 'new</main>');
  assert.equal(evaluateRule(monitor, after, before).triggered, true);
  assert.equal(after.value.length, 500);
  assert.equal(after._comparison_value, undefined);
  const keyword = { ...monitor, condition: { operator: 'contains', value: 'keyword', initial: 'notify' } };
  const current = extractRule(keyword, '<main>' + 'x'.repeat(5000) + ' keyword</main>');
  assert.equal(evaluateRule(keyword, current).matched, true);
  assert.equal(current._comparison_value, undefined);
});

test('不会把用户会话的available字段当作库存；支持真实商品availableForSale和price.amount', () => {
  const analysis = analyzePage(html.replace('￥300', '￥199'), { url: 'https://shop.example/product', apiResponses: [
    { url: 'https://shop.example/user-session', body: '{"user":{"name":"Alice","available":true}}' },
    { url: 'https://shop.example/graphql', body: '{"data":{"product":{"availableForSale":false,"price":{"amount":"199","currencyCode":"CNY"}}}}' }
  ] });
  assert.equal(analysis.candidates.find(c => c.type === 'product_stock').extraction_rule.endpoint, 'https://shop.example/graphql');
  assert.equal(analysis.candidates.find(c => c.type === 'price_change').value, 199);
  assert.ok(!analysis.candidates.some(c => c.extraction_rule.endpoint?.includes('user-session')));
  assert.equal(inferGoal('监控库存 https://shop.example/price-123').type, 'product_stock');
});

test('商品JSON的库存或价格相互冲突时不选择第一个字段作为可靠依据', () => {
  const analysis = analyzePage('{"product":{"available":true,"inventory_quantity":0,"price":300,"sale_price":199}}', { url: 'https://shop.example/product-data' });
  assert.equal(analysis.candidates.length, 0);
  assert.equal(analysis.warnings.length, 2);
});
