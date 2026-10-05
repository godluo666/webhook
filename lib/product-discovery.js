import { load } from 'cheerio';
import { stockValue, valueAt } from './monitor-rule.js';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const stockKey = /^(?:availability|in_stock|instock|stock_status|stockstatus|available|available_for_sale|availableforsale|inventory_quantity|inventoryquantity|inventory|stock|stocklevel|qty|quantity)$/i;
const excluded = /recommend|related|cart|shipping|user|account|session/i;
function formatOf(key, value) {
  return typeof value === 'boolean' || /^(?:in_stock|instock|available)$/i.test(key) && [0, 1].includes(value) ? 'boolean'
    : /quantity|inventory|stocklevel|^stock$|^qty$/i.test(key) && /^\d+$/.test(String(value)) ? 'quantity' : 'text';
}
function fieldsOf(row, path = [], result = [], depth = 0) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || depth > 3) return result;
  for (const [key, value] of Object.entries(row)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || excluded.test(key)) continue;
    if (value && typeof value === 'object') fieldsOf(value, [...path, key], result, depth + 1);
    else if (stockKey.test(key) && value != null) {
      try { const format = formatOf(key, value); result.push({ path: [...path, key], format, state: stockValue(value, format) }); } catch { /* unknown is not availability */ }
    }
  }
  return result;
}
export function discoverJsonStocks(data, { requireProductContext = true } = {}) {
  const result = [];
  let budget = 0;
  const visit = (value, path = [], depth = 0) => {
    if (++budget > 3000 || depth > 12 || !value || typeof value !== 'object' || excluded.test(path.join('.'))) return;
    if (Array.isArray(value) && value.length >= 2 && value.length <= 200) {
      const context = /product|variant|sku|offer|inventory|stock|items/i.test(path.join('.')) || value.every(row => row?.['@type'] === 'Product');
      if (context || !requireProductContext) {
        const fields = value.map(row => fieldsOf(row));
        const ids = ['sku', 'id', 'product_id', 'productId', 'product_key', '@id', 'url', 'name', 'title'].find(key => value.every(row => row && ['string', 'number'].includes(typeof row[key]) && clean(row[key])) && new Set(value.map(row => clean(row[key]))).size === value.length);
        const name = ['name', 'title', 'product_name', 'model', 'sku'].find(key => value.every(row => row && ['string', 'number'].includes(typeof row[key]) && clean(row[key]))) || ids;
        // A collection must have one consistent observed state field for every item.
        const field = fields[0]?.find(f => fields.every(rowFields => rowFields.some(other => JSON.stringify(other.path) === JSON.stringify(f.path) && other.format === f.format)) && fields.every(rowFields => new Set(rowFields.map(other => other.state)).size === 1));
        if (ids && name && field) result.push({ kind: 'stock_items', source: 'json', path, id_path: [ids], name_path: [name], state_path: field.path, stock_format: field.format, expected_ids: value.map(row => clean(row[ids])) });
      }
    }
    for (const [key, child] of Object.entries(value).slice(0, 300)) if (!['__proto__', 'constructor', 'prototype'].includes(key)) visit(child, [...path, key], depth + 1);
  };
  visit(data);
  return result.slice(0, 8);
}
export function discoverDomStocks(body) {
  const $ = load(body), result = [];
  const containers = ['[data-product-id]', '.product', '.product-card', '.product-item', '.pricing-card', '.plan-card', '[id^="product"]', '[id^="Product"]'];
  // Recognize actual repeated heading parents for shops that use their own class names.
  $('h2,h3,h4').slice(0, 100).each((_, heading) => {
    let node = $(heading).parent();
    for (let depth = 0; depth < 4 && node.length; depth++, node = node.parent()) {
      const classes = (node.attr('class') || '').split(/\s+/).filter(c => /^[a-zA-Z_][\w-]*$/.test(c));
      for (const cls of classes.slice(0, 3)) if ($('.' + cls).length >= 2) containers.push('.' + cls);
    }
  });
  for (const selector of [...new Set(containers)].slice(0, 60)) {
    const rows = $(selector).filter((_, el) => !$(el).closest('[hidden],[aria-hidden="true"],nav,footer,[class*="recommend"],[class*="related"],[class*="cart-drawer"]').length);
    if (rows.length < 2 || rows.length > 200) continue;
    const nameSelector = ['[itemprop="name"]', '.product-name', '.product-title', 'h3', 'h2', 'h4'].find(sel => rows.toArray().every(el => $(el).find(sel).length === 1 && clean($(el).find(sel).text())));
    if (!nameSelector) continue;
    const stateSelectors = ['[data-stock]', '[itemprop="availability"]', '.qty', '.stock', '.stock-status', '.inventory-status', '.product-stock', '[class*="stock"]', '[class*="inventory"]'];
    // Use only stock labels actually observed in the first card.
    rows.first().find('span,small,p,div').slice(0, 200).each((_, el) => {
      const node = $(el);
      if (node.children().length) return;
      try { stockValue(node.text()); } catch { return; }
      for (const cls of (node.attr('class') || '').split(/\s+/).filter(c => /^[a-zA-Z_][\w-]*$/.test(c))) stateSelectors.push('.' + cls);
      const parts = [];
      let current = node;
      while (current.length && current[0] !== rows.first()[0]) {
        parts.unshift(current[0].name + ':nth-of-type(' + (current.parent().children(current[0].name).index(current) + 1) + ')');
        current = current.parent();
      }
      if (current.length && parts.length) stateSelectors.push(parts.join(' > '));
    });
    // Purchase buttons are considered only when there is no explicit stock/quantity evidence.
    stateSelectors.push('button', 'input[type="submit"]', '[role="button"]', 'a[href*="pid="]');
    let chosen;
    for (const state_selector of [...new Set(stateSelectors)]) {
      for (const state_attribute of ['data-stock', 'content', 'value', null]) {
        try {
          const states = rows.toArray().map(el => {
            const node = $(el).find(state_selector);
            if (node.length !== 1 || node.closest('[hidden],[aria-hidden="true"]').length) throw new Error('ambiguous');
            return stockValue(state_attribute ? node.attr(state_attribute) : node.text(), 'text', {}, node.attr('disabled') != null || node.attr('aria-disabled') === 'true');
          });
          chosen = { state_selector, ...(state_attribute ? { state_attribute } : {}) };
          break;
        } catch { /* each row must actually contain the observed stock area */ }
      }
      if (chosen) break;
    }
    if (!chosen) continue;
    const id_attribute = ['data-product-id', 'id'].find(attr => rows.toArray().every(el => clean($(el).attr(attr))) && new Set(rows.toArray().map(el => clean($(el).attr(attr)))).size === rows.length);
    const expected_ids = rows.toArray().map(el => id_attribute ? clean($(el).attr(id_attribute)) : clean($(el).find(nameSelector).text()));
    if (new Set(expected_ids).size !== expected_ids.length) continue;
    result.push({ kind: 'stock_items', source: 'dom', item_selector: selector, name_selector: nameSelector, ...chosen, ...(id_attribute ? { id_attribute } : {}), expected_ids });
  }
  // Duplicate container selectors describing the same models add no extra evidence.
  const seen = new Set();
  return result.filter(e => { const key = JSON.stringify([...e.expected_ids].sort()); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 8);
}
