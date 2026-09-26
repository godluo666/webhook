export const DMIT_PRICING_URL = 'https://www.dmit.io/pages/pricing';
export const DMIT_STOCK_URL = 'https://vps.thairath.eu.org/api/products';

const decodeEntities = (value) => value
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;|&#34;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'");

export function visibleText(html) {
  return decodeEntities(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' '));
}

export function inspectPage(monitor, html) {
  if (monitor.kind === 'dmit') {
    let data;
    try { data = JSON.parse(html); } catch { throw new Error('库存数据不是有效 JSON'); }
    if (!data.ok || !Array.isArray(data.products)) throw new Error('库存数据格式发生变化');
    const items = {};
    for (const product of data.products) {
      if (String(product.provider).toLowerCase() !== 'dmit' || product.stale) continue;
      const checkedAt = Date.parse(product.last_check_at);
      if (!product.product_key || !Number.isFinite(checkedAt) || Date.now() - checkedAt > 2 * 60 * 60 * 1000) continue;
      const status = /^(有货|in stock|available)$/i.test(product.status) ? 'available' : /^(无货|缺货|out of stock)$/i.test(product.status) ? 'out' : null;
      if (status) items[product.product_key] = { name: String(product.name || product.product_key), status, orderUrl: product.order_url || '' };
    }
    if (!Object.keys(items).length) throw new Error('当前没有及时更新的 DMIT 库存数据');
    const out = Object.values(items).filter((item) => item.status === 'out').length;
    const available = Object.values(items).filter((item) => item.status === 'available').length;
    return { items, out, available, summary: `${out} 款缺货 · ${available} 款有货` };
  }
  const content = visibleText(html);
  if (monitor.kind === 'dmit-product') {
    const out = /\bout\s+of\s+stock\b/i.test(content);
    const available = /\border\s+now\b|\bcheckout\b|\bconfigure\b/i.test(content);
    if (!out && !available) throw new Error('未在购买页找到明确的库存状态');
    return { matched: available && !out, summary: out ? '缺货' : '可购买' };
  }
  if (monitor.kind === 'json') {
    let data;
    try { data = JSON.parse(html); } catch { throw new Error('接口没有返回有效 JSON'); }
    const value = monitor.jsonPath.split('.').reduce((part, key) => part?.[key], data);
    if (value === undefined) throw new Error(`JSON 字段 ${monitor.jsonPath} 不存在`);
    const actual = String(value);
    const expected = String(monitor.expected || '');
    const numeric = ['gt', 'gte', 'lt', 'lte'].includes(monitor.operator);
    if (numeric && (!Number.isFinite(Number(value)) || !Number.isFinite(Number(expected)))) throw new Error('比较值不是数字');
    const matched = ({ equals: actual === expected, notEquals: actual !== expected, contains: actual.includes(expected), gt: Number(value) > Number(expected), gte: Number(value) >= Number(expected), lt: Number(value) < Number(expected), lte: Number(value) <= Number(expected) })[monitor.operator] ?? false;
    return { matched, value: actual.slice(0, 300), summary: `${monitor.jsonPath} = ${actual.slice(0, 80)}` };
  }
  if (monitor.kind === 'rss') {
    const entries = [...html.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)].slice(0, 30).map((match) => {
      const title = match[1].match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
      const link = match[1].match(/<link\b[^>]*href=["']([^"']+)/i)?.[1] || match[1].match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1] || '';
      return { title: visibleText(title), link: link.trim() };
    });
    if (!entries.length) throw new Error('订阅源没有可识别的条目');
    return { entries, summary: `最新：${entries[0].title.slice(0, 80)}` };
  }
  if (monitor.kind === 'github') {
    let release;
    try { release = JSON.parse(html); } catch { throw new Error('GitHub API 返回内容无效'); }
    if (!release.tag_name || !release.html_url) throw new Error('没有找到公开的 GitHub Release');
    return { releaseId: String(release.id || release.tag_name), tag: String(release.tag_name), link: String(release.html_url), summary: `最新版本 ${release.tag_name}` };
  }
  const matched = content.toLocaleLowerCase().includes(monitor.keyword.toLocaleLowerCase());
  const triggered = monitor.mode === 'absent' ? !matched : matched;
  return { matched: triggered, summary: `${monitor.mode === 'absent' ? '未出现' : '已出现'}「${monitor.keyword}」：${triggered ? '是' : '否'}` };
}

export function isTransition(monitor, previous, current) {
  if (monitor.kind === 'dmit' && monitor.triggerMode === 'any-available') return previous ? previous.available === 0 && current.available > 0 : current.available > 0;
  if (!previous) return false;
  if (monitor.kind === 'dmit') return restockedItems(previous, current).length > 0;
  if (monitor.kind === 'rss') return current.entries.some((entry) => !previous.entries?.some((old) => old.link ? old.link === entry.link : old.title === entry.title) && (!monitor.keyword || entry.title.toLocaleLowerCase().includes(monitor.keyword.toLocaleLowerCase())));
  if (monitor.kind === 'github') return previous.releaseId !== current.releaseId;
  return !previous.matched && current.matched;
}

export function restockedItems(previous, current) {
  if (!previous?.items || !current?.items) return [];
  return Object.entries(current.items).filter(([key, item]) => previous.items[key]?.status === 'out' && item.status === 'available').map(([, item]) => item);
}
