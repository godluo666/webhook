import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePage, candidateRule, inferGoal } from '../lib/page-analysis.js';
import { extractRule, validateMonitorRule, evaluateRule, stockValue } from '../lib/monitor-rule.js';
import { renderNotification } from '../lib/notification.js';
import { createElementPreview } from '../lib/element-picker.js';

const names = ['Basic', 'Core', 'Pro', 'Elite', 'Ultra'];
const shop = (counts = [0, 0, 0, 0, 0], english = false, stockClass = 'qty') => '<html lang="' + (english ? 'en' : 'zh') + '"><body><h1>US - LosAngeles - TRI</h1><main id="products">' + names.map((name, i) => '<article class="product" id="product' + i + '"><h3>US.LA.TRI.' + name + '</h3><p class="price">$' + (i + 1) * 5 + ' CAD</p><a href="/cart.php?a=add&pid=' + i + '">Order Now</a><small class="' + stockClass + '">' + counts[i] + (english ? ' Available' : '可用') + '</small></article>').join('') + '</main><footer>Add To Cart In Stock</footer></body></html>';
const build = (body, condition = { operator: 'transition' }) => {
  const analysis = analyzePage(body, { url: 'https://shop.example/store/tri' });
  return validateMonitorRule(candidateRule({ type: 'product_stock', condition, all_models: true }, analysis));
};
test('五型号全部0可用与国外英文0 Available都明确为无货；不使用购买按钮覆盖数量', () => {
  const rule = build(shop());
  assert.equal(rule.extraction_rule.kind, 'stock_items');
  for (const english of [false, true]) {
    const current = extractRule(rule, shop(undefined, english));
    assert.equal(current.value, 'out_of_stock');
    assert.equal(current.available_count, 0);
    assert.equal(current.items.length, 5);
    assert.ok(current.items.every(item => item.state === 'out_of_stock'));
    assert.equal(evaluateRule(rule, current).triggered, false);
  }
  assert.equal(stockValue(' 0 Available '), 'out_of_stock');
  assert.equal(stockValue('3可用'), 'in_stock');
  assert.equal(stockValue('Stock: 0 Available'), 'out_of_stock');
  assert.throws(() => stockValue('TRI Basic 0 Available Order Now'), /不能把 Available/);
  const unstructured = analyzePage('<main>Basic 0 Available Core 0 Available</main>', { url: 'https://shop.example/store/tri' });
  assert.equal(unstructured.candidates.some(candidate => candidate.type === 'product_stock'), false);
  assert.throws(() => stockValue('Loading'), /未识别/);
});
test('其他型号仍然缺货时逐型号补货，多个有货期间再次有型号补货也通知；不重复报警', () => {
  const rule = build(shop()), before = extractRule(rule, shop());
  evaluateRule(rule, before);
  const first = extractRule(rule, shop([0, 2, 0, 0, 0], true));
  assert.equal(evaluateRule(rule, first, before).triggered, true);
  assert.deepEqual(first.triggered_items, ['product1']);
  const repeated = extractRule(rule, shop([0, 4, 0, 0, 0]));
  assert.equal(evaluateRule(rule, repeated, first).triggered, false);
  const second = extractRule(rule, shop([0, 4, 0, 1, 0]));
  assert.equal(evaluateRule(rule, second, repeated).triggered, true);
  assert.deepEqual(second.triggered_items, ['product3']);
  const message = renderNotification(rule, second, repeated).message;
  assert.match(message, /US.LA.TRI.Elite.*无货 → 有货/);
  assert.doesNotMatch(message, /US.LA.TRI.Core|US.LA.TRI.Basic/);
});
test('任一型号有货支持首次通知和每个型号自己的状态边沿；数量变化不重复提醒', () => {
  const rule = build(shop(), { operator: 'equals', value: 'in_stock', initial: 'notify' });
  const initial = extractRule(rule, shop([1, 0, 0, 0, 0]));
  assert.equal(evaluateRule(rule, initial).triggered, true);
  const next = extractRule(rule, shop([1, 0, 1, 0, 0]));
  assert.equal(evaluateRule(rule, next, initial).triggered, true);
  assert.deepEqual(next.triggered_items, ['product2']);
  assert.equal(evaluateRule(rule, extractRule(rule, shop([1, 0, 1, 0, 0])), next).triggered, false);
});
test('逐型号验证不会把未知状态、缺失型号、重复标识或错误结构当作有货', () => {
  const rule = build(shop());
  assert.throws(() => extractRule(rule, shop().replace('0可用', 'Loading')), /未识别/);
  assert.throws(() => extractRule(rule, shop().replace('id="product0"', 'id="product1"')), /重复/);
  assert.throws(() => extractRule(rule, shop().replace(/<article class="product" id="product0">.*?<\/article>/, '')), /消失/);
  assert.throws(() => extractRule(rule, shop(undefined, false, 'new-inventory')), /已变化/);
});
test('真实JSON与结构化商品列表优先于DOM，数组重新排序不会误触发', () => {
  const data = { variants: names.map((name, i) => ({ sku: 'tri-' + i, name: 'US.LA.TRI.' + name, inventory_quantity: i === 1 ? 3 : 0 })) };
  const api = 'https://shop.example/api/inventory';
  const analysis = analyzePage(shop([0,3,0,0,0]), { url: 'https://shop.example/store/tri', apiResponses: [{ url: api, body: JSON.stringify(data) }] });
  const rule = validateMonitorRule(candidateRule({ type: 'product_stock', all_models: true }, analysis));
  assert.equal(rule.detection_method, 'api');
  assert.equal(rule.extraction_rule.endpoint, api);
  const before = extractRule(rule, JSON.stringify(data));
  const after = extractRule(rule, JSON.stringify({ variants: [...data.variants].reverse() }));
  evaluateRule(rule, before);
  assert.equal(evaluateRule(rule, after, before).triggered, false);
  const ld = '<script type="application/ld+json">' + JSON.stringify(names.map(name => ({ '@type': 'Product', sku: name, name, offers: { availability: 'https://schema.org/OutOfStock' } }))) + '</script>';
  const structured = build(ld);
  assert.equal(structured.extraction_rule.source, 'json');
  assert.equal(extractRule(structured, ld).items.length, 5);
});
test('明确频率按最新用户指令编译，不误用价格或响应延迟；任意型号不是整页无缺货', () => {
  assert.equal(inferGoal('每30秒监控一次，任意型号显示有货就通知我').interval, 30);
  assert.equal(inferGoal('每5分钟检查\n改成每10秒监控一次').interval, 10);
  assert.equal(inferGoal('价格低于100通知我').interval, undefined);
  assert.equal(inferGoal('接口响应超过3秒提醒我').interval, undefined);
  const goal = inferGoal('任意套餐未缺货就通知我');
  assert.equal(goal.type, 'product_stock');
  assert.equal(goal.condition.operator, 'equals');
  assert.equal(goal.condition.initial, 'notify');
  assert.equal(goal.all_models, true);
});
test('云端页面预览标记全部实际库存区域并保留原文，不执行来源脚本', () => {
  const body = shop(undefined, true) + '<script>fetch("https://attacker.example")</script>';
  const rule = build(body), preview = createElementPreview('user', rule.url, body, 'http', rule);
  assert.equal(preview.language, 'en');
  assert.equal(preview.highlighted, 5);
  assert.match(preview.html, /0 Available/);
  assert.equal((preview.html.match(/data-radar-monitored="true"/g) || []).length, 5);
  assert.doesNotMatch(preview.html, /<script|https:\/\/attacker/);
});

