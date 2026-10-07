import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import('playwright-core');
const {createOrderBrowser}=await import(pathToFileURL(path.join(process.cwd(),'lib/order-browser.js')));
process.env.MONITOR_BROWSER_EXECUTABLE||=process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':'/usr/bin/chromium';
const requests=[],failures=[];let callbackVisits=0,browser;
const login='<form method="post" action="/authenticate?returnto=%2Fcart.php%3Fa%3Dcomplete"><label>Email<input name="email"></label><label>Password<input name="password" type="password"></label><button style="position:absolute;left:20px;top:120px;width:120px;height:40px">Log in</button></form>';
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');let raw='';for await(const chunk of req)raw+=chunk;requests.push({path:url.pathname,method:req.method,quantity:new URLSearchParams(raw).get('quantity')});res.setHeader('content-type','text/html; charset=utf-8');
 if(url.pathname==='/login'){res.end(login);return;}
 if(url.pathname==='/authenticate'){res.writeHead(303,{'set-cookie':'session=audit-valid; HttpOnly; Path=/','location':'/account'});res.end();return;}
 if(url.pathname==='/callback'){callbackVisits++;if(callbackVisits===1){res.writeHead(303,{location:'/account'});res.end();}else res.end(login);return;}
 if(url.pathname==='/account'){res.end((req.headers.cookie||'').includes('session=audit-valid')?'<h1>Account</h1><a href="/logout">Log out</a>':login);return;}
 if(url.pathname==='/cart-config'){res.end('<form action="/wrong" method="get"><input name="quantity" value="1"><button id="cart" formaction="/cart-actual" formmethod="post">Continue</button></form>');return;}
 if(url.pathname==='/cart-actual'){res.writeHead(303,{location:'/product?override=1'});res.end();return;}
 if(url.pathname==='/product'){
  const override=url.searchParams.has('override'),stale=url.searchParams.has('stale'),mutate=url.searchParams.has('mutate'),cross=url.searchParams.has('cross'),get=url.searchParams.has('get');
  const target=cross?'https://other.invalid/create':'/create'+(url.searchParams.has('http500')?'?http500=1':url.searchParams.has('redirect500')?'?redirect500=1':'');
  res.end('<a href="/logout">Log out</a>'+(stale?'<p id="confirmation">Previous order created</p>':'')+'<form action="'+(override?'/wrong':target)+'" method="'+(override?'get':'post')+'"><h1 id="product">Product A</h1><input id="quantity" name="quantity" value="1"><p id="total">USD 10.00</p><p id="currency">USD</p><button id="submit"'+(override||cross?' formaction="'+target+'" formmethod="post"':'')+(get?' formmethod="get"':'')+(mutate?' onclick="document.getElementById(&#39;quantity&#39;).value=&#39;2&#39;"':'')+'>Submit Order</button></form>');return;
 }
 if(url.pathname==='/create'){
  if(url.searchParams.has('redirect500')){res.writeHead(303,{location:'/failed-confirmation'});res.end();return;}
  if(url.searchParams.has('http500'))res.statusCode=500;
  res.end('<h1 id="confirmation">Order audit-42 created</h1><form action="/wrong" method="get"><input id="invoice" type="hidden" name="invoiceid" value="audit-42"><p id="invoice-total">USD 10.00</p><p id="invoice-currency">USD</p><p id="balance">USD 20.00</p><p id="balance-currency">USD</p><button id="pay" formaction="/pay-actual" formmethod="post">Pay now with account balance</button></form>');return;
 }
 if(url.pathname==='/failed-confirmation'){res.statusCode=500;res.end('<h1 id="confirmation">Order audit-42 created</h1>');return;}
 if(url.pathname==='/pay-actual'){res.end('<h1 id="paid">Payment successful: audit-42 Paid</h1>');return;}
 res.statusCode=400;res.end('Wrong request');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const checkout={submitSelector:'#submit',productSelector:'#product',quantitySelector:'#quantity',totalSelector:'#total',currencySelector:'#currency',confirmationSelector:'#confirmation'};
