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

export function inspectRequestStructure(request){
  const type=String(request.headers()['content-type']||'').split(';')[0].trim().toLowerCase();
  let fields=[];
  try{
    const data=request.postData()||'';if(data.length>65536)throw new Error();
    if(type==='application/json'){const value=JSON.parse(data);if(!value||Array.isArray(value)||typeof value!=='object')throw new Error();fields=Object.entries(value).map(([name,item])=>({name,type:item===null?'null':Array.isArray(item)?'array':typeof item}));}
    else if(type==='application/x-www-form-urlencoded')fields=[...new Set(new URLSearchParams(data).keys())].map(name=>({name,type:'string'}));
  }catch{return {method:request.method(),contentType:type,valid:false};}
  return {method:request.method(),endpoint:describeOrderRequest(request.method(),request.url()),contentType:type,fields:fields.slice(0,40).map(({name,type})=>({name:/^[a-z][a-z0-9_.-]{0,48}$/i.test(name)&&!/(token|secret|csrf|session|password|auth)/i.test(name)?name:'[private]',type})),valid:fields.length>0&&fields.length<=40};
}

// Login guards inspect the action itself, excluding nested return URLs.
export function isOrderAccountAction(value) {
  const url=new URL(value),parts=[...url.pathname.split('/').map(decode),...url.searchParams.getAll('a'),...url.searchParams.getAll('action')];
  return Boolean(orderRequestKind(value))||parts.some(part=>/(?:^|[._-])(?:pay(?:ment)?|checkout|cart|orders?|register|signup)(?:$|[._-])/i.test(part));
}
