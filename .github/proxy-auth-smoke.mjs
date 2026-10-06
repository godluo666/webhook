import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,X509Certificate} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
const root=process.cwd();
const {createOrderBrowser}=await import(pathToFileURL(path.join(root,'lib/order-browser.js')));
const {createBrowserSource}=await import(pathToFileURL(path.join(root,'lib/browser-source.js')));
const {createShadowsocksBridge}=await import(pathToFileURL(path.join(root,'lib/shadowsocks.js')));
const {runOrderWorkflow}=await import(pathToFileURL(path.join(root,'lib/order-workflow.js')));
const {validateOrderProgram}=await import(pathToFileURL(path.join(root,'lib/orders.js')));
// Public, self-signed local-test fixtures. Only this SPKI is trusted by the test
// browser launch wrapper; production certificate verification is unchanged.
const key="-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCMZwGphjjAcpKT\nCeqol3I6qfUcTRA+M6mj+uLiwlPBxFRAby2VxdKSe78KI0UJ4WiIcgjbF/43QIqG\nBrDkMLkgBviF7AP5iL93EMYi2mDVNPaRyuEaWEzKhPn9Ap9UsXJK+LKiQJt/ZqNt\nvXGO0lL0mDtUkl+reeegVGQLrUGQ7URy2JLRor5BFJbxTwiP7ArBe17D75QnpvQo\nw817oTeO7UgF/yzEJunrW3eVqXIYd0VoDEpZiuShMBj7MpyGOUmdvr5SHKZ/xA8m\nQv05lGq18HYRWjYNMFtZiMRGSSRs1kG21AFMN07TzxZtFZ1ZDLcmVhIC2QPvixZ2\nS73GhUkvAgMBAAECggEABt4Y++5OcQ5Ae990qSm8ZUoNo7s/QqXrRhzgbKAQCJoc\nDcA5SGE/1Xkmy/umGBHYJVYk5S12ens/faKluIlnAVBBZ1VJa6DBzn3Hn9xg0uGI\nik5dg6sp4mruAW9FVOBp+Pr3XeTK+u1ErDFIPg0/NM95ulGkAemU8RER9tkcLCAt\nh/mkGeUCZeDkaxzxBaUzPQ9RKWLwfMLTiV8GVnQK+CJl8/Ok+eukMdHMd5tfkeqr\ndV9hiFKbq5h/VSkO66x1zXUzDiMuw/E9fHey90RoDv94lVRJB63W4coEWlxG9yEH\nxSA5YTIJXLTgNDz5DpwatVO6jSkdapSJzTv6lKWk3QKBgQDETGvuhnRCMKQj9C+V\nbHVaVyYZdcsWpwHN2ulXqsqeBD/nJUC+j3fqvQ7Iuj7wKiMiCZzfZohLPOn8nUI0\nxLL1GbV3lFhz8Diw5B9Sqvjd/HKucRSD3d8T8/G3ADgpEsC/nbmsbXdmzeeL6Vei\nV8s1sir7tkRJ8tpBdvyL6sudTQKBgQC3GpMJWkWXhxHX+08GDLbsG0A+jtlTBjUV\nW7LFSHoT45C97+6hmfVcVAuBpyZIQsoDuthZUX7CCP+hID1Nn5x4WzSJQRHyu1o4\nd+dq9Sa6ycNb8jrLiwAkjnr1Zl7RiqxHauhbOa/5vPOCjcdhWt4ohNo9SPOB6/g2\ndfUrFreyawKBgAIfpYdGExnoNs5gxOcD7l0U1keuO406L03P0XhuU5TUDPDuOT4W\nhUCX3QIU6btlaU3j9rt/+3d86DcgaGfzvM/kAE+T3kUa0zIutZwKV3jnU0JJ3OP0\nUYaAvBuzt+fR2R35kdmosYL+NUQROS57bqpdDBP/C8wVAYF1zROibaN9AoGAD0ej\nb4td9VgrMAfjv1B+T1Oy18WZ8yi4c1DUqUv0DAbYhFEqa8fqRssorqghNLSGISuN\ndF6tokmX8306QGkKaKzLxIxuj//8dmvjHvTYR4wgxmJ/b47o8yQEtMfXL8tPtyH/\nw+Ubf066T3G/aqtnkKANikG1OGlVrE3JqM/bgoMCgYBGGzbagTbeY1ZYXMDYnm8b\nj46CpW0BZ3rDRBeyIwz42EqH8GN+VpVCyeUESufvmJ0ZRivZwc0hJn0Y6zWhf4Ae\niWokL8S2YLQYdxYTwVztWnJonpYtluty00liSZvMHqbAEUlnznW1aTOv1QKf10RU\nsWTmrYj1kbogeeSgGeYLvQ==\n-----END PRIVATE KEY-----\n";
const cert="-----BEGIN CERTIFICATE-----\nMIIDJTCCAg2gAwIBAgIUJf9TGTWi+5p5nb53GDk9skeW8fQwDQYJKoZIhvcNAQEL\nBQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAwNjAzNDkwOVoXDTM2MTAw\nMzAzNDkwOVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF\nAAOCAQ8AMIIBCgKCAQEAjGcBqYY4wHKSkwnqqJdyOqn1HE0QPjOpo/ri4sJTwcRU\nQG8tlcXSknu/CiNFCeFoiHII2xf+N0CKhgaw5DC5IAb4hewD+Yi/dxDGItpg1TT2\nkcrhGlhMyoT5/QKfVLFySviyokCbf2ajbb1xjtJS9Jg7VJJfq3nnoFRkC61BkO1E\nctiS0aK+QRSW8U8Ij+wKwXtew++UJ6b0KMPNe6E3ju1IBf8sxCbp61t3lalyGHdF\naAxKWYrkoTAY+zKchjlJnb6+Uhymf8QPJkL9OZRqtfB2EVo2DTBbWYjERkkkbNZB\nttQBTDdO088WbRWdWQy3JlYSAtkD74sWdku9xoVJLwIDAQABo28wbTAdBgNVHQ4E\nFgQUiqg0wOBhXHIiXQcKzq8W9pAq1CgwHwYDVR0jBBgwFoAUiqg0wOBhXHIiXQcK\nzq8W9pAq1CgwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH\nBH8AAAEwDQYJKoZIhvcNAQELBQADggEBAD1S5R1qpJ40zoNmep/nxvqq2J8zOQOc\nnGY+c0GRb1l0MBPShEQxqqdraQiiNTPv3Q5I0VeE8ZzjStiTuVIOi/6/bBV77yu5\nnszwarCLJEYPYna1VbCXm7eziVe7YqpI/W7/gCuPV6QKl6e3g03zVob5cQh0/e9+\nm92zm4djfmgbnYVawDeiYWJ+i4H0W2nrzMkoCHerr+feiPJ8GC4Oq8GWVurIVpXX\nJZQLEuNuWPgb1/Li0bM0wSTL1AORwYQtfuMHKK40QqQf+HoPoppmGWTughME8bPR\nteUjN9VYc+Huc0pW8aSZXlclJqwyV8TzNfLLJx0RM7AxYHh2BrXgM0k=\n-----END CERTIFICATE-----\n";
const pin=createHash('sha256').update(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'})).digest('base64');
const executable=process.env.MONITOR_BROWSER_EXECUTABLE||undefined;
const launch=options=>chromium.launch({...options,executablePath:executable,args:[...options.args,'--ignore-certificate-errors-spki-list='+pin]});
const launchContext=(profile,options)=>chromium.launchPersistentContext(profile,{...options,executablePath:executable,args:[...options.args,'--ignore-certificate-errors-spki-list='+pin]});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const dataDir=await fs.mkdtemp(path.join(process.env.DATA_DIR||tmpdir(),'proxy-auth-smoke-'));
const sockets=new Set(),originHeaders=[],invoices=new Map(),ledger=[];
let orders=0,payments=0,originChallenges=0,proxyChallenges=0,acceptedConnects=0,ssServer,replayPayment=false,unauthorizedWrites=0,replayedPayments=0;
const target=https.createServer({key,cert},async(req,res)=>{
  originHeaders.push({authorization:req.headers.authorization,proxyAuthorization:req.headers['proxy-authorization']});
  const url=new URL(req.url,'https://local.invalid');
  if(url.pathname==='/health'){res.end('<h1>HTTPS-READY</h1>');return;}
  if(url.pathname==='/site-auth'){originChallenges++;res.writeHead(401,{'www-authenticate':'Basic realm="website-only"'});res.end('HTTP authentication required');return;}
  if(url.pathname==='/login'){res.writeHead(302,{'set-cookie':'merchant_session=private-login; Secure; HttpOnly; Path=/','location':'/clientarea.php?background=1&returnto=/pay?invoice=fixture'});res.end();return;}
  if(!req.headers.cookie?.includes('merchant_session=private-login')){res.writeHead(401);res.end('<form action="/login"><input type="password"><button>Log in</button></form>');return;}
  const logged='<a href="/logout">Log out</a>';
  if(url.pathname==='/clientarea.php'){res.end('<h1>Account</h1>'+logged+(url.searchParams.has('background')?'<script>fetch("/pay",{method:"POST",body:"invoiceid=unauthorized"}).catch(()=>{})</script>':''));return;}
  if(url.pathname==='/product'){
    res.end(logged+'<form method="post" action="/create-order"><h1 id="product">Product A</h1><input id="quantity" name="quantity" value="1"><p id="total">USD 10.00</p><span id="currency">USD</span><button id="submit" onclick="event.preventDefault();const f=this.form;setTimeout(()=>f.requestSubmit(),120)">Submit Order</button></form>');return;
  }
  let body='';for await(const part of req)body+=part;
  if(url.pathname==='/create-order'){
    assert.equal(req.method,'POST');assert.equal(new URLSearchParams(body).get('quantity'),'1');assert.equal(ledger.at(-1),'submit');orders++;invoices.set(String(orders),false);res.writeHead(303,{location:'/invoice?id='+orders});res.end();return;
  }
  if(url.pathname==='/pay'){
    assert.equal(req.method,'POST');const id=new URLSearchParams(body).get('invoiceid');if(id==='unauthorized'){unauthorizedWrites++;res.writeHead(400);res.end();return;}assert.ok(invoices.has(id));assert.equal(invoices.get(id),false);assert.equal(ledger.at(-1),'payment');payments++;if(replayPayment){res.writeHead(307,{location:'/pay-replay'});res.end();return;}invoices.set(id,true);res.writeHead(303,{location:'/invoice?id='+id});res.end();return;
  }
  if(url.pathname==='/pay-replay'){replayedPayments++;res.end('Unexpected payment replay');return;}
  if(url.pathname==='/invoice'){
    const id=url.searchParams.get('id');assert.ok(invoices.has(id));
    if(invoices.get(id)){res.end(logged+'<h1 id="paid">Invoice #'+id+' Paid</h1>');return;}
    res.end(logged+'<h1 id="confirmation">Order #'+id+' created, unpaid</h1><form action="/pay" method="post"><input id="invoice-id" type="hidden" name="invoiceid" value="'+id+'"><p id="invoice-total">USD 10.00</p><span id="invoice-currency">USD</span><p id="balance">Account balance: USD 50.00</p><span id="balance-currency">USD</span><button id="pay" onclick="event.preventDefault();const f=this.form;setTimeout(()=>f.requestSubmit(),120)">Pay now with account balance</button></form>');return;
  }
  res.writeHead(404);res.end();
});
const targetPort=await listen(target),base='https://127.0.0.1:'+targetPort;
const proxyToken='Basic '+Buffer.from('proxy-user:proxy-secret').toString('base64');
const proxy=http.createServer((_req,res)=>{res.writeHead(403);res.end();});
proxy.on('connect',(req,socket,head)=>{
  if(req.headers['proxy-authorization']!==proxyToken){proxyChallenges++;socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="proxy-only"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');return;}
  if(req.url!=='127.0.0.1:'+targetPort){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  acceptedConnects++;const upstream=net.connect(targetPort,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
  sockets.add(upstream);upstream.on('error',()=>socket.destroy());upstream.once('close',()=>sockets.delete(upstream));socket.once('close',()=>upstream.destroy());
});
proxy.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));});
const proxyPort=await listen(proxy),proxyUrl='http://proxy-user:proxy-secret@127.0.0.1:'+proxyPort;
const checkout={submitSelector:'#submit',productSelector:'#product',quantitySelector:'#quantity',totalSelector:'#total',currencySelector:'#currency',confirmationSelector:'#confirmation'};
const program=validateOrderProgram({summary:'HTTPS 代理认证回归 SOP',checkout,workflow:{version:1,prepareCode:'function(o,b){b.goto(o.url);b.fill("#quantity",String(o.quantity));return {ready:true};}',paymentCode:'function(){return {checks:{paySelector:"#pay",invoiceSelector:"#invoice-id",totalSelector:"#invoice-total",currencySelector:"#invoice-currency",balanceSelector:"#balance",balanceCurrencySelector:"#balance-currency",confirmationSelector:"#paid"}};}'}},{requireWorkflow:true});
const order={url:base+'/product',product:'Product A',quantity:1,maxTotal:10,currency:'USD',executionMode:'pay',program};
async function exercise(label,withProxy){
  let saved;
  await withProxy(async route=>{const browser=await createOrderBrowser({url:base+'/login'},{proxyUrl:route,loginOnly:true,launch});try{saved=await browser.remote.finish();}finally{await browser.close();}});
  assert.ok(saved.state.cookies.some(cookie=>cookie.name==='merchant_session'));
  const beforeOrders=orders,beforePayments=payments;
  for(let trial=0;trial<2;trial++)await withProxy(async route=>{
    const browser=await createOrderBrowser({...order,dryRun:true},{proxyUrl:route,launch,storageState:saved.state,sessionStorageState:saved.sessionStorage,loginCheck:saved.check});
    try{const result=await runOrderWorkflow(program,order,browser.methods);assert.equal(result.status,'prepared');Object.assign(saved,await browser.accountState());}finally{await browser.close();}
  });
  assert.equal(orders,beforeOrders);assert.equal(payments,beforePayments);
  await withProxy(async route=>{
    const url=base+'/clientarea.php?background=1';const browser=await createOrderBrowser({url,executionMode:'pay',dryRun:true},{proxyUrl:route,launch,storageState:saved.state,loginCheck:{...saved.check,url},accountReadOnly:true});
    try{assert.equal((await browser.verifyLogin()).url,url);assert.ok(browser.trace.some(item=>item.action==='拦截后台请求'));}finally{await browser.close();}
  });
  assert.equal(unauthorizedWrites,0,'Proxy auth interception must retain the read-only financial request guard');
  await withProxy(async route=>{
    const browser=await createOrderBrowser(order,{proxyUrl:route,launch,storageState:saved.state,sessionStorageState:saved.sessionStorage,loginCheck:saved.check,onBeforeSubmit:async()=>ledger.push('submit'),onBeforePayment:async()=>ledger.push('payment')});
    try{const result=await runOrderWorkflow(program,order,browser.methods);assert.equal(result.status,'paid');assert.equal(result.payment.invoiceId,String(beforeOrders+1));}finally{await browser.close();}
  });
  assert.equal(orders,beforeOrders+1);assert.equal(payments,beforePayments+1);
  replayPayment=true;
  try{await withProxy(async route=>{
    const browser=await createOrderBrowser(order,{proxyUrl:route,launch,storageState:saved.state,loginCheck:saved.check,onBeforeSubmit:async()=>ledger.push('submit'),onBeforePayment:async()=>ledger.push('payment')});
    try{await assert.rejects(runOrderWorkflow(program,order,browser.methods),/重发/);assert.equal(browser.paymentStarted,true);}finally{await browser.close();}
  });}finally{replayPayment=false;}
  assert.equal(orders,beforeOrders+2);assert.equal(payments,beforePayments+2);assert.equal(replayedPayments,0,'Payment 307 must never replay a financial POST');
  await withProxy(async route=>{
    const browser=await createOrderBrowser({url:saved.check.url,executionMode:'submit',dryRun:true},{proxyUrl:route,launch,storageState:saved.state,loginCheck:saved.check,accountReadOnly:true});
    try{await assert.rejects(browser.methods.goto(base+'/site-auth'),error=>error.code==='SITE_HTTP_AUTH_REQUIRED'&&!error.message.includes('proxy-secret'));}finally{await browser.close();}
  });
  const read=createBrowserSource({dataDir,launchContext});
  await withProxy(async route=>assert.match((await read(base+'/health',{userId:label,proxyUrl:route})).body,/HTTPS-READY/));
  assert.ok(originHeaders.every(headers=>!headers.authorization&&!headers.proxyAuthorization),'Website must never receive proxy credentials');
  console.log('PASS '+label+': HTTPS login save/restore, two payment-mode trials, delayed single order/payment, original invoice, blocked unauthorized writes/307 replay, origin-auth cancellation and monitor read');
}
try{
  await exercise('authenticated HTTP CONNECT',work=>work(proxyUrl));assert.ok(proxyChallenges>0&&acceptedConnects>0);
  const beforeBadOrders=orders,beforeBadPayments=payments,beforeChallenges=proxyChallenges;
  await assert.rejects(createOrderBrowser({url:base+'/clientarea.php',executionMode:'pay',dryRun:true},{launch,proxyUrl:proxyUrl.replace('proxy-secret','incorrect-password')}),error=>error.code==='PROXY_AUTH_FAILED'&&!error.message.includes('incorrect-password'));
  assert.ok(proxyChallenges-beforeChallenges<=8,'Rejected proxy authentication is bounded');assert.equal(orders,beforeBadOrders);assert.equal(payments,beforeBadPayments);
  await assert.rejects(createOrderBrowser({url:base+'/site-auth',executionMode:'pay',dryRun:true},{launch}),error=>error.code==='SITE_HTTP_AUTH_REQUIRED');
  console.log('PASS incorrect proxy credentials and origin HTTP authentication have distinct, redacted failures without orders or payments');
  const reservation=http.createServer(),ssPort=await listen(reservation);await new Promise(resolve=>reservation.close(resolve));
  const config=path.join(dataDir,'server.json');await fs.writeFile(config,JSON.stringify({server:'127.0.0.1',server_port:ssPort,method:'aes-256-gcm',password:'local-https-smoke-password',mode:'tcp_only',runtime:{mode:'single_thread'}}),{mode:0o600});
  let launchError;ssServer=spawn(process.env.SS_SMOKE_SERVER_EXECUTABLE||'/app/ssserver-test',['-c',config],{windowsHide:true,stdio:'ignore'});ssServer.once('error',error=>{launchError=error;});await new Promise(resolve=>setTimeout(resolve,300));assert.equal(launchError,undefined);assert.equal(ssServer.exitCode,null);
  const bridge=createShadowsocksBridge({dataDir});
  await exercise('real Shadowsocks HTTPS tunnel',work=>bridge('ss://aes-256-gcm:local-https-smoke-password@127.0.0.1:'+ssPort,work));
  assert.deepEqual(ledger,Array.from({length:4},()=>['submit','payment']).flat());assert.equal(unauthorizedWrites,0);assert.equal(replayedPayments,0);assert.ok(originChallenges>0);
  for(const name of ['browser-tmp','proxy-tmp']){const files=await fs.readdir(path.join(process.env.MONITOR_TEMP_DIR||dataDir,name));assert.equal(files.length,0,'Owned '+name+' resources must be released');}
  console.log('PASS HTTPS proxy credentials stay isolated and all browser profiles and SS leases are released');
}finally{
  if(ssServer?.pid&&ssServer.exitCode===null&&ssServer.signalCode===null){const closed=new Promise(resolve=>ssServer.once('close',resolve));ssServer.kill();await closed;}
  for(const socket of sockets)socket.destroy();target.closeAllConnections();await Promise.all([new Promise(resolve=>target.close(resolve)),new Promise(resolve=>proxy.close(resolve))]);
  const resolved=path.resolve(dataDir);assert.equal(path.dirname(resolved),path.resolve(process.env.DATA_DIR||tmpdir()));assert.ok(path.basename(resolved).startsWith('proxy-auth-smoke-'));await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
