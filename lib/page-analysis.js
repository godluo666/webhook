import { load } from 'cheerio';
import { stockValue, numberValue, extractRule, ruleUrl, DEFAULT_INTERVALS, validateMonitorRule, validateCondition, RULE_TYPES, displayValue } from './monitor-rule.js';

import { discoverJsonStocks, discoverDomStocks } from './product-discovery.js';
import { reconcilePageEvidence } from './evidence-consistency.js';
import { requestedInterval, DEFAULT_SLOW_THRESHOLD_MS } from './rule-policy.js';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const quote = value => '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
const stockKeys = /^(?:availability|in_stock|instock|stock_status|stockstatus|available|available_for_sale|availableforsale|inventory_quantity|inventoryquantity|inventory|stock|stocklevel)$/i;
const priceKeys = /^(?:price|sale_price|saleprice|current_price|currentprice|selling_price)$/i;

export function elementSelector($, element) {
  const node = $(element);
  const tag = element.name;
  const id = node.attr('id');
  if (id) {
    const selector = '[id=' + quote(id) + ']';
    if ($(selector).length === 1) return selector;
  }
  for (const attr of ['data-testid', 'data-product-id', 'itemprop', 'name', 'aria-label']) {
    const value = node.attr(attr);
    if (value) {
      const selector = tag + '[' + attr + '=' + quote(value) + ']';
      if ($(selector).length === 1) return selector;
    }
  }
  const classes = (node.attr('class') || '').split(/\s+/).filter(c => /^[a-zA-Z_][\w-]*$/.test(c) && !/\d{4,}/.test(c)).slice(0, 3);
  for (const cls of classes) {
    const selector = tag + '.' + cls;
    if ($(selector).length === 1) return selector;
  }
  const parts = [];
  let current = node;
  for (let depth = 0; depth < 12 && current.length && current[0].name !== 'html'; depth++) {
    const tagName = current[0].name;
    const position = current.parent().children(tagName).index(current) + 1;
    parts.unshift(tagName + ':nth-of-type(' + position + ')');
    current = current.parent();
    if (current.attr('id')) {
      parts.unshift('[id=' + quote(current.attr('id')) + ']');
      const selector = parts.join(' > ');
      if ($(selector).length === 1) return selector;
    }
  }
  return parts.join(' > ');
}
function xpathOf($, element) {
  const parts = [];
  let current = $(element);
  while (current.length && current[0].name) {
    const tag = current[0].name;
    parts.unshift(tag + '[' + (current.parent().children(tag).index(current) + 1) + ']');
    current = current.parent();
  }
  return '/' + parts.join('/');
}
function scanScalars(data, visit, path = [], depth = 0, budget = { count: 0 }) {
  if (depth > 12 || budget.count++ > 5000 || data == null || typeof data !== 'object') return;
  for (const [key, value] of Object.entries(data).slice(0, 300)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    const next = [...path, key];
    if (value != null && typeof value === 'object') scanScalars(value, visit, next, depth + 1, budget);
    else visit(key, value, next, data);
  }
}
function parseJson(body) { try { return JSON.parse(body); } catch { return null; } }

