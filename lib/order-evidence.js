// Availability belongs to changing stock state, not the selected product's identity.
const currencies = new Set(Intl.supportedValuesOf('currency'));
export function productIdentityText(value) {
  return String(value || '').normalize('NFKC')
    .replace(/(?<![\p{L}\p{N}.,])\d+\s+available\b/giu, (match, offset, source) => {
      const prefix = source.slice(0, offset).match(/(?:\b([a-z]{3})|([$€£¥]))\s*$/i);
      // A price must never become an ignored stock count.
      return prefix && (prefix[2] || currencies.has(prefix[1].toUpperCase())) ? match : ' ';
    })
    .replace(/(?:\b(?:out\s+of\s+stock|in\s+stock|sold\s+out|currently\s+unavailable)\b|暂时缺货|暂时无货|暂无库存|库存不足|补货中|缺货|无货|有货|售罄|已售完)(?=[\s|·—–:：()（）\[\]【】]*$|[\s|·—–:：()（）\[\]【】]+(?:order\s+now|buy\s+now|add\s+to\s+cart|立即购买|加入购物车)(?:\b|$))/gi, ' ')
    .replace(/[\s|·—–:：()（）\[\]【】]+/g, ' ').trim().toLowerCase();
}

export function parseOrderQuantity(value) {
  const text=String(value??'').normalize('NFKC').trim();
  const match=text.match(/^(?:(?:quantity|qty|数量|數量)\s*[:：]?\s*|[x×]\s*)?(\d+)(?:\s*(?:件|个|個|units?|items?))?$/i);
  return match&&Number.isSafeInteger(Number(match[1]))?Number(match[1]):null;
}
export function explicitOrderCurrency(value) {
  const codes=[...new Set((String(value??'').toUpperCase().match(/\b[A-Z]{3}\b/g)||[]).filter(code=>currencies.has(code)))];
  return codes.length===1?codes[0]:null;
}
export function canonicalOrderReview(review) {
  const text=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
  return {product:productIdentityText(review?.product),quantity:review?.quantity,total:review?.total,currency:review?.currency,
    configuration:(review?.configuration||[]).map(({name,value})=>({name:text(name),value:text(value)})).sort((a,b)=>a.name.localeCompare(b.name)||a.value.localeCompare(b.value)),
    coupon:review?.coupon?{code:review.coupon.code,discount:review.coupon.discount}:null,
    couponFailure:review?.couponFailure?{code:review.couponFailure.code,status:review.couponFailure.status}:null};
}
export function sameOrderReview(a,b){return JSON.stringify(canonicalOrderReview(a))===JSON.stringify(canonicalOrderReview(b));}
export function matchesProductSelection(expected, observed) {
  const exact = text => String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (exact(expected) === exact(observed)) return true;
  const identity = productIdentityText(expected);
  // Never accept a card/button whose only information was its stock status.
  const substance = identity.replace(/\b(?:order now|buy now|add to cart)\b|立即购买|加入购物车/gi, ' ');
  return /[\p{L}\p{N}]/u.test(substance) && identity === productIdentityText(observed);
}
