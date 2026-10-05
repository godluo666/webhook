import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const root=process.cwd(), dataDir=await fs.mkdtemp(path.join(tmpdir(),'radar-orders-ui-'));
const nonce=randomBytes(4).toString('hex'), id=key=>key+'-'+nonce;
let available=false,total=9.5,createdOrders=0,paymentRequests=0,paidOrders=0,invoiceExtra=0,invoiceCurrency="USD",loginRequests=0,affiliateVisits=0,affiliateOrders=0,expired=false,layoutChanged=false,affWorking=true,requireOtp=true,sessionSequence=0,validSession='logged-in';
const aiRequests=[],messages=[],errors=[],orderRequestTimes=[];let productReads=0,overwriteAffOnSubmit=false;
const password='private-site-password-'+nonce, username='buyer@example.test';
let sourceBase;
const checkout={submitSelector:'#'+id('submit'),productSelector:'#'+id('product'),quantitySelector:'#'+id('quantity'),totalSelector:'#'+id('total'),currencySelector:'#'+id('currency'),confirmationSelector:'#'+id('confirmation')};
const code='function(order,browser){browser.goto(order.url);browser.fill("'+checkout.quantitySelector+'",String(order.quantity));browser.select("#'+id('billing')+'","monthly");browser.check("#'+id('terms')+'");return browser.submit();}';
const paidCode=code.replace('return browser.submit();', 'const result=browser.submit();if(result.status==="prepared")return result;const elements=browser.snapshot().elements;function locate(name){const field=elements.find(el=>el.id&&el.id.startsWith(name+"-"));if(!field)throw new Error("Missing payment field: "+name);return "#"+field.id;}return browser.pay({paySelector:locate("pay"),invoiceSelector:locate("invoice"),totalSelector:locate("invoice-total"),currencySelector:locate("invoice-currency"),confirmationSelector:"#"+"paid-"+elements.find(el=>el.id&&el.id.startsWith("invoice-")).id.split("-").at(-1)});');
const mock=http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://localhost');const authenticated=(req.headers.cookie||'').split(';').some(v=>v.trim()==='shop_session='+validSession);let raw='';for await(const part of req)raw+=part;
  if(url.pathname==='/v1/chat/completions'){
    aiRequests.push(JSON.parse(raw));assert.ok(raw.includes(id('product')),'Generation must observe the real DOM, including random selectors');
    const evidence=JSON.parse(JSON.parse(raw).messages.at(-1).content);
    const configPage=evidence.order.url.endsWith('/config');
    if(configPage && evidence.feedback) assert.ok(evidence.feedback.page?.elements.some(el=>el.id===id('total')+(layoutChanged?'-changed':'')),'Repair must receive the real next-page DOM');
    const generatedCheckout=configPage&&!evidence.feedback?{...checkout,totalSelector:'#unknown-next-page-total-'+nonce}:{...checkout,totalSelector:'#'+id('total')+(layoutChanged?'-changed':'')};
    if(evidence.order.instruction==='hold-to-cancel')await pause(5000);
    const selectedCode=evidence.order.executionMode==='pay'?paidCode:code;
    const generatedCode=configPage?selectedCode.replace('browser.fill(', 'if(browser.exists("#'+id('cart')+'"))browser.cart("#'+id('cart')+'");browser.fill('):selectedCode;
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({summary:'登录网站，选择月付商品，核对数量、币种与总价，只提交一次。',code:generatedCode,checkout:generatedCheckout,affiliate:evidence.order.affiliateUrl?{queryKey:'aff',cookieName:'partner_credit'}:null})}}]}));return;
  }
  if(url.pathname==='/aff'){affiliateVisits++;res.writeHead(302,{'set-cookie':'partner_credit='+(affWorking?url.searchParams.get('aff'):'wrong')+(overwriteAffOnSubmit?'; Path=/':'; HttpOnly; Path=/'),'location':'/product'});res.end();return;}
  if(url.pathname==='/login'&&req.method==='GET'){
    if(!expired&&authenticated){res.writeHead(302,{location:'/product'});res.end();return;}
    res.setHeader('content-type','text/html; charset=utf-8');res.end('<html><head><style>button{position:absolute;left:20px;top:120px;width:100px;height:40px}</style></head><body><form action="/login" method="post"><label>网站账号<input name="username" id="'+id('username')+'"></label><label>网站密码<input name="password" id="'+id('password')+'" type="password"></label><button id="'+id('login')+'">Log in</button></form></body></html>');return;
  }
  if(url.pathname==='/verify-login'&&req.method==='POST'){assert.equal(new URLSearchParams(raw).get('otp'),'123456');expired=false;res.writeHead(302,{'set-cookie':'shop_session='+validSession+'; HttpOnly; Path=/','location':'/product'});res.end();return;}
  if(url.pathname==='/hook'){messages.push(JSON.parse(raw));res.end('ok');return;}
  if(url.pathname==='/pay'){paymentRequests++;assert.equal(req.method,'POST');assert.ok(authenticated,'Stored session must track rotating login cookies');assert.equal(new URLSearchParams(raw).get('invoiceid'),String(createdOrders));paidOrders++;res.setHeader('content-type','text/html; charset=utf-8');res.end('<h1 id="'+id('paid')+'">Invoice #'+createdOrders+' Paid</h1>');return;}
  if(url.pathname==='/login'&&req.method==='POST'){
    loginRequests++;const values=new URLSearchParams(raw);assert.equal(values.get('username'),username);assert.equal(values.get('password'),password);
    if(requireOtp){res.setHeader('content-type','text/html; charset=utf-8');res.end('<style>button{position:absolute;left:20px;top:120px;width:100px;height:40px}</style><form action="/verify-login" method="post"><label>验证码<input name="otp" type="text"></label><button>Verify login</button></form>');return;}expired=false;res.writeHead(302,{'set-cookie':'shop_session='+validSession+'; HttpOnly; Path=/','location':url.searchParams.get('next')==='config'?'/config':'/product'});res.end();return;
  }
  if(url.pathname==='/create-order'&&req.method==='POST'){
    orderRequestTimes.push(Date.now());
    assert.match(req.headers.cookie||'',/shop_session=logged-in/);const values=new URLSearchParams(raw);assert.equal(values.get('quantity'),'1');assert.equal(values.get('billing'),'monthly');
    if((req.headers.cookie||'').includes('partner_credit=partner-42'))affiliateOrders++;createdOrders++;res.setHeader('content-type','text/html; charset=utf-8');res.end('<h1 id="'+id('confirmation')+'">Order #'+createdOrders+' created, unpaid</h1><form method="post" action="/pay"><input type="hidden" id="'+id('invoice')+'" name="invoiceid" value="'+createdOrders+'"><p id="'+id('invoice-total')+'">'+invoiceCurrency+' '+(total+invoiceExtra).toFixed(2)+'</p><p id="'+id('invoice-currency')+'">'+invoiceCurrency+'</p><button id="'+id('pay')+'">Pay now with account balance</button></form>');return;
  }
  if(url.pathname==='/config'){
    const logged=!expired&&authenticated;if(logged){validSession='logged-in-'+(++sessionSequence);res.setHeader('set-cookie','shop_session='+validSession+'; HttpOnly; Path=/');}
    res.setHeader('content-type','text/html; charset=utf-8');res.end('<h1 id="'+id('product')+'">Product A</h1>'+(logged?'<a href="/logout">Log out</a>':'<form action="/login?next=config" method="post"><input id="'+id('username')+'" name="username"><input id="'+id('password')+'" name="password" type="password"><button id="'+id('login')+'">Log in</button></form>')+'<form action="/configure-cart" method="post"><select name="cycle"><option value="monthly">Monthly</option></select><button id="'+id('cart')+'">Continue</button></form>');return;
  }
  if(url.pathname==='/configure-cart'&&req.method==='POST'){
    assert.match(req.headers.cookie||'',/shop_session=logged-in/);
    res.setHeader('content-type','text/html; charset=utf-8');res.end('<form action="/create-order" method="post"><h2 id="'+id('product')+'">Product A</h2><input id="'+id('quantity')+'" name="quantity" value="1"><select id="'+id('billing')+'" name="billing"><option value="monthly">Monthly</option></select><p id="'+id('total')+(layoutChanged?'-changed':'')+'">USD '+total.toFixed(2)+'</p><p id="'+id('currency')+'">USD</p><input id="'+id('terms')+'" type="checkbox" name="terms"><button '+(overwriteAffOnSubmit?'onclick="document.cookie=&#39;partner_credit=wrong; Path=/&#39;" ':'')+'id="'+id('submit')+'">Submit Order</button></form>');return;
  }
  if(url.pathname==='/product'){productReads++;
    const logged=!expired&&authenticated;if(logged){validSession='logged-in-'+(++sessionSequence);res.setHeader('set-cookie','shop_session='+validSession+'; HttpOnly; Path=/');}
    res.setHeader('content-type','text/html; charset=utf-8');
    res.end('<html><head><title>Fixture cloud product</title></head><body><h1>Product A</h1><p>'+(available?'available':'sold out')+'</p>'+(logged?'<a href="/logout">Log out</a>':'<form action="/login" method="post"><input id="'+id('username')+'" name="username"><input id="'+id('password')+'" name="password" type="password"><button id="'+id('login')+'">Log in</button></form>')+'<form action="/create-order" method="post"><h2 id="'+id('product')+'">Product A</h2><label>Quantity<input id="'+id('quantity')+'" name="quantity" value="1"></label><label>Billing<select id="'+id('billing')+'" name="billing"><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label><p id="'+id('total')+(layoutChanged?'-changed':'')+'">USD '+total.toFixed(2)+'</p><p id="'+id('currency')+'">USD</p><input id="'+id('terms')+'" type="checkbox" name="terms" value="accepted"><button '+(overwriteAffOnSubmit?'onclick="document.cookie=&#39;partner_credit=wrong; Path=/&#39;" ':'')+'id="'+id('submit')+'">Submit Order</button></form></body></html>');return;
  }
  res.writeHead(404);res.end();
 }catch(error){errors.push(error.message);res.writeHead(500);res.end(error.message);}
});
let browser,child,page;
try{
  sourceBase='http://127.0.0.1:'+await listen(mock);const reserve=http.createServer(),port=await listen(reserve);await new Promise(r=>reserve.close(r));const base='http://127.0.0.1:'+port;
  const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':'/usr/bin/chromium');
  child=spawn(process.execPath,['server.js'],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,DATA_DIR:dataDir,HOST:'127.0.0.1',PORT:String(port),MONITOR_BROWSER_EXECUTABLE:executable,RESEND_API_KEY:'',MAIL_FROM:'',SIGNUP_CODE:''}});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/auth/status')).ok)break;}catch{}await pause(50);}
  browser=await chromium.launch({executablePath:executable,headless:true,args:['--no-sandbox']});const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const post=async(endpoint,data={})=>{const r=await context.request.post(base+endpoint,{data});assert.ok(r.ok(),await r.text());return r.json();};
  const state=()=>context.request.get(base+'/api/state').then(r=>r.json());
  await post('/api/auth/register',{username:'order-ui-user',password:'order-ui-password-123'});
  const settings=await context.request.put(base+'/api/settings',{data:{aiKey:'ai-fixture-key',aiModel:'fixture',aiBaseUrl:sourceBase+'/v1',webhooks:[{id:'hook',name:'下单通知',format:'generic',enabled:true,url:sourceBase+'/hook'}]}});assert.ok(settings.ok());
  const monitor=(await post('/api/monitors',{kind:'webpage',label:'商品补货',url:sourceBase+'/product',keyword:'available',mode:'contains',intervalMinutes:60,webhookIds:['hook'],fetch:{mode:'http',proxy:'direct'}})).monitors[0];
  const accountPath='/api/monitors/'+monitor.id+'/order-account';
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/#monitors');
  const openMonitor=async()=>{await page.locator('[data-action="edit"][data-id="'+monitor.id+'"]').click();await page.locator('#order-addon').waitFor();};await openMonitor();
  assert.equal(await page.locator('a[href="#orders"]').count(),0);assert.equal(await page.locator('#order-monitor-choices').count(),0);
  await page.locator('#order-login-url').fill(sourceBase+'/login');await page.locator('[data-order-account-action="start"]').click();await page.locator('#order-login-image').waitFor({timeout:30000});
  await page.locator('[data-login-field]').nth(0).fill(username);await page.locator('[data-login-field]').nth(1).fill(password);
  const clickLogin=async()=>{const image=page.locator('#order-login-image');await image.scrollIntoViewIfNeeded();const box=await image.boundingBox();await image.click({position:{x:50*box.width/1280,y:140*box.width/1280}});};
  await clickLogin();await page.waitForFunction(()=>document.querySelectorAll('[data-login-field]').length===1,{timeout:20000});
  await page.locator('[data-order-account-action="finish"]').click();await page.waitForFunction(()=>document.querySelector('[data-order-account-action="finish"]')?.disabled===false);assert.ok(await page.locator('#order-login-image').isVisible(),'Incomplete login must remain open');
  await page.locator('[data-login-field]').fill('123456');await clickLogin();await page.waitForFunction(()=>document.querySelector('#order-login-address')?.textContent.endsWith('/product'),null,{timeout:20000});
  await page.locator('[data-order-account-action="finish"]').click();await page.waitForFunction(()=>!document.querySelector('#order-login-image'));
  let current=await state();assert.equal(current.orderAccounts[0].status,'saved');assert.equal(current.orderAccounts[0].session,undefined);assert.equal(JSON.stringify(current).includes(password),false);assert.equal(loginRequests,1);console.log('PASS private prelogin and 2FA');
  const fillForm=async(label,max=20,mode='submit',aff='')=>{await page.locator('#order-label').fill(label);await page.locator('#order-product').fill('Product A');await page.locator('#order-url').fill(sourceBase+'/product');await page.locator('#order-max-total').fill(String(max));await page.locator('#order-affiliate-url').fill(aff);await page.locator('[data-order-mode="'+mode+'"]').click();};
  const generate=async()=>{await page.locator('[data-order-editor-action="generate"]').click();await page.locator('[data-order-editor-action="enable"]').waitFor({timeout:90000});};
  const enable=async()=>{await page.locator('[data-order-editor-action="enable"]').click();await page.locator('[data-order-editor-action="run"]').waitFor();};
  const newConfig=async()=>{await page.locator('[data-order-editor-action="new"]').click();};
  const run=async()=>{await page.locator('[data-order-editor-action="run"]').click();await page.locator('[data-order-editor-action="new"]').waitFor({timeout:90000});};
  await fillForm('Product A 自动下单',20,'submit',sourceBase+'/aff?aff=partner-42');await generate();
  assert.equal(createdOrders,0);assert.equal(paymentRequests,0);assert.equal(loginRequests,1,'Generation reuses saved session');current=await state();let task=current.orderTasks[0];assert.equal(task.monitorId,monitor.id);assert.equal(task.trial.affiliate.status,'verified');assert.equal(task.trial.affiliate.name,'partner_credit');
  assert.equal(JSON.stringify(aiRequests).includes(password),false);assert.equal(JSON.stringify(aiRequests).includes(username),false);assert.equal(JSON.stringify(aiRequests).includes('logged-in'),false);
  const output=process.env.UI_SMOKE_SCREENSHOT_DIR?path.resolve(process.env.UI_SMOKE_SCREENSHOT_DIR):path.join(root,'release','orders-ui-smoke');await fs.mkdir(output,{recursive:true});
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(output,'desktop-monitor-orders.png'),fullPage:true});
  for(const width of[768,390,320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Integrated order page overflow at '+width);}
  await page.screenshot({path:path.join(output,'mobile-monitor-orders.png'),fullPage:true});assert.equal(await page.locator('#order-addon details,#order-addon dialog,#order-addon select:visible').count(),0);await page.setViewportSize({width:1440,height:1000});
  await enable();available=true;const triggeredAt=Date.now(),readsBefore=productReads,aiBeforeTrigger=aiRequests.length;await post('/api/monitors/'+monitor.id+'/check');
  for(let i=0;i<200;i++){current=await state();if(current.orderTasks.find(t=>t.id===task.id).result)break;await pause(50);}
  task=current.orderTasks.find(t=>t.id===task.id);assert.equal(task.status,'ordered',JSON.stringify(task.result));assert.equal(task.result.affiliate.status,'sent');assert.equal(affiliateOrders,1);assert.equal(createdOrders,1);assert.equal(loginRequests,1);
  await post('/api/monitors/'+monitor.id+'/check');await pause(100);assert.equal(createdOrders,1);assert.equal((await context.request.post(base+'/api/order-tasks/'+task.id+'/run',{data:{}})).status(),400);
  const triggerMs=orderRequestTimes[0]-triggeredAt;assert.equal(aiRequests.length,aiBeforeTrigger,'Normal trigger cannot wait for AI');assert.ok(productReads-readsBefore-2<=2,'Fast path must avoid duplicate product GETs');console.log('ORDER SPEED: '+triggerMs+' ms to actual merchant POST, '+(productReads-readsBefore-2)+' checkout page reads (excluding monitor checks)');console.log('PASS AFF attributed one-shot monitor trigger');if(!process.env.ORDER_SPEED_ONLY){await page.reload();await openMonitor();await newConfig();await fillForm('付款与页面自动修复',20,'pay');await generate();await enable();const beforeRepair=aiRequests.length;layoutChanged=true;await run();
  current=await state();task=current.orderTasks[0];assert.equal(task.status,'paid',JSON.stringify(task.result));assert.equal(task.repairs.length,1);assert.ok(aiRequests.length>beforeRepair);assert.equal(createdOrders,2);assert.equal(paymentRequests,1);assert.equal(paidOrders,1);console.log('PASS AI repair and payment');assert.equal(task.result.invoiceId,'2');assert.equal(task.result.payment.total,9.5);
  assert.equal((await context.request.post(base+'/api/order-tasks/'+task.id+'/run',{data:{}})).status(),400);assert.equal(paymentRequests,1);
  await newConfig();await fillForm('预算保护');await generate();await enable();total=50;const beforeBudget=aiRequests.length;await run();assert.match((await state()).orderTasks[0].error,/总价超过/);assert.equal(aiRequests.length,beforeBudget);assert.equal(createdOrders,2);total=9.5;
  await newConfig();await fillForm('付款金额保护',20,'pay');await generate();await enable();invoiceExtra=1;const beforeInvoice=aiRequests.length;await run();current=await state();assert.equal(current.orderTasks[0].status,'payment_failed');assert.match(current.orderTasks[0].error,/付款金额/);assert.equal(aiRequests.length,beforeInvoice);assert.equal(createdOrders,3);assert.equal(paymentRequests,1);invoiceExtra=0;
  await newConfig();await fillForm('AFF 错误保护',20,'submit',sourceBase+'/aff?aff=partner-42');await generate();await enable();affWorking=false;await run();current=await state();assert.match(current.orderTasks[0].error,/AFF/);assert.equal(createdOrders,3);assert.equal(affiliateOrders,1);affWorking=true;
  await newConfig();await fillForm('真实请求归因变化保护',20,'submit',sourceBase+'/aff?aff=partner-42');await generate();await enable();overwriteAffOnSubmit=true;const beforeLost=createdOrders;await run();current=await state();assert.match(current.orderTasks[0].error,/AFF.*请求/);assert.equal(createdOrders,beforeLost,'Missing attribution must be blocked before merchant POST');assert.equal(affiliateOrders,1);overwriteAffOnSubmit=false;
  await newConfig();await fillForm('登录过期保护');await generate();await enable();expired=true;await run();current=await state();assert.match(current.orderTasks[0].error,/登录/);assert.equal(current.orderAccounts[0].status,'expired');assert.equal(createdOrders,3);assert.equal(loginRequests,1);expired=false;
  await page.locator('[data-order-account-action="check"]').click();await page.waitForFunction(()=>document.querySelector('#order-account-status')?.textContent.includes('已保存'));
  await newConfig();await fillForm('跨页面修复');await page.locator('#order-url').fill(sourceBase+'/config');const beforeCart=aiRequests.length;await generate();assert.equal(aiRequests.length-beforeCart,2);assert.equal(createdOrders,3);await enable();await run();assert.equal(createdOrders,4);
  await newConfig();await fillForm('可停止生成');await page.locator('#order-instruction').fill('hold-to-cancel');const pending=aiRequests.length;await page.locator('[data-order-editor-action="generate"]').click();for(let i=0;i<150&&aiRequests.length===pending;i++)await pause(50);assert.ok(aiRequests.length>pending);await page.locator('#order-cancel').click();await page.waitForFunction(()=>document.querySelector('[data-order-editor-action="generate"]')?.disabled===false,{timeout:20000});assert.equal((await state()).orderTasks[0].enabled,false);assert.equal(createdOrders,4);
  const other=await browser.newContext();await other.request.post(base+'/api/auth/register',{data:{username:'order-ui-other',password:'order-ui-password-123'}});assert.equal((await other.request.get(base+accountPath)).status(),404);assert.equal((await other.request.post(base+'/api/order-tasks/'+task.id+'/run',{data:{}})).status(),404);await other.close();
  // Saved credentials survive an app restart; interrupted operations never resume.
  child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));child=spawn(process.execPath,['server.js'],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,DATA_DIR:dataDir,HOST:'127.0.0.1',PORT:String(port),MONITOR_BROWSER_EXECUTABLE:executable}});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/auth/status')).ok)break;}catch{}await pause(50);}
  await post(accountPath+'/check');assert.equal((await state()).orderAccounts[0].status,'saved');assert.equal(createdOrders,4);assert.equal(loginRequests,1);assert.ok(affiliateVisits>=4);
  }
  assert.deepEqual(errors,[]);console.log('PASS integrated monitor ordering, private interactive prelogin with 2FA and restart, real AFF Cookie on order request, AI-generated DOM repair before submission, actual scoped payment, budget/invoice/AFF/login protections, cancellation, tenant isolation, mobile layout');
}catch(error){if(page)console.error('Order smoke UI state:',await page.locator('#order-status,#order-account-status,#toast').allTextContents());throw error;}finally{
  await browser?.close();if(child){child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));}
  mock.closeAllConnections?.();await new Promise(r=>mock.close(r));const resolved=path.resolve(dataDir);assert.ok(resolved.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(resolved).startsWith('radar-orders-ui-'));await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