export function analyzePage(body, { url, method = 'http', apiResponses = [] } = {}) {
  const sourceUrl = ruleUrl(url);
  const $ = load(body);
  const title = clean($('h1').first().text() || $('meta[property="og:title"]').attr('content') || $('title').text()).slice(0, 160);
  const candidates = [], endpoints = [], warnings = [];
  const product = { name: title || '商品监控', sku: null, price: null, stock: null, purchase_button: null };
  const add = (type, detection_method, target_element, extraction_rule, confidence, reason, value, sourceBody = body) => {
    const candidate = { id: 'candidate-' + (candidates.length + 1), type, detection_method, target_element, extraction_rule, confidence, reason, value, display_value: displayValue(value) };
    try {
      const probe = validateMonitorRule({ type, url: sourceUrl, name: product.name, detection_method, target_element, extraction_rule });
      const actual = extractRule(probe, sourceBody);
      candidate.value = type === 'webpage_change' ? String(actual.value).slice(0, 500) : actual.value;
      candidate.display_value = actual.items ? actual.summary : displayValue(actual.value);
      if (actual.items) candidate.items = actual.items;
      candidates.push(candidate);
      if (type === 'price_change' && product.price == null) product.price = actual.value;
      if (type === 'product_stock' && product.stock == null) product.stock = actual.value;
    } catch { /* An observed field is a candidate only if the real executor can read it. */ }
  };
  const jsonFields = (data, detection_method, baseExtraction, sourceBody, structured = false, requireProductContext = detection_method === 'api') => {
    for (const collection of discoverJsonStocks(data)) {
      add('product_stock', detection_method, { label: '逐型号库存数据' }, { ...baseExtraction, ...collection }, detection_method === 'api' ? 0.96 : 0.93, '已逐一读取商品标识、名称及库存字段，各型号单独判断', null, sourceBody);
    }
    const found = [];
    scanScalars(data, (key, value, path, parent) => {
      const type = stockKeys.test(key) ? 'product_stock' : priceKeys.test(key) || /^(amount|value)$/i.test(key) && path.some(part => /price/i.test(part)) ? 'price_change' : null;
      if (!type || value == null || typeof value === 'object') return;
      if (/(?:recommend|related|cart|shipping|delivery|user|account|profile|session|aggregate|lowprice|highprice)/i.test(path.join('.'))) return;
      const productContext = /product|offer|variant|sku|inventory|stock/i.test(path.join('.')) || parent.sku != null || parent.product_id != null || parent.productId != null || parent['@type'] === 'Product';
      const productEndpoint = /product|inventory|stock|sku|offer|item|variant/i.test(baseExtraction.endpoint || '');
      if (requireProductContext && !productContext && !productEndpoint) return;
      if (baseExtraction.product_sku && parent.sku && String(parent.sku) !== String(baseExtraction.product_sku)) return;
      let format = 'text', normalized;
      try {
        if (type === 'product_stock') {
          format = typeof value === 'boolean' || /^(?:in_stock|instock|available)$/i.test(key) && [0, 1].includes(value) ? 'boolean'
            : typeof value === 'number' && /^(?:inventory_quantity|inventoryquantity|inventory|stock|stocklevel)$/i.test(key) ? 'quantity' : /availability/i.test(key) ? 'availability' : 'text';
          normalized = stockValue(value, format);
        } else normalized = numberValue(value);
      } catch { return; }
      found.push({ type, path, value: normalized, format, key });
      if (parent.sku && product.sku == null) product.sku = String(parent.sku).slice(0, 160);
      if (parent.name && !title) product.name = clean(parent.name).slice(0, 160);
    });
    for (const type of ['product_stock', 'price_change']) {
      let fields = found.filter(item => item.type === type);
      // Multiple variants require an explicit selection, even if they currently share a value.
      const variantPaths = fields.filter(item => item.path.some(p => /^\d+$/.test(p)));
      if (variantPaths.length > 1) { warnings.push('发现多个商品或 SKU 的' + (type === 'product_stock' ? '库存' : '价格') + '，请先选择需要监控的区域'); fields = fields.filter(item => !variantPaths.includes(item)); }
      if (new Set(fields.map(item => String(item.value))).size > 1) {
        warnings.push('商品数据中出现不一致的' + (type === 'product_stock' ? '库存状态' : '价格') + '，请先选择确切字段或页面区域');
        continue;
      }
      for (const item of fields.slice(0, 10)) {
        const confidence = structured ? 0.9 : detection_method === 'api' ? 0.96 : 0.93;
        const extraction = { ...baseExtraction, kind: structured ? 'structured_data' : type === 'price_change' ? 'number' : 'stock', path: item.path, ...(type === 'product_stock' ? { stock_format: item.format } : {}) };
        add(type, detection_method, { label: structured ? '商品结构化数据' : detection_method === 'api' ? '商品数据接口' : '商品 JSON 数据' }, extraction, confidence,
          '已读取真实' + (structured ? '结构化数据' : 'JSON 字段') + '并验证提取结果', item.value, sourceBody);
      }
    }
  };
  const directJson = parseJson(body);
  if (directJson) jsonFields(directJson, 'json', {}, body);
  else {
    $('script[type="application/ld+json"],script[type="application/json"],script#__NEXT_DATA__').each((_, element) => {
      const data = parseJson($(element).text());
      if (!data) return;
      const script_selector = elementSelector($, element);
      const structured = $(element).attr('type') === 'application/ld+json';
      // Structured data must describe a Product; unrelated organization/site data is ignored.
      if (structured && !JSON.stringify(data).includes('"Product"')) return;
      if (structured) jsonFields(data, method === 'browser' ? 'browser' : 'html', { script_selector }, body, true);
      if (!structured) {
        // Embedded JSON is extracted from its observed script, never from a guessed JS expression.
        const before = candidates.length;
        jsonFields(data, method === 'browser' ? 'browser' : 'html', { script_selector }, body, true, true);
        for (const candidate of candidates.slice(before)) { candidate.confidence = 0.93; candidate.reason = '已找到页面内 JSON 数据并验证真实字段'; candidate.target_element.label = '页面内 JSON 数据'; }
      }
    });
    for (const collection of discoverDomStocks(body)) {
      add('product_stock', method === 'browser' ? 'browser' : 'dom', { label: '各型号库存区域' }, collection, method === 'browser' ? 0.78 : 0.88, '已找到重复的商品区域，逐个提取型号和库存，不依赖整页缺货文字消失', null);
    }
    const selectors = [
      ['product_stock', 'button,input[type="submit"],[role="button"],[itemprop="availability"],[class*="stock"],[class*="inventory"],[data-stock],p,span,small,[role="status"]', '库存状态 / 购买按钮'],
      ['price_change', '[itemprop="price"],[data-price],[class*="price"],[id*="price"]', '当前价格']
    ];
    for (const [type, selector, label] of selectors) {
      $(selector).slice(0, 150).each((_, element) => {
        const node = $(element);
        if (node.closest('del,s,[class*="old-price"],[class*="original-price"],[class*="compare-price"],[hidden],[aria-hidden="true"],nav,footer,[class*="recommend"],[class*="related"],[class*="cart-drawer"]').length) return;
        const raw = clean(node.attr('content') || node.attr(type === 'price_change' ? 'data-price' : 'data-stock') || (element.name === 'input' ? node.attr('value') : node.text()));
        if (!raw || raw.length > 180) return;
        let normalized;
        try { normalized = type === 'price_change' ? numberValue(raw) : stockValue(raw, 'text', {}, node.attr('disabled') != null || node.attr('aria-disabled') === 'true'); }
        catch { return; }
        const target = { selector: elementSelector($, element), xpath: xpathOf($, element), text: raw, label };
        const attribute = node.attr('content') != null ? 'content' : node.attr(type === 'price_change' ? 'data-price' : 'data-stock') != null ? type === 'price_change' ? 'data-price' : 'data-stock' : element.name === 'input' ? 'value' : null;
        add(type, method === 'browser' ? 'browser' : 'dom', target,
          { kind: type === 'price_change' ? 'number' : 'stock', ...(attribute ? { attribute } : {}) }, method === 'browser' ? 0.72 : 0.82,
          '在实际页面中找到唯一的' + label + '，已用相同执行器测试', normalized);
        if (type === 'product_stock' && /button|input/.test(element.name)) product.purchase_button = raw;
      });
    }
    const visible = $('body').clone();
    visible.find('script,style,noscript,template,nav,footer,[hidden],[aria-hidden="true"]').remove();
    const pageText = clean(visible.text());
    if (!candidates.some(c => c.type === 'product_stock')) {
      try { add('product_stock', method === 'browser' ? 'browser' : 'html', { selector: 'body', label: '页面库存文字' }, { kind: 'stock' }, 0.55, '页面中只有一种明确库存状态；建议选择具体区域提高稳定性', stockValue(pageText)); } catch { /* no unambiguous stock evidence */ }
    }
    const content = $('main').length === 1 ? 'main' : 'body';
    if (clean($(content).text())) add('webpage_change', method === 'browser' ? 'browser' : 'html', { selector: content, label: content === 'main' ? '页面主要内容' : '页面可见内容' }, { kind: 'text' }, 0.7, '持续比较所选页面区域的文字，忽略脚本和样式', null);
    $('[data-stock-api],[data-product-api],link[type="application/json"],a[type="application/json"]').each((_, element) => {
      const node = $(element), value = node.attr('data-stock-api') || node.attr('data-product-api') || node.attr('href');
      try {
        const endpoint = new URL(value, sourceUrl);
        if (endpoint.origin === new URL(sourceUrl).origin && !endpoint.username && !endpoint.password && !/(?:token|secret|password|key)=/i.test(endpoint.search)) endpoints.push(endpoint.href);
      } catch { /* only explicit, same-origin read endpoints */ }
    });
  }
  for (const response of apiResponses.slice(0, 8)) {
    try {
      if (new URL(response.url).origin !== new URL(sourceUrl).origin || response.method && response.method !== 'GET') continue;
      if (/(?:token|secret|password|key)=/i.test(new URL(response.url).search)) continue;
      const data = parseJson(response.body);
      if (data) jsonFields(data, 'api', { endpoint: response.url }, response.body);
    } catch { /* private, cross-origin or malformed responses are not reused */ }
  }
  const reconciled = reconcilePageEvidence(candidates, warnings);
  for (let i = candidates.length - 1; i >= 0; i--) if (!reconciled.includes(candidates[i])) candidates.splice(i, 1);
  for (const type of ['product_stock', 'price_change']) {
    const dom = candidates.filter(c => c.type === type && ['dom', 'browser'].includes(c.detection_method) && !['structured_data', 'stock_items'].includes(c.extraction_rule.kind));
    if (new Set(dom.map(c => String(c.value))).size > 1) {
      warnings.push('页面中发现多个不一致的' + (type === 'product_stock' ? '库存状态' : '售价') + '，请点击选择具体区域');
      for (let i = candidates.length - 1; i >= 0; i--) if (dom.includes(candidates[i])) candidates.splice(i, 1);
    }
  }
  const collections = candidates.filter(c => c.type === 'product_stock' && c.extraction_rule.kind === 'stock_items');
  if (collections.length) {
    for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].type === 'product_stock' && candidates[i].extraction_rule.kind !== 'stock_items') candidates.splice(i, 1);
    product.models = collections[0].items;
    product.stock = collections[0].value;
  }
  const priority = candidate => candidate.detection_method === 'api' ? 1 : candidate.detection_method === 'json' || candidate.target_element.label === '页面内 JSON 数据' ? 2 : candidate.extraction_rule.script_selector ? 3 : candidate.detection_method === 'dom' ? 4 : candidate.detection_method === 'html' ? 5 : 6;
  candidates.sort((a, b) => priority(a) - priority(b) || b.confidence - a.confidence);
  return { url: sourceUrl, product, candidates: candidates.slice(0, 40), endpoints: [...new Set(endpoints)].slice(0, 3), warnings: [...new Set(warnings)], method };
}
export function analysisForAI(analysis) {
  if (!analysis) return null;
  return {
    url: analysis.url, product: analysis.product, warnings: analysis.warnings,
    candidates: analysis.candidates.map(({ id, type, detection_method, target_element, value, items, display_value, confidence, reason }) => ({
      id, type, detection_method, label: target_element.label, current_value: type === 'webpage_change' ? null : value, ...(items ? { items, summary: display_value } : {}), confidence, reason
    }))
  };
}
export function inferGoal(instruction, existing = null, preferredType = '') {
  const input = String(instruction || '').replace(/https?:\/\/[^\s\p{Script=Han}]+/gu, ' ');
  const type = RULE_TYPES.includes(preferredType) ? preferredType : /(?:价格|售价|price|低于|降到|便宜)/i.test(input) ? 'price_change'
    : /(?:库存|有货|缺货|补货|stock|sold out|商品)/i.test(input) ? 'product_stock'
    : /(?:接口|异常|宕机|打不开|可用性|api|服务)/i.test(input) ? 'api_monitor' : existing?.type || 'webpage_change';
  let condition = existing?.type === type ? existing.condition : null;
  const price = input.match(/(?:不高于|不大于|降到|(?<!不)低于|少于|(?<!不)小于|below|under)\s*[￥¥$]?\s*(\d+(?:\.\d+)?)/i);
  const above = input.match(/(?:不低于|不小于|(?<!不)高于|超过|(?<!不)大于|above|over)\s*[￥¥$]?\s*(\d+(?:\.\d+)?)/i);
  let requested_condition = type === 'price_change' && Boolean(price || above);
  if (requested_condition) {
    const threshold = price || above;
    condition = { operator: price ? /不高于|不大于|降到/.test(price[0]) ? 'lte' : 'lt' : /不低于|不小于/.test(above[0]) ? 'gte' : 'gt', value: Number(threshold[1]), initial: existing?.condition?.initial || 'baseline' };
  }
  if (type === 'product_stock') {
    if (/任意.{0,25}(?:有货|未缺货)|只要.{0,15}有货|当前有货|有货就通知|(?:型号|套餐).{0,10}有货.{0,10}通知/.test(input)) {
      condition = { operator: 'equals', value: 'in_stock', initial: 'notify' }; requested_condition = true;
    } else if (/补货|恢复供货|重新有货|从.{0,10}无货.{0,10}有货|(?:什么时候|何时|啥时).{0,8}有货/.test(input)) {
      condition = { operator: 'transition', from: ['out_of_stock'], to: ['in_stock'], initial: 'baseline' }; requested_condition = true;
    }
  }
  if (type === 'product_stock' && /库存(?:状态)?(?:变化|变动)|库存有变化/.test(input)) {
    condition = { operator: 'changed', initial: 'baseline' }; requested_condition = true;
  }
  if (type === 'price_change' && /价格(?:有)?(?:变化|变动)|售价(?:变化|变动)/.test(input) && !requested_condition) {
    condition = { operator: 'changed', initial: 'baseline' }; requested_condition = true;
  }
  if (type === 'webpage_change' && /(?:网页|页面|内容).{0,8}(?:变化|变动|更新)/.test(input)) {
    condition = { operator: 'changed', initial: 'baseline' }; requested_condition = true;
  }
  if (type === 'api_monitor') {
    const slow = input.match(/(?:响应|延迟|耗时).{0,8}(?:超过|大于|高于|慢于)\s*(\d+(?:\.\d+)?)\s*(毫秒|秒)/);
    if (slow) {
      condition = { operator: 'slow', value: Number(slow[1]) * (slow[2] === '秒' ? 1000 : 1), initial: 'baseline' }; requested_condition = true;
    } else if (/恢复(?:正常|可用)|重新可用/.test(input)) {
      condition = { operator: 'available', initial: 'baseline' }; requested_condition = true;
    } else if (/变慢|慢了|太慢|慢时/.test(input)) {
      condition = { operator: 'slow', value: existing?.condition?.operator === 'slow' ? existing.condition.value : DEFAULT_SLOW_THRESHOLD_MS, initial: existing?.condition?.initial || 'baseline' }; requested_condition = true;
    } else if (/异常|宕机|不可用|打不开|失败|故障/.test(input)) {
      const failures = input.match(/连续(?:失败|异常|故障)?\s*(\d+)\s*次/);
      condition = { operator: 'unavailable', failure_threshold: failures ? Number(failures[1]) : existing?.condition?.operator === 'unavailable' ? existing.condition.failure_threshold : 1, initial: existing?.condition?.initial || 'baseline' }; requested_condition = true;
    }
  }
  if (!condition) condition = validateCondition(null, type);
  const interval = requestedInterval(input);
  const condition_change = /条件|阈值|低于|高于|超过|包含|出现|消失|有货|缺货|补货|库存.{0,4}变化|价格.{0,4}变化|响应|延迟|恢复正常|连续.{0,8}失败/.test(input);
  const standard_condition = type === 'product_stock' || type === 'price_change' && !/阈值|低于|高于|超过|等于|少于|大于|小于/.test(input)
    || type === 'webpage_change' && !/包含|出现|消失|等于|文字/.test(input)
    || type === 'api_monitor' && /接口|服务|可用性|api/i.test(input) && !/字段|返回值|状态码|包含|等于|大于|小于/.test(input);
  const hints = [/价格|售价|price|低于|降到|便宜/i, /库存|有货|缺货|补货|stock|sold out/i, /接口|异常|宕机|打不开|可用性|api|服务/i, /(?:网页|页面).{0,8}变化|webpage/i].filter(pattern => pattern.test(input));
  return { type, condition, explicit: hints.length === 1, requested_condition, standard_condition, condition_change, interval, all_models: /(?:任意|任何).{0,8}(?:商品|型号|套餐)|全部|所有|逐个|各个|五个|5个|每个型号|每个套餐/.test(input) && type === 'product_stock' };
}
export function candidateRule(goal, analysis, existing = null, attempt = 0) {
  const type = goal.type;
  let candidates = analysis.candidates.filter(c => c.type === type);
  if (type === 'product_stock') candidates = candidates.filter(c => c.target_element?.selector !== 'body');
  if (goal.all_models || existing?.extraction_rule?.kind === 'stock_items') candidates = candidates.filter(c => c.extraction_rule.kind === 'stock_items');
  // Analysis has a fixed source priority. A model preference cannot reorder tested evidence.
  const candidate = candidates[attempt];
  if (!candidate && !(type === 'api_monitor' && ['unavailable', 'available', 'slow'].includes(goal.condition?.operator || 'unavailable'))) {
    const conflict = analysis.warnings?.find(message => /互相矛盾|不一致/.test(message));
    if (conflict) throw Object.assign(new Error(conflict + '。请通过服务端页面预览确认实际库存区域'), { code: 'RULE_EVIDENCE_CONFLICT' });
    throw Object.assign(new Error('没有找到能够可靠读取的' + ({ product_stock: '库存状态', price_change: '价格', api_monitor: '接口字段', webpage_change: '页面内容' })[type] + '。可以选择网页区域，或补充实际商品数据接口。'), { code: 'RULE_NO_CANDIDATE' });
  }
  const condition = validateCondition(goal.condition || (existing?.type === type ? existing.condition : null), type);
  const base = candidate ? {
    detection_method: candidate.detection_method, target_element: candidate.target_element, extraction_rule: candidate.extraction_rule
  } : { detection_method: 'api', target_element: { label: '接口可用性' }, extraction_rule: { kind: 'service' } };
  return {
    ...base, kind: 'unified', type, url: analysis.url,
    name: goal.name || existing?.name || analysis.product.name, label: goal.name || existing?.label || analysis.product.name,
    condition, interval: goal.interval ?? existing?.interval ?? DEFAULT_INTERVALS[type],
    notification: existing?.notification || { title: type === 'product_stock' ? '库存变化提醒 · {{name}}' : type === 'price_change' ? '价格提醒 · {{name}}' : '{{name}}', body: '{{details}}\n时间：{{time}}\n链接：{{source}}' },
    fetch: existing?.fetch || { mode: base.detection_method === 'browser' ? 'browser' : 'auto', proxy: 'default' },
    evidence_confidence: candidate?.confidence || 0.9,
    explanation: candidate?.reason || '使用实际接口响应判断可用性；正常定时检查由程序执行',
    product: analysis.product
  };
}