test('JSON/接口与实际库存文字矛盾时拒绝自动方案，不以高评分覆盖缺货证据', () => {
  const scalar = analyzePage('<h1>Switch</h1><small class="stock">Sold Out</small>', { url: 'https://shop.example/product', apiResponses: [{ url: 'https://shop.example/api/product', body: '{"product":{"name":"Switch","available":true}}' }] });
  assert.equal(scalar.candidates.some(candidate => candidate.type === 'product_stock'), false);
  assert.ok(scalar.warnings.some(message => /互相矛盾/.test(message)));
  const variants = { variants: names.map((name,i) => ({ sku: 'tri-' + i, name: 'US.LA.TRI.' + name, available: i === 1 })) };
  const multiple = analyzePage(shop(), { url: 'https://shop.example/store/tri', apiResponses: [{ url: 'https://shop.example/api/inventory', body: JSON.stringify(variants) }] });
  assert.equal(multiple.candidates.some(candidate => candidate.type === 'product_stock'), false);
  assert.throws(() => candidateRule({ type: 'product_stock', all_models: true }, multiple), /不一致|矛盾/);
});
test('API中的其他商品列表不能替代当前页面，回退实际验证过的当前型号库存', () => {
  const analysis = analyzePage(shop(), { url: 'https://shop.example/store/tri', apiResponses: [{ url: 'https://shop.example/api/products', body: JSON.stringify({ products: names.map(name => ({ sku: 'other-' + name, name: 'Tokyo.' + name, available: true })) }) }] });
  const rule = validateMonitorRule(candidateRule({ type: 'product_stock', all_models: true }, analysis));
  assert.equal(rule.detection_method, 'dom');
  assert.equal(rule.extraction_rule.endpoint, undefined);
  assert.equal(extractRule(rule, shop()).available_count, 0);
  assert.ok(analysis.warnings.some(message => /无法与页面商品对应/.test(message)));
});
test('整页库存词作为弱证据不能自动保存，同状态的变化规则明确拒绝', () => {
  const analysis = analyzePage('<h1>Information</h1><main>Sold Out</main>', { url: 'https://shop.example/info' });
  assert.throws(() => candidateRule({ type: 'product_stock' }, analysis), /可靠/);
  assert.throws(() => validateMonitorRule({ ...build(shop()), condition: { operator: 'transition', from: ['out_of_stock'], to: ['out_of_stock'] } }), /不能相同/);
});
