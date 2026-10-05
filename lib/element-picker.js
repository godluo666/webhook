import { randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import { elementSelector } from './page-analysis.js';
import { ruleUrl } from './monitor-rule.js';
import { discoverDomStocks } from './product-discovery.js';

const snapshots = new Map();
const maxAge = 10 * 60_000;
export function createElementPreview(userId, url, body, method = 'http', rule = null) {
  const $ = load(body), elements = [];
  const collections = discoverDomStocks(body).map(extraction => ({ extraction, nodes: $(extraction.item_selector).find(extraction.state_selector).toArray() }));
  $('body *').each((_, node) => {
    const element = $(node);
    if (['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'math', 'object', 'embed'].includes(node.name)) return;
    if (element.closest('[hidden],[aria-hidden="true"]').length) return;
    if (node.name === 'input' && !['submit', 'button'].includes(element.attr('type'))) return;
    const text = String(element.attr('content') || element.attr('value') || element.text()).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 500 || elements.length >= 1500) return;
    const target = { selector: elementSelector($, node), text: text.slice(0, 300), label: '用户选择的网页区域' };
    const parts = [];
    let current = element;
    while (current.length && current[0].name) {
      const tag = current[0].name;
      parts.unshift(tag + '[' + (current.parent().children(tag).index(current) + 1) + ']');
      current = current.parent();
    }
    target.xpath = '/' + parts.join('/');
    const attribute = element.attr('content') != null ? 'content' : node.name === 'input' ? 'value' : null;
    const collection = collections.find(candidate => candidate.nodes.includes(node))?.extraction;
    if (collection) target.label = $(node).closest(collection.item_selector).find(collection.name_selector).text().trim().slice(0, 160) || target.label;
    elements.push({ target, attribute, ...(collection ? { collection } : {}) });
    element.attr('data-radar-element', String(elements.length - 1));
  });
  let highlighted = 0;
  const selected_indices = [];
  try {
    const e = rule?.extraction_rule;
    const watched = e?.kind === 'elements' ? $(e.elements.map(element => element.target.selector).join(',')) : e?.kind === 'stock_items' && e.source === 'dom' ? $(e.item_selector).find(e.state_selector) : rule?.target_element?.selector ? $(rule.target_element.selector) : $();
    watched.each((_, node) => { const element = $(node); element.attr('data-radar-monitored', 'true'); highlighted++; const index = element.attr('data-radar-element'); if (index != null) selected_indices.push(Number(index)); });
  } catch { /* a stale selector is shown as no highlighted region, never guessed */ }
  const language = $('html').attr('lang') || '';
  $('script,style,link,base,meta,iframe,object,embed,svg,math,noscript,template,img,video,audio,source,input:not([type="submit"]):not([type="button"])').remove();
  $('*').each((_, node) => {
    for (const name of Object.keys(node.attribs || {})) {
      if (!['id', 'class', 'title', 'type', 'value', 'hidden', 'aria-label', 'aria-hidden', 'aria-disabled', 'data-radar-element', 'data-radar-monitored'].includes(name)) $(node).removeAttr(name);
    }
  });
  const now = Date.now();
  for (const [id, entry] of snapshots) if (entry.expiresAt <= now) snapshots.delete(id);
  const own = [...snapshots].filter(([, entry]) => entry.userId === userId);
  while (own.length >= 5) snapshots.delete(own.shift()[0]);
  while (snapshots.size >= 40) snapshots.delete(snapshots.keys().next().value);
  const id = randomUUID();
  const normalized = ruleUrl(url);
  snapshots.set(id, { userId, url: normalized, method, elements, expiresAt: now + maxAge });
  const markup = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/picker.css"></head><body>' + $('body').html() + '</body></html>';
  if (Buffer.byteLength(markup) > 2_000_000) throw new Error('页面内容过大，请使用更具体的商品链接');
  return { id, title: $('h1').first().text().trim().slice(0, 160), html: markup, count: elements.length, selected_indices, collections: elements.flatMap((element, index) => element.collection ? [{ index, count: element.collection.expected_ids.length, group: element.collection.item_selector + '|' + element.collection.state_selector }] : []), method, highlighted, language, fetched_at: new Date(now).toISOString(), expiresAt: new Date(now + maxAge).toISOString() };
}
export function selectedElement(userId, id, index) {
  const entry = snapshots.get(id);
  if (!entry || entry.userId !== userId || entry.expiresAt <= Date.now()) throw Object.assign(new Error('网页预览已失效，请重新打开选择'), { status: 404 });
  if (!Number.isInteger(index) || !entry.elements[index]) throw new Error('请选择页面中的价格、库存或按钮区域');
  return { url: entry.url, method: entry.method, ...entry.elements[index] };
}

export function selectedElements(userId, id, indices) {
  if (!Array.isArray(indices) || !indices.length || indices.length > 20 || new Set(indices).size !== indices.length) throw new Error('请选择 1 到 20 个不同的网页区域');
  return indices.map(index => selectedElement(userId, id, index));
}
