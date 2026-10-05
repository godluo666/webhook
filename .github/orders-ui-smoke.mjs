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
let available=false,total=9.5,createdOrders=0,paymentRequests=0,paidOrders=0,invoiceExtra=0,invoiceCurrency="USD";
const aiRequests=[],messages=[],errors=[];
const password='private-site-password-'+nonce, username='buyer@example.test';
let sourceBase;
const checkout={submitSelector:'#'+id('submit'),productSelector:'#'+id('product'),quantitySelector:'#'+id('quantity'),totalSelector:'#'+id('total'),currencySelector:'#'+id('currency'),confirmationSelector:'#'+id('confirmation')};
const code='function(order,browser){browser.goto(order.url);if(browser.exists("#'+id('login')+'"))browser.login("#'+id('username')+'","#'+id('password')+'","#'+id('login')+'");browser.fill("'+checkout.quantitySelector+'",String(order.quantity));browser.select("#'+id('billing')+'","monthly");browser.check("#'+id('terms')+'");return browser.submit();}';
const paidCode=code.replace('return browser.submit();', 'const result=browser.submit();if(result.status==="prepared")return result;const elements=browser.snapshot().elements;function locate(name){const field=elements.find(el=>el.id&&el.id.startsWith(name+"-"));if(!field)throw new Error("Missing payment field: "+name);return "#"+field.id;}return browser.pay({paySelector:locate("pay"),invoiceSelector:locate("invoice"),totalSelector:locate("invoice-total"),currencySelector:locate("invoice-currency"),confirmationSelector:"#"+"paid-"+elements.find(el=>el.id&&el.id.startsWith("invoice-")).id.split("-").at(-1)});');
const mock=http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://localhost');let raw='';for await(const part of req)raw+=part;
  if(url.pathname==='/v1/chat/completions'){
    aiRequests.push(JSON.parse(raw));assert.ok(raw.includes(id('product')),'Generation must observe the real DOM, including random selectors');
    const evidence=JSON.parse(JSON.parse(raw).messages.at(-1).content);
    const configPage=evidence.order.url.endsWith('/config');
    if(configPage && evidence.feedback) assert.ok(evidence.feedback.page?.elements.some(el=>el.id===id('total')),'Repair must receive the real next-page DOM');
    const generatedCheckout=configPage&&!evidence.feedback?{...checkout,totalSelector:'#unknown-next-page-total-'+nonce}:checkout;
    if(evidence.order.instruction==='hold-to-cancel')await pause(5000);
    const selectedCode=evidence.order.executionMode==='pay'?paidCode:code;
    const generatedCode=configPage?selectedCode.replace('browser.fill(', 'if(browser.exists("#'+id('cart')+'"))browser.cart("#'+id('cart')+'");browser.fill('):selectedCode;
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({summary:'登录网站，选择月付商品，核对数量、币种与总价，只提交一次。',code:generatedCode,checkout:generatedCheckout})}}]}));return;
  }
  if(url.pathname==='/hook'){messages.push(JSON.parse(raw));res.end('ok');return;}
  if(url.pathname==='/pay'){paymentRequests++;assert.equal(req.method,'POST');assert.match(req.headers.cookie||'',/shop_session=logged-in/);assert.equal(new URLSearchParams(raw).get('invoiceid'),String(createdOrders));paidOrders++;res.setHeader('content-type','text/html; charset=utf-8');res.end('<h1 id="'+id('paid')+'">Invoice #'+createdOrders+' Paid</h1>');return;}
  if(url.pathname==='/login'&&req.method==='POST'){
    const values=new URLSearchParams(raw);assert.equal(values.get('username'),username);assert.equal(values.get('password'),password);
    res.writeHead(302,{'set-cookie':'shop_session=logged-in; HttpOnly; Path=/','location':url.searchParams.get('next')==='config'?'/config':'/product'});res.end();return;
  }
  if(url.pathname==='/create-order'&&req.method==='POST'){
    assert.match(req.headers.cookie||'',/shop_session=logged-in/);const values=new URLSearchParams(raw);assert.equal(values.get('quantity'),'1');assert.equal(values.get('billing'),'monthly');
    createdOrders++;res.setHeader('content-type','text/html; charset=utf-8');res.end('<h1 id="'+id('confirmation')+'">Order #'+createdOrders+' created, unpaid</h1><form method="post" action="/pay"><input type="hidden" id="'+id('invoice')+'" name="invoiceid" value="'+createdOrders+'"><p id="'+id('invoice-total')+'">'+invoiceCurrency+' '+(total+invoiceExtra).toFixed(2)+'</p><p id="'+id('invoice-currency')+'">'+invoiceCurrency+'</p><button id="'+id('pay')+'">Pay now with account balance</button></form>');return;
  }
  if(url.pathname==='/config'){
    const logged=(req.headers.cookie||'').includes('shop_session=logged-in');
    res.setHeader('content-type','text/html; charset=utf-8');res.end('<h1 id="'+id('product')+'">Product A</h1>'+(logged?'':'<form action="/login?next=config" method="post"><input id="'+id('username')+'" name="username"><input id="'+id('password')+'" name="password" type="password"><button id="'+id('login')+'">Log in</button></form>')+'<form action="/configure-cart" method="post"><select name="cycle"><option value="monthly">Monthly</option></select><button id="'+id('cart')+'">Continue</button></form>');return;
  }
  if(url.pathname==='/configure-cart'&&req.method==='POST'){
    assert.match(req.headers.cookie||'',/shop_session=logged-in/);
    res.setHeader('content-type','text/html; charset=utf-8');res.end('<form action="/create-order" method="post"><h2 id="'+id('product')+'">Product A</h2><input id="'+id('quantity')+'" name="quantity" value="1"><select id="'+id('billing')+'" name="billing"><option value="monthly">Monthly</option></select><p id="'+id('total')+'">USD '+total.toFixed(2)+'</p><p id="'+id('currency')+'">USD</p><input id="'+id('terms')+'" type="checkbox" name="terms"><button id="'+id('submit')+'">Submit Order</button></form>');return;
  }
  if(url.pathname==='/product'){
    const logged=(req.headers.cookie||'').includes('shop_session=logged-in');
    res.setHeader('content-type','text/html; charset=utf-8');
    res.end('<html><head><title>Fixture cloud product</title></head><body><h1>Product A</h1><p>'+(available?'available':'sold out')+'</p>'+(logged?'':'<form action="/login" method="post"><input id="'+id('username')+'" name="username"><input id="'+id('password')+'" name="password" type="password"><button id="'+id('login')+'">Log in</button></form>')+'<form action="/create-order" method="post"><h2 id="'+id('product')+'">Product A</h2><label>Quantity<input id="'+id('quantity')+'" name="quantity" value="1"></label><label>Billing<select id="'+id('billing')+'" name="billing"><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label><p id="'+id('total')+'">USD '+total.toFixed(2)+'</p><p id="'+id('currency')+'">USD</p><input id="'+id('terms')+'" type="checkbox" name="terms" value="accepted"><button id="'+id('submit')+'">Submit Order</button></form></body></html>');return;
  }
  res.writeHead(404);res.end();
 }catch(error){errors.push(error.message);res.writeHead(500);res.end(error.message);}
});
let browser,child;
try{
  sourceBase='http://127.0.0.1:'+await listen(mock);const reserve=http.createServer(),port=await listen(reserve);await new Promise(r=>reserve.close(r));const base='http://127.0.0.1:'+port;
  const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':'/usr/bin/chromium');
  child=spawn(process.execPath,['server.js'],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,DATA_DIR:dataDir,HOST:'127.0.0.1',PORT:String(port),MONITOR_BROWSER_EXECUTABLE:executable,RESEND_API_KEY:'',MAIL_FROM:'',SIGNUP_CODE:''}});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/auth/status')).ok)break;}catch{}await pause(50);}
  browser=await chromium.launch({executablePath:executable,headless:true,args:['--no-sandbox']});const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const post=async(endpoint,data)=>{const r=await context.request.post(base+endpoint,{data});assert.ok(r.ok(),await r.text());return r.json();};
  await post('/api/auth/register',{username:'order-ui-user',password:'order-ui-password-123'});
  const settings=await context.request.put(base+'/api/settings',{data:{aiKey:'ai-fixture-key',aiModel:'fixture',aiBaseUrl:sourceBase+'/v1',webhooks:[{id:'hook',name:'下单通知',format:'generic',enabled:true,url:sourceBase+'/hook'}]}});assert.ok(settings.ok());
  const monitor=(await post('/api/monitors',{kind:'webpage',label:'商品补货',url:sourceBase+'/product',keyword:'available',mode:'contains',intervalMinutes:60,webhookIds:['hook'],fetch:{mode:'http',proxy:'direct'}})).monitors[0];
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/#orders');await page.locator('#orders').waitFor();
  await page.locator('#order-new').click();
  const fillForm=async(label,max=20)=>{await page.locator('#order-label').fill(label);await page.locator('#order-product').fill('Product A');await page.locator('#order-url').fill(sourceBase+'/product');await page.locator('#order-max-total').fill(String(max));await page.locator('#order-username').fill(username);await page.locator('#order-password').fill(password);await page.locator('[data-order-monitor="'+monitor.id+'"]').click();await page.locator('[data-order-mode="submit"]').click();};
  await fillForm('Product A 自动下单');
  await page.locator('[data-order-editor-action="generate"]').click();await page.locator('[data-order-editor-action="enable"]').waitFor({timeout:60000});
  assert.equal(createdOrders,0,'Trial must never create an order');assert.equal(paymentRequests,0);assert.equal(await page.locator('#order-code').inputValue(),code);
  const state=()=>context.request.get(base+'/api/state').then(r=>r.json());let current=await state(),task=current.orderTasks[0];
  assert.equal(task.trial.passed,true);assert.equal(task.enabled,false);assert.equal(task.hasCredentials,true);assert.equal(JSON.stringify(current).includes(password),false);assert.equal(JSON.stringify(aiRequests).includes(password),false);assert.equal(JSON.stringify(aiRequests).includes(username),false);
  const output=process.env.UI_SMOKE_SCREENSHOT_DIR?path.resolve(process.env.UI_SMOKE_SCREENSHOT_DIR):path.join(root,'release','orders-ui-smoke');await fs.mkdir(output,{recursive:true});
  assert.ok(await page.locator('a[href="#orders"] svg').evaluate(el=>el.getBoundingClientRect().width<=24),'Order nav icon must match existing navigation');
  await page.screenshot({path:path.join(output,'desktop-order-page.png'),fullPage:true});
  for(const width of[768,390,320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Order page overflow at '+width);}
  await page.screenshot({path:path.join(output,'mobile-order-page.png'),fullPage:true});
  const toastBox=await page.locator('#toast').boundingBox(),footerBox=await page.locator('#order-form .task-editor-footer').boundingBox();
  assert.ok(toastBox.y+toastBox.height<=footerBox.y||toastBox.y>=footerBox.y+footerBox.height,'Status toast must not cover footer actions');
  assert.equal(await page.locator('#orders details, #orders dialog, #orders select:visible').count(),0);
  await page.locator('[data-order-editor-action="enable"]').click();await page.locator('[data-order-editor-action="run"]').waitFor();available=true;
  await post('/api/monitors/'+monitor.id+'/check',{});
  for(let i=0;i<200;i++){current=await state();if(current.orderTasks.find(t=>t.id===task.id).result)break;await pause(50);}
  task=current.orderTasks.find(t=>t.id===task.id);assert.equal(task.status,'ordered',JSON.stringify(task.result));assert.equal(task.enabled,false);assert.equal(createdOrders,1);assert.equal(paymentRequests,0);
  await post('/api/monitors/'+monitor.id+'/check',{});await pause(200);assert.equal(createdOrders,1,'Repeated checks cannot create duplicate orders');
  const again=await context.request.post(base+'/api/order-tasks/'+task.id+'/run',{data:{}});assert.equal(again.status(),400);
  const other=await browser.newContext();await other.request.post(base+'/api/auth/register',{data:{username:'order-ui-other',password:'order-ui-password-123'}});const leaked=await other.request.post(base+'/api/order-tasks/'+task.id+'/run',{data:{}});assert.equal(leaked.status(),404);await other.close();
  await page.reload();await page.locator('#order-new').click();await fillForm('价格上限保护',20);await page.locator('[data-order-editor-action="generate"]').click();await page.locator('[data-order-editor-action="enable"]').waitFor({timeout:60000});
  await page.locator('[data-order-editor-action="enable"]').click();await page.locator('[data-order-editor-action="run"]').waitFor();total=50;await page.locator('[data-order-editor-action="run"]').click();await page.locator('.order-error').waitFor({timeout:60000});assert.match(await page.locator('.order-error').innerText(),/总价超过/);assert.equal(createdOrders,1);
  total=9.5;await page.reload();await page.locator('#order-new').click();await fillForm('跨页面自适应',20);await page.locator('#order-url').fill(sourceBase+'/config');
  const oldRequests=aiRequests.length;await page.locator('[data-order-editor-action="generate"]').click();await page.locator('[data-order-editor-action="enable"]').waitFor({timeout:90000});
  assert.equal(aiRequests.length-oldRequests,2,'AI must revise code with next-page observations');assert.equal(createdOrders,1,'Cart trial cannot submit an order');
  await page.locator('[data-order-editor-action="enable"]').click();await page.locator('[data-order-editor-action="run"]').waitFor();await page.locator('[data-order-editor-action="run"]').click();await page.locator('[data-order-editor-action="new"]').waitFor({timeout:60000});assert.equal(createdOrders,2);assert.equal(paymentRequests,0);
  const createPayment=async label=>{await page.reload();await page.locator('#order-new').click();await fillForm(label,20);await page.locator('[data-order-mode="pay"]').click();await page.locator('[data-order-monitor=""]').click();await page.locator('[data-order-editor-action="generate"]').click();await page.locator('[data-order-editor-action="enable"]').waitFor({timeout:60000});assert.equal(paymentRequests,paidOrders,'Trial cannot pay');await page.locator('[data-order-editor-action="enable"]').click();await page.locator('[data-order-editor-action="run"]').waitFor();};
  await createPayment('自动提交并付款');assert.equal(createdOrders,2);await page.locator('[data-order-editor-action="run"]').click();await page.locator('[data-order-editor-action="new"]').waitFor({timeout:60000});
  current=await state();const paid=current.orderTasks[0];assert.equal(paid.status,'paid',JSON.stringify(paid.result));assert.equal(paid.result.payment.total,9.5);assert.equal(paid.result.invoiceId,'3');assert.equal(createdOrders,3);assert.equal(paymentRequests,1);assert.equal(paidOrders,1);
  const retryPayment=await context.request.post(base+'/api/order-tasks/'+paid.id+'/run',{data:{}});assert.equal(retryPayment.status(),400);assert.equal(paymentRequests,1);
  await createPayment('付款金额变化保护');invoiceExtra=1;await page.locator('[data-order-editor-action="run"]').click();await page.locator('.order-error').waitFor({timeout:60000});assert.match(await page.locator('.order-error').innerText(),/付款金额/);assert.equal(createdOrders,4);assert.equal(paymentRequests,1);current=await state();assert.equal(current.orderTasks[0].status,'payment_failed');assert.equal(current.orderTasks[0].result.invoiceId,'4');invoiceExtra=0;
  await createPayment('付款币种保护');invoiceCurrency='EUR';await page.locator('[data-order-editor-action="run"]').click();await page.locator('.order-error').waitFor({timeout:60000});assert.match(await page.locator('.order-error').innerText(),/币种/);assert.equal(createdOrders,5);assert.equal(paymentRequests,1);invoiceCurrency='USD';
  await page.reload();await page.locator('#order-new').click();await fillForm('可停止生成');await page.locator('#order-instruction').fill('hold-to-cancel');const pending=aiRequests.length;await page.locator('[data-order-editor-action="generate"]').click();
  for(let i=0;i<150&&aiRequests.length===pending;i++)await pause(50);assert.ok(aiRequests.length>pending);await page.locator('#order-cancel').click();await page.waitForFunction(()=>document.querySelector('[data-order-editor-action="generate"]')?.disabled===false,{timeout:20000});current=await state();assert.equal(current.orderTasks[0].status,'draft');assert.equal(current.orderTasks[0].enabled,false);assert.equal(createdOrders,5);assert.equal(paymentRequests,1);
  await page.reload();await page.locator('#order-new').click();await fillForm('后台生成不覆盖新草稿');await page.locator('#order-instruction').fill('hold-to-cancel');const pendingDraft=aiRequests.length;await page.locator('[data-order-editor-action="generate"]').click();
  for(let i=0;i<150&&aiRequests.length===pendingDraft;i++)await pause(50);assert.ok(aiRequests.length>pendingDraft);await page.locator('#order-back').click();await page.locator('#order-new').click();await page.locator('#order-label').fill('保留这个新草稿');
  for(let i=0;i<200;i++){current=await state();if(current.orderTasks.find(t=>t.label==='后台生成不覆盖新草稿')?.status==='ready')break;await pause(50);}
  assert.equal(current.orderTasks.find(t=>t.label==='后台生成不覆盖新草稿')?.status,'ready');assert.equal(await page.locator('#order-label').inputValue(),'保留这个新草稿');assert.equal(await page.locator('#order-heading').innerText(),'新建下单任务');assert.equal(createdOrders,5);assert.equal(paymentRequests,1);
  await page.locator('#order-back').click();const deleted=current.orderTasks.find(t=>t.label==='可停止生成');await page.locator('[data-order-command="delete"][data-id="'+deleted.id+'"]').click();await page.waitForFunction(id=>!document.querySelector('[data-order-open="'+id+'"]'),deleted.id);assert.ok(!(await state()).orderTasks.some(t=>t.id===deleted.id));
  assert.deepEqual(errors,[]);
  console.log('PASS AI-generated random selectors, isolated code, real login and trial, approval, stock-triggered single order, scoped single payment, checkout/invoice price and currency caps, cancellation and draft preservation, adaptive cart/checkout pages, account isolation, desktop/tablet/mobile');
}finally{
  await browser?.close();if(child){child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));}
  mock.closeAllConnections?.();await new Promise(r=>mock.close(r));const resolved=path.resolve(dataDir);assert.ok(resolved.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(resolved).startsWith('radar-orders-ui-'));await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
