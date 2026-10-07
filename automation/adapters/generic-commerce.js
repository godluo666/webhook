export function pageType(page){
  const text=(page.title||'')+' '+(page.text||'');
  if(/payment\s+(successful|complete)|支付成功|已付款/i.test(text))return 'payment_result';
  if(/order\s*(?:number\b|id\b|#)|订单号|訂單編號/i.test(text))return 'order_result';
  if(/invoice|账单|發票/i.test(text))return 'invoice';
  if(/checkout|place order|submit order|结账|提交订单/i.test(text))return 'checkout';
  if(/shopping cart|购物车|購物車/i.test(text))return 'cart';
  if(/catalog|category|商品列表|产品列表|分類|分类/i.test(page.title||''))return 'catalog';
  return 'product_or_other';
}
export function confirmationEvidence(page,kind){
  const negative=/unpaid|not\s+paid|unsuccessful|pending|failed|declined|未支付|未付款|失败|失敗/i;
  const success=kind==='payment'?/\bpaid\b|payment\s+(?:successful|complete)|已支付|支付成功|已付款|payée?|bezahlt|pagad[oa]|pagat[oa]|支払済|支払い完了|결제\s*완료/i:/order\s+(?:confirmed|placed|successful)|thank\s+you\s+for\s+your\s+(?:order|purchase)|订单(?:提交|创建)?成功|訂單成功|下单成功/i;
  const idPattern=/(?:order\s*(?:number\b|id\b|#)|订单号|訂單編號|订单编号|注文番号)\s*[:：#]?\s*([\w-]{1,100})/i;
  const candidates=(page.elements||[]).filter(el=>el.visible&&el.text&&el.text.length<=500&&!negative.test(el.text));
  const explicit=candidates.find(el=>success.test(el.text));
  const ids=[...new Set(candidates.map(el=>el.text.match(idPattern)?.[1]).filter(Boolean))];
  const id=ids.length===1?ids[0]:null;
  if(kind==='payment')return explicit?{text:explicit.text,orderId:id}:null;
  return explicit&&id?{text:explicit.text,orderId:id}:null;
}
