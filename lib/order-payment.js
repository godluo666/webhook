// Payment names are user intent and visible merchant evidence, never site adapters.
const fold = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const brands = [
  ['balance', /\bbalance\b|^credit$|account\s*(?:balance|credit)|customer\s*credit|apply\s+credit|use\s+(?:balance|credit)|余额|餘額|账户信用额|账户余额|残高|guthaben|kontoguthaben|solde|saldo|رصيد/i],
  ['alipay', /alipay|支付宝|支付寶/i],
  ['paypal', /paypal/i],
  ['wechat', /wechat|weixin|微信/i],
  ['card', /credit\s*card|debit\s*card|bank\s*card|visa|mastercard|银行卡|信用卡|信用咭|借记卡|クレジット|kreditkarte|carte\s*bancaire/i],
  ['bank', /bank\s*transfer|wire\s*transfer|银行转账|銀行轉帳|überweisung|virement|bonifico/i]
];
export function paymentBrand(label) {
  // A card label can mention credit or an account: exclude it before balance.
  const ordered=[...brands.filter(([key])=>key!=='balance'),brands[0]];
  return ordered.find(([,pattern])=>pattern.test(String(label)))?.[0] || null;
}
export function normalizePaymentMethod(input) {
  if (input == null) return {kind:'balance', name:'账户余额'};
  if (!input || typeof input !== 'object' || !['balance','website'].includes(input.kind)) throw new Error('请选择有效的付款方式');
  if (input.kind === 'balance') return {kind:'balance', name:'账户余额'};
  const name = String(input.name || '').trim();
  if (!name || name.length > 100 || /[\r\n<>]/.test(name)) throw new Error('请填写网站付款方式的名称');
  if (paymentBrand(name) === 'balance') return {kind:'balance', name:'账户余额'};
  return {kind:'website', name};
}
export function paymentMatchesIntent(label, input) {
  const method = normalizePaymentMethod(input), actual = paymentBrand(label);
  if (method.kind === 'balance') return actual === 'balance';
  const wanted = paymentBrand(method.name);
  return wanted ? actual === wanted : !!fold(label) && fold(label) === fold(method.name);
}
export function samePaymentChoice(first, second) {
  if (!first || !second || first.kind !== second.kind) return false;
  const a=paymentBrand(first.label), b=paymentBrand(second.label);
  return a || b ? a === b && !!a : fold(first.label) === fold(second.label);
}