const task=(suffix='')=>({url:base+'/product'+suffix,product:'Product A',quantity:1,maxTotal:10,currency:'USD',executionMode:'pay',program:{checkout}});
const run=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(error){failures.push(name+': '+error.message);console.error('FAIL '+name+': '+error.message);}finally{if(browser)await browser.close();browser=null;}};
try{
 await run('genuine login form with a nested checkout return URL saves in a fresh browser',async()=>{
  browser=await createOrderBrowser({url:base+'/login'},{loginOnly:true});let view=await browser.remote.view();for(const field of view.fields)view=await browser.remote.act({type:'fill',key:field.key,value:field.type==='password'?'audit-password':'audit@example.test'});
  await browser.remote.act({type:'click',x:70,y:140});const saved=await browser.remote.finish();assert.equal(saved.check.url,base+'/account');assert.ok(saved.state.cookies.some(cookie=>cookie.name==='session'));assert.ok(!JSON.stringify(browser.trace).includes('audit-password'));
 });
 await run('one-use login check redirects are visited once and refreshed to the canonical account URL',async()=>{
  callbackVisits=0;browser=await createOrderBrowser({url:base+'/callback'},{storageState:{cookies:[{name:'session',value:'audit-valid',domain:'127.0.0.1',path:'/',expires:-1,httpOnly:true,secure:false,sameSite:'Lax'}],origins:[]},sessionStorageState:{rotation:'current'},loginCheck:{url:base+'/callback'},accountReadOnly:true});
  const state=await browser.accountState();assert.equal(callbackVisits,1);assert.equal(state.check.url,base+'/account');assert.ok(!Object.keys(state.sessionStorage).some(key=>key.startsWith('__radar_session_seed_')));assert.equal((await browser.verifyLogin(state.check)).url,base+'/account');
 });
 await run('cart, order and payment honor the clicked button form overrides with one POST each',async()=>{
  const before=requests.length;let submits=0,pays=0;browser=await createOrderBrowser({...task('?override=1'),url:base+'/cart-config'},{onBeforeSubmit:async()=>submits++,onBeforePayment:async()=>pays++});
  await browser.methods.cart('#cart');assert.equal((await browser.methods.submit()).status,'ordered');const paid=await browser.methods.pay({paySelector:'#pay',invoiceSelector:'#invoice',totalSelector:'#invoice-total',currencySelector:'#invoice-currency',balanceSelector:'#balance',balanceCurrencySelector:'#balance-currency',confirmationSelector:'#paid'});assert.equal(paid.status,'paid');assert.equal(submits,1);assert.equal(pays,1);
  for(const route of ['/cart-actual','/create','/pay-actual'])assert.equal(requests.slice(before).filter(request=>request.path===route&&request.method==='POST').length,1);assert.ok(!requests.slice(before).some(request=>request.path==='/wrong'));
 });
 await run('a pre-existing order confirmation cannot prove success or consume the submit ledger',async()=>{
  let submits=0;const before=requests.length;browser=await createOrderBrowser(task('?stale=1'),{onBeforeSubmit:async()=>submits++});await assert.rejects(browser.methods.submit(),/确认元素|确认.*已经/);assert.equal(submits,0);assert.ok(!requests.slice(before).some(request=>request.method==='POST'));
 });
 await run('merchant HTTP 500 with a success-looking body remains an error after a single POST',async()=>{
  const before=requests.length;browser=await createOrderBrowser(task('?http500=1'));await assert.rejects(browser.methods.submit(),error=>error.code==='ORDER_REQUEST_HTTP_ERROR'&&/500/.test(error.message));assert.equal(requests.slice(before).filter(request=>request.path==='/create'&&request.method==='POST').length,1);assert.equal(browser.receipt,null);
 });
 await run('HTTP 500 after a POST redirect cannot turn success-looking text into a confirmed order',async()=>{
  const before=requests.length;browser=await createOrderBrowser(task('?redirect500=1'));await assert.rejects(browser.methods.submit(),error=>error.code==='ORDER_REQUEST_HTTP_ERROR'&&/500/.test(error.message));assert.equal(requests.slice(before).filter(request=>request.path==='/create'&&request.method==='POST').length,1);assert.equal(browser.receipt,null);
 });
 for(const [suffix,label]of [['?get=1','GET override'],['?cross=1','cross-origin override']])await run(label+' fails before the durable submission record',async()=>{
  let submits=0;const before=requests.length;browser=await createOrderBrowser(task(suffix),{onBeforeSubmit:async()=>submits++});await assert.rejects(browser.methods.submit());assert.equal(submits,0);assert.ok(!requests.slice(before).some(request=>request.path==='/create'));
 });
 await run('on-click quantity mutation is blocked before it reaches the merchant',async()=>{
  const before=requests.length;browser=await createOrderBrowser(task('?mutate=1'));await assert.rejects(browser.methods.submit(),error=>error.code==='ORDER_REQUEST_BLOCKED'&&/数量/.test(error.message));assert.ok(!requests.slice(before).some(request=>request.path==='/create'));
 });
 await run('stalled browser state reads are bounded and close the owned browser',async()=>{
  const launch=async options=>{const instance=await chromium.launch(options),newContext=instance.newContext.bind(instance);instance.newContext=async args=>{const context=await newContext(args);context.storageState=()=>new Promise(()=>{});return context;};return instance;};
  browser=await createOrderBrowser({url:base+'/account'},{launch,stateTimeoutMs:100});const started=Date.now();await assert.rejects(browser.accountState(),error=>error.code==='ORDER_ACCOUNT_STATE_TIMEOUT');assert.ok(Date.now()-started<1000);
 });
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
if(failures.length)throw new Error(failures.length+' resilience regressions failed:\n'+failures.join('\n'));
