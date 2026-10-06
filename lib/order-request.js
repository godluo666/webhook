const submissionActions = new Set(['complete', 'completeorder', 'submitorder', 'place-order', 'processcheckout']);
const paymentActions = new Set(['pay', 'processpayment', 'capture', 'charge']);
const decode = value => { try { return decodeURIComponent(value); } catch { return value; } };

// Inspect the actual route, never a return URL or an arbitrary query value.
export function orderRequestKind(value) {
  const url = new URL(value);
  const actions = [...url.pathname.split('/').map(decode), ...url.searchParams.getAll('a'), ...url.searchParams.getAll('action')].map(action => action.toLowerCase());
  if (actions.some(action => paymentActions.has(action))) return 'payment';
  if (actions.some(action => submissionActions.has(action))) return 'submission';
  return null;
}

// Diagnostics deliberately exclude cookies, request bodies, and query secrets.
export function describeOrderRequest(method, value) {
  const url = new URL(value);
  const path = url.pathname.replace(/[^/]{24,}/g, '[已隐藏]').slice(0, 160);
  const action = ['a', 'action'].flatMap(key => url.searchParams.getAll(key).map(value => ({key, value: value.toLowerCase()}))).find(({value}) => submissionActions.has(value) || paymentActions.has(value));
  return method + ' ' + path + (action ? '?' + action.key + '=' + action.value : '');
}

// Login guards inspect the action itself, excluding nested return URLs.
export function isOrderAccountAction(value) {
  const url=new URL(value),parts=[...url.pathname.split('/').map(decode),...url.searchParams.getAll('a'),...url.searchParams.getAll('action')];
  return Boolean(orderRequestKind(value))||parts.some(part=>/(?:^|[._-])(?:pay(?:ment)?|checkout|cart|orders?|register|signup)(?:$|[._-])/i.test(part));
}
