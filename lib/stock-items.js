import { load } from 'cheerio';
import { createHash } from 'node:crypto';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const invalid = (message, target_exists = true) => { throw Object.assign(new Error(message), { code: 'RULE_EXTRACTION', rule_checks: { target_exists, extractable: false } }); };

export function validateStockItems(raw, { validatePath }) {
  if (!['dom', 'json'].includes(raw.source)) throw new Error('商品列表来源无效');
  const result = { source: raw.source };
  const fields = raw.source === 'dom' ? ['item_selector', 'name_selector', 'state_selector', 'id_attribute', 'id_selector', 'state_attribute'] : [];
  for (const key of fields) if (raw[key]) {
    const value = clean(raw[key]);
    if (value.length > 500 || /attribute$/.test(key) && !/^[\w:-]{1,80}$/.test(value)) throw new Error('商品列表字段无效');
    result[key] = value;
  }
  if (raw.source === 'dom' && (!result.item_selector || !result.name_selector || !result.state_selector)) throw new Error('尚未找到完整的商品名称和库存区域');
  if (raw.source === 'json') {
    for (const key of ['path', 'id_path', 'name_path', 'state_path']) result[key] = validatePath(raw[key]);
    if (!result.id_path.length || !result.state_path.length) throw new Error('商品列表缺少稳定标识或库存字段');
  }
  if (raw.expected_ids != null) {
    if (!Array.isArray(raw.expected_ids) || !raw.expected_ids.length || raw.expected_ids.length > 200 || raw.expected_ids.some(id => typeof id !== 'string' || !id || id.length > 500) || new Set(raw.expected_ids).size !== raw.expected_ids.length) throw new Error('商品列表标识无效');
    result.expected_ids = [...raw.expected_ids];
  }
  return result;
}

export function extractStockItems(rule, body, { stockValue, valueAt }) {
  const e = rule.extraction_rule;
  let items;
  if (e.source === 'json') {
    let data;
    try {
      data = e.script_selector ? JSON.parse(load(body)(e.script_selector).text()) : JSON.parse(body);
    } catch { invalid('商品列表数据无法解析', false); }
    const rows = valueAt(data, e.path);
    if (!Array.isArray(rows) || !rows.length || rows.length > 200) invalid('商品列表不存在或数据数量异常', false);
    items = rows.map(row => {
      const id = valueAt(row, e.id_path), name = valueAt(row, e.name_path.length ? e.name_path : e.id_path), raw = valueAt(row, e.state_path);
      if (!['string', 'number'].includes(typeof id) || !['string', 'number'].includes(typeof name) || raw == null) invalid('商品名称、标识或库存字段缺失', false);
      return { id: clean(id), name: clean(name).slice(0, 160), state: stockValue(raw, e.stock_format, e), raw_value: clean(raw).slice(0, 180) };
    });
  } else {
    const $ = load(body);
    const rows = $(e.item_selector).filter((_, el) => !$(el).closest('[hidden],[aria-hidden="true"],nav,footer,[class*="recommend"],[class*="related"],[class*="cart-drawer"]').length);
    if (!rows.length || rows.length > 200) invalid('商品列表区域不存在或数量异常', false);
    items = rows.toArray().map(el => {
      const row = $(el), names = row.find(e.name_selector), states = row.find(e.state_selector);
      if (names.length !== 1 || states.length !== 1 || states.closest('[hidden],[aria-hidden="true"]').length) invalid('某个型号的名称或库存区域已变化', false);
      const name = clean(names.text());
      const idNode = e.id_selector ? row.find(e.id_selector) : row;
      if (e.id_selector && idNode.length !== 1) invalid('商品稳定标识不存在或不唯一', false);
      const id = e.id_attribute ? idNode.attr(e.id_attribute) : name;
      const copy = states.clone(); copy.find('script,style,noscript,template,[hidden],[aria-hidden="true"]').remove();
      const raw = e.state_attribute ? states.attr(e.state_attribute) : copy.text();
      if (!id || !name || raw == null) invalid('某个型号的名称、标识或库存数据缺失', false);
      const disabled = states.attr('disabled') != null || states.attr('aria-disabled') === 'true';
      return { id: clean(id), name: name.slice(0, 160), state: stockValue(raw, e.stock_format, e, disabled), raw_value: clean(raw).slice(0, 180) };
    });
  }
  if (items.some(item => !item.id || !item.name) || new Set(items.map(item => item.id)).size !== items.length) invalid('商品标识为空或重复，不能可靠判断各型号补货');
  if (e.expected_ids?.some(id => !items.some(item => item.id === id))) invalid('之前监控的某个型号消失，需重新分析页面', false);
  const available = items.filter(item => item.state === 'in_stock');
  const value = available.length ? 'in_stock' : 'out_of_stock';
  const content_hash = createHash('sha256').update(JSON.stringify(items.map(({ id, state }) => [id, state]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
  return { value, items, available_count: available.length, total_count: items.length, content_hash,
    raw_value: items.map(item => item.name + '：' + item.raw_value).join('；').slice(0, 500),
    summary: '共 ' + items.length + ' 个型号，' + available.length + ' 个有货' + (available.length ? '：' + available.map(item => item.name).join('、') : '，当前全部无货') };
}

export function matchingStockItems(rule, current, previous) {
  const c = rule.condition;
  return (current.items || []).filter(item => {
    const before = previous?.items?.find(old => old.id === item.id);
    if (c.operator === 'transition') return before && c.from.includes(before.state) && c.to.includes(item.state);
    if (c.operator === 'equals') return item.state === c.value && (before ? before.state !== c.value : c.initial === 'notify' && !previous);
    if (c.operator === 'changed') return before && before.state !== item.state;
    return false;
  });
}
