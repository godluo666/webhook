import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { validateStockItems, extractStockItems, matchingStockItems } from './stock-items.js';
import { validateSelectedElements, extractSelectedElements, evaluateSelectedElements } from './selected-elements.js';

export const RULE_TYPES = ['webpage_change', 'product_stock', 'price_change', 'api_monitor'];
export const DETECTION_METHODS = ['html', 'dom', 'api', 'json', 'browser'];
import { DEFAULT_INTERVALS, validateInterval, defaultCondition } from './rule-policy.js';
export { DEFAULT_INTERVALS } from './rule-policy.js';
const operators = ['changed', 'equals', 'notEquals', 'contains', 'absent', 'lt', 'lte', 'gt', 'gte', 'transition', 'unavailable', 'available', 'slow'];
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const fail = (message, target_exists = true) => { throw Object.assign(new Error(message), { code: 'RULE_EXTRACTION', rule_checks: { target_exists, extractable: false } }); };
const limited = (value, limit = 500) => text(value).slice(0, limit);

export function ruleUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('请填写完整的网页或接口地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2000) throw new Error('监控地址需要使用不含账号密码的 HTTP 或 HTTPS 地址');
  return url.href;
}
export function validatePath(value) {
  if (value == null || value === '') return [];
  const parts = Array.isArray(value) ? value : String(value).replace(/^\$\.?/, '').split('.');
  if (parts.length > 30 || parts.some(part => !['string', 'number'].includes(typeof part) || !/^[\w@-]+$/.test(String(part)) || unsafeKeys.has(String(part)))) throw new Error('数据路径无效');
  return parts.map(String);
}
export function valueAt(value, path) {
  return validatePath(path).reduce((current, key) => current != null && Object.hasOwn(Object(current), key) ? current[key] : undefined, value);
}
function values(input, name) {
  if (!Array.isArray(input) || !input.length || input.length > 20 || input.some(v => !['string', 'number', 'boolean'].includes(typeof v))) throw new Error(name + '无效');
  return input.map(String);
}
export function validateCondition(candidate, type) {
  const input = candidate || defaultCondition(type);
  const operator = input.operator;
  if (!operators.includes(operator)) throw new Error('不支持的提醒条件');
  const allowed = { product_stock: ['transition', 'equals', 'changed'], price_change: ['changed', 'lt', 'lte', 'gt', 'gte'], webpage_change: ['changed', 'contains', 'absent', 'equals', 'notEquals', 'transition'], api_monitor: ['unavailable', 'available', 'slow', 'equals', 'notEquals', 'contains', 'changed', 'lt', 'lte', 'gt', 'gte'] };
  if (!allowed[type].includes(operator)) throw new Error('提醒条件与监控目标不匹配');
  const result = { operator, initial: operator === 'changed' || operator === 'transition' ? 'baseline' : input.initial === 'notify' ? 'notify' : 'baseline' };
  if (['lt', 'lte', 'gt', 'gte', 'slow'].includes(operator)) {
    if (input.value == null || input.value === '' || !Number.isFinite(Number(input.value))) throw new Error('请填写有效的提醒数值');
    result.value = Number(input.value);
    if (type === 'price_change' && result.value < 0 || operator === 'slow' && result.value < 100) throw new Error('提醒数值超出有效范围');
  } else if (['equals', 'notEquals', 'contains', 'absent'].includes(operator)) {
    if (!['string', 'number', 'boolean'].includes(typeof input.value) || String(input.value).length > 300 || String(input.value) === '') throw new Error('请填写希望关注的内容');
    result.value = input.value;
    if (type === 'product_stock' && !['in_stock', 'out_of_stock'].includes(String(input.value))) throw new Error('库存条件需要选择有货或无货');
  } else if (operator === 'transition') {
    result.from = values(input.from || (type === 'product_stock' ? ['out_of_stock'] : []), '之前的状态');
    result.to = values(input.to || (type === 'product_stock' ? ['in_stock'] : []), '目标状态');
    if (result.from.some(value => result.to.includes(value))) throw new Error('变化前后的状态不能相同，否则会重复触发');
    if (type === 'product_stock' && [...result.from, ...result.to].some(v => !['in_stock', 'out_of_stock'].includes(v))) throw new Error('库存变化需要使用有货或无货状态');
  }
  if (operator === 'unavailable') {
    result.failure_threshold = Number(input.failure_threshold ?? 1);
    if (!Number.isInteger(result.failure_threshold) || result.failure_threshold < 1 || result.failure_threshold > 10) throw new Error('连续失败次数需要在 1 到 10 次之间');
  }
  return result;
}
export function validateMonitorRule(input) {
  if (!input || !RULE_TYPES.includes(input.type)) throw new Error('无法识别监控目标');
  if (!DETECTION_METHODS.includes(input.detection_method)) throw new Error('无法识别检测方式');
  const raw = input.extraction_rule || {};
  if (!['text', 'number', 'stock', 'stock_items', 'elements', 'json', 'structured_data', 'service'].includes(raw.kind)) throw new Error('数据提取方式无效');
  if (raw.kind === 'stock_items' && input.type !== 'product_stock') throw new Error('逐型号库存提取仅用于商品库存目标');
  const extraction_rule = { kind: raw.kind };
  if (raw.kind === 'elements') extraction_rule.elements = validateSelectedElements(input, validateMonitorRule);
  if (raw.kind === 'stock_items') Object.assign(extraction_rule, validateStockItems(raw, { validatePath }));
  if (raw.path != null) extraction_rule.path = validatePath(raw.path);
  if (raw.endpoint) extraction_rule.endpoint = ruleUrl(raw.endpoint);
  if (raw.script_selector) extraction_rule.script_selector = limited(raw.script_selector, 500);
  if (raw.attribute) {
    if (!/^[\w:-]{1,80}$/.test(raw.attribute)) throw new Error('元素属性无效');
    extraction_rule.attribute = raw.attribute;
  }
  if (raw.stock_format != null) {
    if (!['text', 'boolean', 'quantity', 'availability'].includes(raw.stock_format)) throw new Error('库存数据格式无效');
    extraction_rule.stock_format = raw.stock_format;
  }
  for (const key of ['available_values', 'unavailable_values']) if (raw[key]) extraction_rule[key] = values(raw[key], '库存状态文字');
  if (raw.product_sku) extraction_rule.product_sku = limited(raw.product_sku, 160);
  const target = input.target_element || {};
  const target_element = Object.fromEntries(['selector', 'xpath', 'text', 'label'].map(key => [key, limited(target[key], key === 'text' ? 300 : 500)]));
  const service = raw.kind === 'service';
  if (service && (input.type !== 'api_monitor' || input.detection_method !== 'api')) throw new Error('服务状态检测需要接口状态目标');
  if (!service && !['structured_data', 'stock_items', 'elements'].includes(raw.kind) && ['dom', 'browser'].includes(input.detection_method) && !target_element.selector) throw new Error('尚未找到要关注的页面区域，请选择网页元素');
  if (raw.kind === 'structured_data' && !extraction_rule.script_selector) throw new Error('未找到结构化商品数据');
  if (input.type === 'product_stock' && !['stock', 'stock_items', 'elements', 'structured_data'].includes(raw.kind)) throw new Error('库存任务需要可识别的库存数据');
  if (input.type === 'price_change' && !['number', 'structured_data', 'elements'].includes(raw.kind)) throw new Error('价格任务需要可识别的价格数据');
  if (['api', 'json'].includes(input.detection_method) && !service && !Object.hasOwn(extraction_rule, 'path')) throw new Error('尚未找到可读取的数据字段');
  const condition = validateCondition(input.condition, input.type);
  if (service !== ['unavailable', 'available', 'slow'].includes(condition.operator)) throw new Error('接口状态与数据字段条件不匹配');
  const interval = validateInterval(input.intervalMinutes !== undefined ? input.intervalMinutes * 60 : input.interval ?? DEFAULT_INTERVALS[input.type]);
  const name = limited(input.label ?? input.name ?? '新监控', 60);
  if (!name) throw new Error('请填写任务名称');
  return {
    schema_version: 1, kind: 'unified', id: input.id || null, name, label: name,
    type: input.type, url: ruleUrl(input.url), detection_method: input.detection_method,
    target_element, extraction_rule, condition, trigger_action: 'notify',
    interval, intervalMinutes: interval / 60, notification: input.notification,
    status: input.enabled === false ? 'paused' : input.status === 'needs_repair' ? 'needs_repair' : 'draft',
    confidence: 0, last_test_result: null,
    fetch: input.fetch, severity: input.severity || 'warning',
    description: describeRule({ type: input.type, condition })
  };
}
export function stockValue(value, format = 'text', extraction = {}, disabled = false) {
  if (format === 'boolean') {
    if (value === true || value === 1 || /^(true|1)$/i.test(String(value))) return 'in_stock';
    if (value === false || value === 0 || /^(false|0)$/i.test(String(value))) return 'out_of_stock';
    fail('库存字段不是明确的是 / 否');
  }
  if (format === 'quantity') {
    if (value == null || value === '' || !Number.isFinite(Number(value))) fail('库存数量不是有效数字');
    return Number(value) > 0 ? 'in_stock' : 'out_of_stock';
  }
  const state = text(value).toLowerCase();
  const quantity = state.match(/^(?:(?:库存|剩余|数量|stock|quantity)\s*[:：]?\s*)?(\d+)\s*(?:可用|件可用|件库存|available|disponible)\s*$/i);
  if (quantity) return Number(quantity[1]) > 0 && !disabled ? 'in_stock' : 'out_of_stock';
  if (/\d+\s*(?:可用|available\b|disponible\b)/i.test(state)) fail('库存区域包含数量和其他内容，请选择每个型号的具体库存文字；不能把 Available 当成有货');
  if (!state) fail('库存状态为空');
  const matches = list => (list || []).some(item => state === text(item).toLowerCase());
  if (matches(extraction.unavailable_values)) return 'out_of_stock';
  if (matches(extraction.available_values)) return disabled ? 'out_of_stock' : 'in_stock';
  const out = /out[\s_-]*of[\s_-]*stock|sold[\s_-]*out|unavailable|not available|缺货|无货|售罄|售完|暂时无货|暂无库存|到货通知/.test(state);
  const availableText = state.replace(/out[\s_-]*of[\s_-]*stock|sold[\s_-]*out|not available|unavailable|无货|缺货|暂无库存/g, '');
  const available = /(?:^|[^a-z])in[\s_-]*stock|instock|(?:^|[^a-z])available(?:$|[^a-z])|add\s+to\s+(?:cart|bag)|buy\s+now|有货|现货|加入购物车|立即购买/.test(availableText);
  if (out && available) fail('页面同时包含有货和无货，无法确定当前商品状态；请选择具体区域');
  if (out || /outofstock|soldout/.test(state)) return 'out_of_stock';
  if (available) return disabled ? 'out_of_stock' : 'in_stock';
  fail('未识别到明确的库存状态，不能把未知状态当成无货');
}
export function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null || text(value) === '') fail('没有提取到价格或数值');
  const raw = text(value).replace(/[￥¥$€£]|USD|CNY|RMB|元|円|含税|税込/gi, '').trim();
  let normalized = raw;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw)) normalized = raw.replaceAll(',', '');
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(raw)) normalized = raw.replaceAll('.', '').replace(',', '.');
  else if (/^-?\d+,\d{1,2}$/.test(raw)) normalized = raw.replace(',', '.');
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized) || !Number.isFinite(Number(normalized))) fail('目标区域不是单一价格或数值，请选择当前售价');
  return Number(normalized);
}
export function extractRule(rule, body, document = null) {
  const extraction = rule.extraction_rule, target = rule.target_element;
  if (extraction.kind === 'elements') return extractSelectedElements(rule, body, extractRule, document);
  if (extraction.kind === 'stock_items') return extractStockItems(rule, body, { stockValue, valueAt });
  let raw, disabled = false;
  if (['api', 'json'].includes(rule.detection_method)) {
    let data;
    try { data = JSON.parse(body); } catch { fail('接口没有返回有效 JSON', false); }
    raw = valueAt(data, extraction.path);
  } else {
    const $ = document || load(body);
    if (extraction.kind === 'structured_data') {
      const scripts = $(extraction.script_selector);
      if (scripts.length !== 1) fail('商品结构化数据已变化或匹配多个数据块', false);
      let data;
      try { data = JSON.parse(scripts.text()); } catch { fail('商品结构化数据无法解析'); }
      raw = valueAt(data, extraction.path);
    } else {
      const elements = $(target.selector || 'body');
      if (elements.length !== 1) fail(elements.length ? '目标区域匹配多个元素，请缩小选择范围' : '目标区域不存在，页面结构可能已变化', false);
      const element = elements.first().clone();
      element.find('script,style,noscript,template,[hidden],[aria-hidden="true"]').remove();
      if (elements.closest('[hidden],[aria-hidden="true"]').length) fail('目标区域当前不可见');
      raw = extraction.attribute ? elements.attr(extraction.attribute) : element.text();
      if (elements[0]?.name === 'input' && !extraction.attribute) raw = elements.attr('value');
      disabled = elements.attr('disabled') != null || elements.attr('aria-disabled') === 'true';
    }
  }
  if (raw === undefined || raw === null) fail('目标数据字段不存在或为空，页面结构可能已变化', false);
  if (typeof raw === 'object') fail('目标数据不是可判断的单值');
  const value = rule.type === 'product_stock' ? stockValue(raw, extraction.stock_format, extraction, disabled)
    : rule.type === 'price_change' || extraction.kind === 'number' ? numberValue(raw) : text(raw);
  if (value === '') fail('未提取到目标内容');
  return { value: typeof value === 'string' ? value.slice(0, 500) : value, content_hash: createHash('sha256').update(String(value)).digest('hex'), ...(typeof value === 'string' && value.length > 500 ? { _comparison_value: value } : {}), raw_value: limited(raw, 500), summary: rule.type === 'product_stock' ? '当前库存：' + displayValue(value) : rule.type === 'price_change' ? '当前价格：' + value : '当前内容：' + limited(value, 180) };
}
export function evaluateRule(rule, current, previous = null) {
  const c = rule.condition, value = current._comparison_value ?? current.value;
  if (rule.extraction_rule.kind === 'elements' && rule.type !== 'product_stock') return evaluateSelectedElements(rule, current, previous, evaluateRule);
  if (rule.extraction_rule.kind === 'stock_items' || rule.extraction_rule.kind === 'elements' && rule.type === 'product_stock') {
    const items = matchingStockItems(rule, current, previous);
    current.triggered_items = items.map(item => item.id);
    current.matched = c.operator === 'equals' ? current.items.some(item => item.state === c.value) : items.length > 0;
    return { matched: current.matched, triggered: items.length > 0 };
  }
  let matched = false;
  if (c.operator === 'unavailable') {
    current.consecutiveFailures = current.healthy === false ? (previous?.consecutiveFailures || 0) + 1 : 0;
    matched = current.consecutiveFailures >= c.failure_threshold;
  } else if (c.operator === 'available') matched = current.healthy === true;
  else if (c.operator === 'slow') matched = current.healthy === true && current.latencyMs > c.value;
  else if (['lt', 'lte', 'gt', 'gte'].includes(c.operator)) {
    const actual = numberValue(value);
    matched = ({ lt: actual < c.value, lte: actual <= c.value, gt: actual > c.value, gte: actual >= c.value })[c.operator];
  } else if (c.operator === 'equals') matched = String(value) === String(c.value);
  else if (c.operator === 'notEquals') matched = String(value) !== String(c.value);
  else if (c.operator === 'contains' || c.operator === 'absent') {
    const found = String(value).toLowerCase().includes(String(c.value).toLowerCase());
    matched = c.operator === 'contains' ? found : !found;
  } else if (c.operator === 'transition') matched = Boolean(previous) && c.from.includes(String(previous.value)) && c.to.includes(String(value));
  else if (c.operator === 'changed') matched = Boolean(previous) && (current.content_hash && previous.content_hash ? current.content_hash !== previous.content_hash : String(previous.value) !== String(value));
  const edge = ['changed', 'transition'].includes(c.operator);
  const triggered = edge ? matched : previous ? matched && previous.matched !== true : c.initial === 'notify' && matched;
  current.matched = matched;
  delete current._comparison_value;
  return { matched, triggered };
}
export function displayValue(value) { return ({ in_stock: '有货', out_of_stock: '无货' })[value] || String(value ?? '尚未检测'); }
export function describeRule(rule) {
  const c = rule.condition || {};
  if (rule.extraction_rule?.kind === 'elements') return '所选区域分别判断，任一区域满足条件时提醒：' + describeRule({ ...rule, extraction_rule: {} });
  if (rule.extraction_rule?.kind === 'stock_items') return c.operator === 'transition' ? '任一型号从「' + (c.from || ['out_of_stock']).map(displayValue).join('、') + '」变为「' + (c.to || ['in_stock']).map(displayValue).join('、') + '」时提醒' : c.operator === 'equals' ? '任一型号' + displayValue(c.value) + '时提醒（每个型号单独判断）' : '任一型号库存状态变化时提醒';
  if (c.operator === 'transition') return '当状态从「' + (c.from || ['out_of_stock']).map(displayValue).join('、') + '」变为「' + (c.to || ['in_stock']).map(displayValue).join('、') + '」时提醒';
  if (c.operator === 'changed') return ({ product_stock: '库存状态', price_change: '价格', webpage_change: '关注的页面内容', api_monitor: '接口数据' })[rule.type] + '变化时提醒';
  if (c.operator === 'unavailable') return '接口连续 ' + (c.failure_threshold || 1) + ' 次异常时提醒';
  if (c.operator === 'available') return '接口恢复正常时提醒';
  if (c.operator === 'slow') return '接口响应超过 ' + c.value / 1000 + ' 秒时提醒';
  const words = { equals: '等于', notEquals: '不等于', contains: '包含', absent: '不再包含', lt: '低于', lte: '不高于', gt: '超过', gte: '达到' };
  return (rule.type === 'price_change' ? '价格' : rule.type === 'product_stock' ? '库存状态' : '关注内容') + (words[c.operator] || '') + '「' + displayValue(c.value) + '」时提醒';
}
export function ruleSignature(rule) {
  return createHash('sha256').update(JSON.stringify([rule.type, rule.url, rule.detection_method, rule.target_element?.selector || '', rule.extraction_rule, rule.condition, rule.fetch])).digest('hex');
}
export function legacyRuleView(monitor) {
  if (monitor.kind === 'reminder') return null;
  if (monitor.kind === 'unified') return monitor;
  const plan = monitor.plan || {};
  const type = ['dmit', 'dmit-product'].includes(monitor.kind) || plan.mode === 'item-transition' ? 'product_stock' : plan.sourceType === 'service' ? 'api_monitor' : 'webpage_change';
  return {
    schema_version: 1, id: monitor.id, name: monitor.label, type, url: monitor.url,
    detection_method: plan.sourceType === 'json' || ['json', 'dmit', 'github'].includes(monitor.kind) ? 'json' : plan.sourceType === 'service' ? 'api' : monitor.fetch?.mode === 'browser' ? 'browser' : 'html',
    target_element: { label: monitor.description || '' }, extraction_rule: { kind: 'legacy', path: plan.path || monitor.jsonPath || '' },
    condition: { operator: plan.mode || monitor.mode || monitor.triggerMode || 'changed' }, trigger_action: 'notify',
    interval: monitor.intervalMinutes * 60, notification: monitor.notification,
    status: monitor.enabled === false ? 'paused' : monitor.lastError ? 'needs_repair' : monitor.baselined ? 'active' : 'draft',
    confidence: monitor.last_test_result?.passed ? 0.8 : 0, last_test_result: monitor.last_test_result || null, legacy: true
  };
}
