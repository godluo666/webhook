import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {createOrderBrowser}=await import(pathToFileURL(path.join(process.cwd(),'lib/order-browser.js')));
const {createOrderService,validateOrderTask,orderProgramHash}=await import(pathToFileURL(path.join(process.cwd(),'lib/orders.js')));
process.env.MONITOR_BROWSER_EXECUTABLE||='/usr/bin/chromium';
let orders=0,profilePosts=0,identity='Account 42',rotatingSession='valid';
const checkout={submitSelector:'#submit',productSelector:'#product',quantitySelector:'#quantity',totalSelector:'#total',currencySelector:'#currency',confirmationSelector:'#confirmation'};
const product='<form id="checkout" action="/create" method="post"><h1 id="product">Product A</h1><input id="quantity" name="quantity" value="1"><p id="total">USD 10.00</p><p id="currency">USD</p><button id="submit">Submit Order</button></form>';
const login='<form action="/login"><input name="email"><input type="password" name="password"><button>Log in</button></form>';
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');for await(const chunk of req){};
 res.setHeader('content-type','text/html; charset=utf-8');
 if(url.pathname==='/account')return res.end('<a href="/logout">Log out</a>');
 if(url.pathname==='/identity')return res.end((req.headers.cookie||'').includes('session=valid')?'<p id="identity">'+identity+'</p>':login);
 if(url.pathname==='/public-marker')return res.end('<p id="identity">Public heading</p>');
 if(url.pathname==='/account-post')return res.end('<div id="profile"></div><script>fetch("/profile-query",{method:"POST"}).then(r=>r.text()).then(t=>document.getElementById("profile").innerHTML=t).catch(()=>{})</script>');
 if(url.pathname==='/profile-query'){profilePosts++;return res.end('<a href="/logout">Log out</a>');}
 if(url.pathname==='/rotating'){
  if(!(req.headers.cookie||'').split(';').some(v=>v.trim()==='session='+rotatingSession))return res.end(login);
  rotatingSession+='x';res.setHeader('set-cookie','session='+rotatingSession+'; HttpOnly; Path=/');
  return res.end('<a href="/logout">Log out</a>'+product.replace('id="submit"','id="submit" onclick="document.getElementById(\'quantity\').value=2"')+'<button type="button" id="deny-storage" onclick="Object.defineProperty(window,\'sessionStorage\',{get(){throw new DOMException(\'Failed to read the sessionStorage property: Access is denied for this document.\',\'SecurityError\')}})">Simulate inaccessible storage</button>');
 }
 if(url.pathname==='/background')return res.end('<input id="field" readonly value="1"><script>setTimeout(()=>fetch("/heartbeat",{method:"POST"}).catch(()=>{}),1200);setTimeout(()=>document.getElementById("field").readOnly=false,1500)</script>');
 if(url.pathname==='/product')return res.end('<a href="/logout">Log out</a><section id="selected">Product A — In stock</section>'+product);
 if(url.pathname==='/long')return res.end('<nav>'+Array.from({length:170},(_,i)=>'<a href="#nav-'+i+'">Nav '+i+'</a>').join('')+'</nav>'+product);
 if(url.pathname==='/create'){orders++;return res.end('<h1 id="confirmation">Order '+orders+' created</h1>');}
 res.statusCode=404;res.end('missing');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const state={cookies:[{name:'session',value:'valid',domain:'127.0.0.1',path:'/',expires:-1,httpOnly:true,secure:false,sameSite:'Lax'}],origins:[]};
