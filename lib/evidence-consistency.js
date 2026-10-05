const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function explicitStock(candidate) {
  if (candidate.target_element?.selector === 'body') return false;
  if (candidate.extraction_rule.kind === 'stock_items' || !['dom', 'browser', 'html'].includes(candidate.detection_method) || candidate.extraction_rule.script_selector) return true;
  return /\d+\s*(?:可用|available)|in[\s_-]*stock|out[\s_-]*of[\s_-]*stock|sold[\s_-]*out|缺货|无货|售罄|有货|现货/i.test(candidate.target_element?.text || '');
}
function correspondingItems(data, dom) {
  if (data.length !== dom.length) return null;
  const pairs = dom.map(item => {
    const byId = data.filter(other => clean(other.id) === clean(item.id));
    const byName = data.filter(other => clean(other.name) === clean(item.name));
    const matches = byId.length ? byId : byName;
    return matches.length === 1 ? [item, matches[0]] : null;
  });
  return pairs.every(Boolean) && new Set(pairs.map(pair => pair[1].id)).size === dom.length ? pairs : null;
}

// An API's presence alone does not prove that its products belong to this page.
export function reconcilePageEvidence(candidates, warnings) {
  const rejected = new Set();
  const stockCollections = candidates.filter(c => c.type === 'product_stock' && c.extraction_rule.kind === 'stock_items');
  const visible = stockCollections.filter(c => c.extraction_rule.source === 'dom');
  for (const data of stockCollections.filter(c => c.extraction_rule.source === 'json')) {
    if (!visible.length) continue;
    const matches = visible.map(dom => ({ dom, pairs: correspondingItems(data.items, dom.items) })).filter(match => match.pairs);
    if (!matches.length) {
      rejected.add(data);
      warnings.push('数据接口/JSON 的型号列表无法与页面商品对应，自动方案采用已验证的页面库存区域');
      continue;
    }
    if (matches.some(match => match.pairs.some(([a,b]) => a.state !== b.state))) {
      for (const candidate of candidates.filter(candidate => candidate.type === 'product_stock')) rejected.add(candidate);
      warnings.push('接口/JSON 与页面显示的同一型号库存不一致，需预览并选择实际要监控的依据；不会自动启用');
    }
  }
  for (const type of ['product_stock', 'price_change']) {
    const scalar = candidates.filter(c => c.type === type && c.extraction_rule.kind !== 'stock_items' && (type !== 'product_stock' || explicitStock(c)));
    if (type === 'product_stock' && stockCollections.length) continue;
    if (new Set(scalar.map(c => String(c.value))).size > 1) {
      for (const candidate of candidates.filter(c => c.type === type)) rejected.add(candidate);
      warnings.push((type === 'product_stock' ? '库存' : '价格') + '检测依据互相矛盾，需预览并选择实际区域；不会把较高评分当作正确性的证明');
    }
  }
  return candidates.filter(candidate => !rejected.has(candidate));
}
