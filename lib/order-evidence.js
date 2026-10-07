// Availability belongs to changing stock state, not the selected product's identity.
export function productIdentityText(value) {
  return String(value || '').normalize('NFKC')
    .replace(/(?:\b(?:out\s+of\s+stock|in\s+stock|sold\s+out|currently\s+unavailable)\b|暂时缺货|暂时无货|暂无库存|库存不足|补货中|缺货|无货|有货|售罄|已售完)(?=[\s|·—–:：()（）\[\]【】]*$)/gi, ' ')
    .replace(/[\s|·—–:：()（）\[\]【】]+/g, ' ').trim().toLowerCase();
}

export function matchesProductSelection(expected, observed) {
  const exact = text => String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (exact(expected) === exact(observed)) return true;
  const identity = productIdentityText(expected);
  // Never accept a card/button whose only information was its stock status.
  return /[\p{L}\p{N}]/u.test(identity) && identity === productIdentityText(observed);
}