let browser;
const run=async(name,fn)=>{try{await fn();console.log('PASS '+name);}finally{if(browser)await browser.close();browser=null;}};
try{
 await run('account identity marker restores, excludes anonymous users and rejects account switches',async()=>{
  browser=await createOrderBrowser({url:base+'/identity'},{loginOnly:true,storageState:state,loginProof:{selector:'#identity'},loginVerificationTimeoutMs:500});
  const saved=await browser.remote.finish();assert.equal(saved.check.proof.text,'Account 42');await browser.close();browser=null;
  identity='Account 43';await assert.rejects(createOrderBrowser({url:base+'/identity'},{storageState:saved.state,loginCheck:saved.check,loginVerificationTimeoutMs:500}),e=>e.code==='ORDER_LOGIN_UNVERIFIED');identity='Account 42';
 });
 await run('public headings cannot be saved as authentication evidence',async()=>{
  browser=await createOrderBrowser({url:base+'/public-marker'},{loginOnly:true,loginProof:{selector:'#identity'},loginVerificationTimeoutMs:500});
  await assert.rejects(browser.remote.finish(),e=>e.code==='ORDER_LOGIN_UNVERIFIED'&&/未登录/.test(e.message));
 });
 await run('configured server-rendered account page avoids blocked profile queries without permitting them',async()=>{
  browser=await createOrderBrowser({url:base+'/account-post',checkUrl:base+'/account'},{loginOnly:true,loginVerificationTimeoutMs:500});await browser.verifyLogin();assert.equal(profilePosts,1);
  const saved=await browser.remote.finish();assert.equal(saved.check.url,base+'/account');assert.equal(profilePosts,1);
 });
 await run('blocked navigation keeps rotating login cookies and prior session storage without repeating the order',async()=>{
  browser=await createOrderBrowser({url:base+'/rotating',product:'Product A',quantity:1,maxTotal:10,currency:'USD',executionMode:'submit',program:{checkout}},{storageState:state,sessionStorageState:{prior:'keep'},loginCheck:{url:base+'/rotating'}});
  await assert.rejects(browser.methods.submit(),e=>e.code==='ORDER_REQUEST_BLOCKED');
  // Allow the aborted navigation to reach Chromium's opaque error document.
  await new Promise(resolve=>setTimeout(resolve,250));
  const saved=await browser.accountState();assert.equal(saved.state.cookies.find(c=>c.name==='session').value,rotatingSession);assert.equal(saved.sessionStorage.prior,'keep');assert.equal(orders,0);
  await browser.close();browser=await createOrderBrowser({url:base+'/rotating'},{storageState:saved.state,sessionStorageState:saved.sessionStorage,loginCheck:saved.check,loginVerificationTimeoutMs:500});assert.equal((await browser.verifyLogin(saved.check)).url,base+'/rotating');
  // Deterministically cover the storage exception as the aborted-navigation
  // error-document timing differs between Chromium versions.
  await browser.methods.click('#deny-storage');const retained=await browser.accountState();assert.equal(retained.state.cookies.find(c=>c.name==='session').value,rotatingSession);assert.equal(retained.sessionStorage.prior,'keep');assert.ok(browser.trace.some(e=>e.action==='会话存储保留'));
 });
 await run('unrelated background POST during a waiting fill stays blocked without poisoning the workflow',async()=>{
  browser=await createOrderBrowser({url:base+'/background',dryRun:true});await browser.methods.fill('#field','2');await browser.snapshot();
  assert.ok(browser.trace.some(e=>e.action==='拦截后台请求'&&e.detail.includes('/heartbeat')));
 });
 await run('checkout evidence survives long navigation menus and supports scoped snapshots',async()=>{
  browser=await createOrderBrowser({url:base+'/long',dryRun:true});const evidence=await browser.snapshot();assert.ok(evidence.truncated.elements);assert.ok(evidence.elements.some(e=>e.id==='submit'));
  const focused=await browser.methods.snapshot('#checkout');assert.equal(focused.truncated.elements,false);assert.equal(focused.elements.some(e=>e.tag==='a'),false);
 });
 await run('restock text may change while a different product is still rejected',async()=>{
  const task={url:base+'/product',dryRun:true,productSelection:{url:base+'/product',selector:'#selected',text:'Product A — Out of stock'}};
  browser=await createOrderBrowser(task);await browser.close();browser=null;
  await assert.rejects(createOrderBrowser({...task,productSelection:{...task.productSelection,text:'Product B — Out of stock'}}),/商品身份/);
 });
 await run('bad payment syntax never reaches real browser trials or merchant submission',async()=>{
  const user={id:'readiness-user',settings:{},monitors:[{id:'m',kind:'webpage',url:base+'/product'}],orderAccounts:[{monitorId:'m',loginUrl:base+'/account',revision:1,status:'saved',session:{state,check:{url:base+'/account'}}}],orderTasks:[]};
  const task=validateOrderTask({monitorId:'m',url:base+'/product',product:'Product A',currency:'USD',quantity:1,maxTotal:10,executionMode:'pay'});user.orderTasks.push(task);
  const service=createOrderService({persist:()=>{},requestAI:async()=>({summary:'Invalid syntax fixture',checkout,workflow:{version:1,prepareCode:'function(){return {ready:true};}',paymentCode:'function(){ return {checks: ; }'}})});
  await assert.rejects(service.generate(user,task),e=>e.code==='ORDER_SCRIPT_INVALID');assert.equal(task.trial,null);assert.equal(task.enabled,false);assert.equal(orders,0);assert.throws(()=>service.approve(user,task,orderProgramHash(task)));
 });
 console.log('Order readiness regressions passed without real merchant requests.');
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
