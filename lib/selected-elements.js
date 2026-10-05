import { createHash } from 'node:crypto';
import { load } from 'cheerio';

const scalarKind = type => type === 'product_stock' ? 'stock' : type === 'price_change' ? 'number' : 'text';
export function scalarElementRule(rule, element) {
  return { ...rule, target_element: element.target, extraction_rule: { ...element, kind: scalarKind(rule.type) } };
}
export function validateSelectedElements(input, validate) {
  const elements = input.extraction_rule.elements;
  if (!['dom', 'browser'].includes(input.detection_method) || input.type === 'api_monitor') throw new Error('多区域选择仅用于网页内容、价格或库存');
  if (!Array.isArray(elements) || !elements.length || elements.length > 20) throw new Error('请选择 1 到 20 个网页区域');
  const selectors = new Set();
  return elements.map(element => {
    const selector = element?.target?.selector;
    if (typeof selector !== 'string' || !selector.trim() || selector.length > 500 || selectors.has(selector.trim())) throw new Error('所选区域标识无效或重复');
    selectors.add(selector.trim());
    const scalar = validate(scalarElementRule(input, element));
    return { target: scalar.target_element, ...Object.fromEntries(Object.entries(scalar.extraction_rule).filter(([key]) => key !== 'kind')) };
  });
}
export function extractSelectedElements(rule, body, extract, document) {
  const $ = document || load(body);
  const regions = rule.extraction_rule.elements.map((element, index) => {
    try { return { id: element.target.selector, name: element.target.label || '网页区域 ' + (index + 1), ...extract(scalarElementRule(rule, element), body, $) }; }
    catch (error) { error.message = '区域 ' + (index + 1) + '：' + error.message; throw error; }
  });
  const content_hash = createHash('sha256').update(JSON.stringify(regions.map(region => [region.id, region.content_hash]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
  const raw_value = regions.map(region => region.name + '：' + region.raw_value).join('；').slice(0, 500);
  if (rule.type === 'product_stock') {
    const items = regions.map(region => ({ id: region.id, name: region.name, state: region.value, raw_value: region.raw_value }));
    const available_count = items.filter(item => item.state === 'in_stock').length;
    return { items, value: available_count ? 'in_stock' : 'out_of_stock', available_count, total_count: items.length, content_hash, raw_value,
      summary: '所选 ' + items.length + ' 个区域，' + available_count + ' 个有货' + (available_count ? '' : '，当前全部无货') };
  }
  const value = regions.map(region => region.name + '：' + region.value).join('；').slice(0, 500);
  return { regions, value, content_hash, raw_value, summary: '所选 ' + regions.length + ' 个区域：' + value.slice(0, 180) };
}
export function evaluateSelectedElements(rule, current, previous, evaluate) {
  const results = current.regions.map(region => {
    const before = previous?.regions?.find(old => old.id === region.id);
    return { region, ...evaluate({ ...rule, extraction_rule: { kind: scalarKind(rule.type) } }, region, before || null) };
  });
  current.triggered_regions = results.filter(result => result.triggered).map(result => result.region.id);
  current.matched = results.some(result => result.matched);
  return { matched: current.matched, triggered: current.triggered_regions.length > 0 };
}
