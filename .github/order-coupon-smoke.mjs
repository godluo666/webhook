import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.cwd();
const {createOrderBrowser}=await import(pathToFileURL(path.join(root,'lib/order-browser.js')));
const {createOrderService,validateOrderTask,validateOrderProgram,orderProgramHash}=await import(pathToFileURL(path.join(root,'lib/orders.js')));
const {runOrderWorkflow}=await import(pathToFileURL(path.join(root,'lib/order-workflow.js')));
process.env.MONITOR_BROWSER_EXECUTABLE||=process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':'/usr/bin/chromium';
const checkout={submitSelector:'#submit',productSelector:'#product',quantitySelector:'#quantity',totalSelector:'#total',currencySelector:'#currency',confirmationSelector:'#confirmation'};
const coupon={inputSelector:'#promo',applySelector:'#apply',appliedCodeSelector:'#applied',discountSelector:'#discount'};
const paymentChecks={paySelector:'#pay',invoiceSelector:'#invoice',totalSelector:'#invoice-total',currencySelector:'#invoice-currency',balanceSelector:'#balance',balanceCurrencySelector:'#balance-currency',confirmationSelector:'#paid'};
const generated={summary:'应用并核验优惠码后按真实总价提交、付款一次',checkout,coupon,workflow:{version:1,prepareCode:'function(o,b){b.goto(o.url);return {ready:true};}',paymentCode:'function(){return {checks:'+JSON.stringify(paymentChecks)+'};}'}};
const program=validateOrderProgram(generated,{requireWorkflow:true});
const carts=new Map(),requests=[],failures=[];let sequence=0,browser,base;
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function product(id,cart){
 const query='?cart='+id,shared=cart.scenario==='submit-mutation',duplicate=cart.scenario==='duplicate';
 const target=cart.scenario==='financial'?'/pay':cart.scenario==='disguised'?'/create'+query:'/apply'+query;
 const field='<input id="promo" name="promocode" value="'+escape(cart.code||'')+'">'+(duplicate?'<input type="hidden" name="promocode" value="EXTRA">':'')+(cart.scenario==='autopay'?'<input type="checkbox" name="autopay" checked>':'');
 const mutate=cart.scenario==='mutation'?'onclick="document.getElementById(\'promo\').value=\'OTHER\'"':'';
 const ajax=cart.scenario==='ajax',ajaxClick=ajax?'onclick="event.preventDefault();fetch(this.form.action,{method:\'POST\',headers:{\'content-type\':\'application/json\'},body:JSON.stringify({promocode:document.getElementById(\'promo\').value})}).then(r=>r.json()).then(data=>setTimeout(()=>{document.getElementById(\'applied\').textContent=data.code;document.getElementById(\'applied\').style.display=\'block\';document.getElementById(\'discount\').textContent=\'USD -\'+data.discount;document.getElementById(\'discount\').style.display=\'block\';document.getElementById(\'total\').textContent=\'USD \'+data.total;},250))"':mutate;
 const apply='<button id="apply" '+(ajax?'type="button"':'type="submit"')+' formaction="'+target+'" '+ajaxClick+'>Apply coupon</button>';
 const editProof=cart.scenario==='editable'&&cart.code;
 const proof=editProof?'<input id="applied" value="'+escape(cart.code)+'">':'<span id="applied" '+(!cart.code&&!cart.failed?'style="display:none"':'')+'>'+escape(cart.failed?'Invalid coupon '+cart.failed:cart.code||'')+'</span>';
 const discount='<span id="discount" '+(!cart.code&&!cart.failed?'style="display:none"':'')+'>'+ (cart.scenario==='percent'?'20%':(cart.scenario==='mixed-discount'?'20% coupon discount: ':'')+'USD -'+cart.discount.toFixed(2))+'</span>';
 const totals='<h1 id="product">Product A</h1><span id="total">USD '+cart.total.toFixed(2)+'</span><span id="currency">USD</span>';
 const submit='<button id="submit" '+(shared?'onclick="document.getElementById(\'promo\').value=\'OTHER\'"':'')+'>Submit order</button>';
 const gateway=cart.scenario==='website-payment'?'<select id="gateway" name="paymentmethod"><option value="card">Credit Card</option><option value="alipay">Alipay</option></select>':'';
 const order='<form method="post" action="/create'+query+'"><input id="quantity" name="quantity" value="1">'+gateway+(shared?field+apply:'')+submit+'</form>';
 const promotion=shared?'':'<form method="post" action="'+(cart.scenario==='override'?'/wrong':target)+'">'+field+apply+'</form>';
 return '<a href="/logout">Log out</a>'+totals+promotion+proof+discount+order;
}
const server=http.createServer(async(req,res)=>{
 try{
 const url=new URL(req.url,'http://localhost'),id=url.searchParams.get('cart'),cart=carts.get(id);let raw='';for await(const part of req)raw+=part;
 requests.push({path:url.pathname,method:req.method,cart:id,raw});res.setHeader('content-type','text/html; charset=utf-8');
 if(!req.headers.cookie?.includes('merchant_session=coupon-buyer')){res.writeHead(401);res.end('<form><input type="password"><button>Log in</button></form>');return;}
 if(!cart){res.writeHead(404);res.end('Missing cart');return;}
 if(url.pathname==='/product'){res.end(product(id,cart));return;}
 if(url.pathname==='/apply-replay'){cart.replays++;res.end('Unexpected replay');return;}
 if(url.pathname==='/apply'){
  assert.equal(req.method,'POST');cart.applies++;
  if(cart.scenario==='redirect'){res.writeHead(307,{location:'/apply-replay?cart='+id});res.end();return;}
  const submitted=/application\/json/.test(req.headers['content-type']||'')?JSON.parse(raw).promocode:new URLSearchParams(raw).get('promocode');
  assert.equal(submitted,cart.requested);
  if(submitted==='INVALID'){cart.failed=submitted;cart.discount=0;cart.total=20;}
  else{cart.code=cart.scenario==='mismatch'?'OTHER':cart.scenario==='unicode-mismatch'?submitted+'码':submitted.toUpperCase();cart.discount=submitted==='FREE'?20:submitted==='SAVE10'?2:5;cart.total=cart.scenario==='no-effect'?20:20-cart.discount;}
  if(cart.scenario==='ajax'){res.setHeader('content-type','application/json');res.end(JSON.stringify({code:cart.code,discount:cart.discount,total:cart.total}));return;}
  res.writeHead(303,{location:'/product?cart='+id});res.end();return;
 }
 if(url.pathname==='/create'){
  assert.equal(req.method,'POST');assert.equal(new URLSearchParams(raw).get('quantity'),'1');if(cart.scenario==='website-payment')assert.equal(new URLSearchParams(raw).get('paymentmethod'),'alipay');cart.guard?.('submit');cart.orders++;
  res.writeHead(303,{location:'/invoice?cart='+id+'&id=42'});res.end();return;
 }
 if(url.pathname==='/pay'){
  assert.equal(req.method,'POST');assert.equal(new URLSearchParams(raw).get('invoiceid'),'42');if(cart.scenario==='website-payment')assert.equal(new URLSearchParams(raw).get('paymentmethod'),'alipay');cart.guard?.('pay');cart.payments++;
  res.writeHead(303,{location:'/invoice?cart='+id+'&id=42'});res.end();return;
 }
 if(url.pathname==='/invoice'){
  if(cart.payments){res.end('<a href="/logout">Log out</a><h1 id="paid">Invoice #42 Paid</h1>');return;}
  const total=cart.scenario==='invoice-mismatch'?20:cart.total;
  const gateway=cart.scenario==='website-payment'?'<select id="invoice-gateway" name="paymentmethod"><option value="card">Credit Card</option><option value="alipay">Alipay</option></select>':'';
  res.end('<a href="/logout">Log out</a><h1 id="confirmation">Order #42 created</h1><form method="post" action="/pay?cart='+id+'"><input id="invoice" type="hidden" name="invoiceid" value="42"><span id="invoice-total">USD '+total.toFixed(2)+'</span><span id="invoice-currency">USD</span><span id="balance">USD 100.00</span><span id="balance-currency">USD</span>'+gateway+'<button id="pay">'+(gateway?'Continue to payment':'Pay now with account balance')+'</button></form>');return;
 }
 res.writeHead(404);res.end('Unknown endpoint');
 }catch(error){failures.push('Merchant assertion: '+error.message);res.writeHead(500);res.end('Fixture failed');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
const storageState={cookies:[{name:'merchant_session',value:'coupon-buyer',domain:'127.0.0.1',path:'/',expires:-1,httpOnly:true,secure:false,sameSite:'Lax'}],origins:[]};
function fixture(scenario='normal',code='SAVE20',mode='pay'){
 const id=String(++sequence),cart={scenario,requested:code,code:'',total:20,discount:0,applies:0,orders:0,payments:0,replays:0};carts.set(id,cart);
 const task=validateOrderTask({label:'优惠码验证',url:base+'/product?cart='+id,product:'Product A',quantity:1,maxTotal:code?15:25,currency:'USD',couponCode:code,executionMode:mode,monitorId:'monitor-'+id});task.program=program;
 return {id,cart,task,open:async()=>browser=await createOrderBrowser(task,{storageState,couponVerificationTimeoutMs:1000})};
}
async function run(label,fn){try{await fn();console.log('PASS '+label);}catch(error){failures.push(label+': '+error.stack);console.error('FAIL '+label+': '+error.message);}finally{if(browser){await browser.close();browser=null;}}}
try{
 await run('blank coupon preserves the original workflow and makes no promotion requests',async()=>{
  const f=fixture('normal','','prepare');await f.open();const result=await runOrderWorkflow(program,f.task,browser.methods);assert.equal(result.review.total,20);assert.equal(result.review.coupon,undefined);assert.equal(f.cart.applies,0);assert.equal(f.cart.orders,0);
 });
 await run('two service trials then one trigger reuse the accepted coupon without stacking or duplicate orders/payments',async()=>{
  const f=fixture(),user={id:'coupon-user',monitors:[{id:f.task.monitorId,kind:'webpage'}],orderTasks:[f.task],orderAccounts:[{monitorId:f.task.monitorId,loginUrl:f.task.url,revision:1,status:'saved',session:{state:storageState,check:{url:f.task.url}}}]};let ai=0,writes=0;
  f.cart.guard=phase=>assert.ok(phase==='submit'?f.task.submissionStartedAt:f.task.paymentStartedAt,'Transaction ledger exists before merchant action');
  const service=createOrderService({persist:()=>writes++,requestAI:async(_user,messages)=>{ai++;assert.equal(JSON.parse(messages[1].content).order.couponCode,'SAVE20');return generated;}});
  await service.generate(user,f.task);assert.equal(ai,1);assert.equal(f.cart.applies,1);assert.equal(f.cart.orders,0);assert.equal(f.task.trial.review.total,15);assert.deepEqual(f.task.trial.review.coupon,{code:'SAVE20',discount:5});
  service.approve(user,f.task,orderProgramHash(f.task));await service.trigger(user,user.monitors[0]);await service.trigger(user,user.monitors[0]);assert.equal(f.task.status,'paid');assert.equal(f.task.result.payment.total,15);assert.equal(f.cart.orders,1);assert.equal(f.cart.payments,1);assert.equal(f.cart.applies,1);assert.ok(writes>0);
 });
 for(const [scenario,code]of [['override','Save-20'],['ajax','SAVE+20'],['normal','省钱-20'],['mixed-discount','SAVE20']])await run(scenario+' application validates the actual code, canonical case and reduced payable total',async()=>{
  const f=fixture(scenario,code);await f.open();const result=await runOrderWorkflow(program,f.task,browser.methods);assert.equal(result.status,'paid');assert.equal(result.review.total,15);assert.equal(result.payment.total,15);assert.equal(f.cart.applies,1);assert.equal(f.cart.orders,1);assert.equal(f.cart.payments,1);
 });
 await run('coupon reload restores the user-selected website payment method instead of using a default card',async()=>{
  const f=fixture('website-payment');f.task.paymentMethod={kind:'website',name:'Alipay'};
  const p=validateOrderProgram({...generated,workflow:{...generated.workflow,prepareCode:'function(o,b){b.goto(o.url);b.choosePayment({selector:"#gateway",value:"alipay"});return {ready:true};}',paymentCode:'function(){return {checks:'+JSON.stringify({...paymentChecks,paymentMethod:{selector:'#invoice-gateway',value:'alipay'}})+'};}'}},{requireWorkflow:true});f.task.program=p;await f.open();
  const result=await runOrderWorkflow(p,f.task,browser.methods);assert.equal(result.status,'paid');assert.equal(result.paymentMethod.kind,'website');assert.equal(result.paymentMethod.value,'alipay');assert.equal(result.payment.total,15);assert.equal(f.cart.orders,1);assert.equal(f.cart.payments,1);
 });
 await run('changing a previously applied coupon verifies the replacement against the price before either discount',async()=>{
  const f=fixture('normal','SAVE10');f.cart.code='SAVE20';f.cart.discount=5;f.cart.total=15;f.task.maxTotal=20;await f.open();
  const result=await runOrderWorkflow(program,f.task,browser.methods);assert.equal(result.status,'paid');assert.deepEqual(result.review.coupon,{code:'SAVE10',discount:2});assert.equal(result.payment.total,18);assert.equal(f.cart.applies,1);assert.equal(f.cart.orders,1);assert.equal(f.cart.payments,1);
 });
 await run('invalid coupon stops generation after one AI response and one coupon request, with no orders or payments',async()=>{
  const f=fixture('normal','INVALID'),user={id:'invalid-user',monitors:[{id:f.task.monitorId,kind:'webpage'}],orderTasks:[f.task],orderAccounts:[{monitorId:f.task.monitorId,loginUrl:f.task.url,revision:1,status:'saved',session:{state:storageState,check:{url:f.task.url}}}]};let ai=0;
  const service=createOrderService({persist:()=>{},requestAI:async()=>{ai++;return generated;},openBrowser:(task,options)=>createOrderBrowser(task,{...options,couponVerificationTimeoutMs:1000})});
  await assert.rejects(service.generate(user,f.task),error=>error.code==='ORDER_COUPON_REJECTED');assert.equal(ai,1);assert.equal(f.cart.applies,1);assert.equal(f.cart.orders,0);assert.equal(f.cart.payments,0);assert.equal(user.orderAccounts[0].status,'saved');
 });
 for(const scenario of ['mutation','duplicate','financial','disguised','autopay'])await run(scenario+' coupon request is rejected before reaching the merchant',async()=>{
  const f=fixture(scenario);await f.open();await assert.rejects(runOrderWorkflow(program,f.task,browser.methods));assert.equal(f.cart.applies,0);assert.equal(f.cart.orders,0);assert.equal(f.cart.payments,0);
 });
 for(const scenario of ['no-effect','mismatch','unicode-mismatch','percent','editable'])await run(scenario+' evidence cannot authorize order submission',async()=>{
  const f=fixture(scenario,scenario==='unicode-mismatch'?'省钱':'SAVE20');await f.open();await assert.rejects(runOrderWorkflow(program,f.task,browser.methods));assert.equal(f.cart.orders,0);assert.equal(f.cart.payments,0);
 });
 await run('coupon POST 307 is stopped before any replay',async()=>{
  const f=fixture('redirect');await f.open();await assert.rejects(runOrderWorkflow(program,f.task,browser.methods),/重发/);assert.equal(f.cart.applies,1);assert.equal(f.cart.replays,0);assert.equal(f.cart.orders,0);
 });
 await run('final order body cannot replace a reviewed coupon during the submit click',async()=>{
  const f=fixture('submit-mutation');await f.open();await assert.rejects(runOrderWorkflow(program,f.task,browser.methods),error=>error.code==='ORDER_COUPON_UNVERIFIED');assert.equal(f.cart.applies,1);assert.equal(f.cart.orders,0);assert.equal(f.cart.payments,0);
 });
 await run('original invoice must match the discounted review before any payment',async()=>{
  const f=fixture('invoice-mismatch');await f.open();await assert.rejects(runOrderWorkflow(program,f.task,browser.methods),/付款金额/);assert.equal(f.cart.orders,1);assert.equal(f.cart.payments,0);
 });
 await run('fully discounted order is submitted once and does not run payment or claim an unverified paid status',async()=>{
  const f=fixture('normal','FREE'),user={id:'free-user',monitors:[{id:f.task.monitorId,kind:'webpage'}],orderTasks:[f.task],orderAccounts:[{monitorId:f.task.monitorId,loginUrl:f.task.url,revision:1,status:'saved',session:{state:storageState,check:{url:f.task.url}}}]};
  const service=createOrderService({persist:()=>{},requestAI:async()=>generated});await service.generate(user,f.task);service.approve(user,f.task,orderProgramHash(f.task));await service.execute(user,f.task);
  assert.equal(f.task.status,'awaiting_payment');assert.equal(f.task.result.paymentPending.reason,'zero_total');assert.equal(f.task.result.review.total,0);assert.equal(f.cart.orders,1);assert.equal(f.cart.payments,0);
 });
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
if(failures.length)throw new Error(failures.length+' coupon regressions failed:\n'+failures.join('\n'));
