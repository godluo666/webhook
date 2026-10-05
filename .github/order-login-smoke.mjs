import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import('playwright-core');
const {createOrderBrowser}=await import(pathToFileURL(path.join(process.cwd(),'lib/order-browser.js')));
const {createOrderAccountService}=await import(pathToFileURL(path.join(process.cwd(),'lib/order-account.js')));
const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':'/usr/bin/chromium');
process.env.MONITOR_BROWSER_EXECUTABLE=executable;
let token=0,loginPageVisits=0;const requests=[];
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');requests.push({path:url.pathname,method:req.method});res.setHeader('content-type','text/html; charset=utf-8');
 const logged=(req.headers.cookie||'').includes('session=valid');
 const login='<form action="/dologin.php" method="post"><label>Email<input name="email"></label><label>Password<input type="password" name="password"></label><button>Log in</button></form>';
 if(url.pathname==='/memory-login'){res.end('<style>button{position:absolute;left:20px;top:120px;width:100px;height:40px}</style><form action="/login"><input name="email"><input type="password"><button>Log in</button></form><script>document.querySelector("form").addEventListener("submit",event=>{event.preventDefault();document.body.innerHTML='+JSON.stringify('<a href="/logout">Log out</a>')+';})</script>');return;}
 if(url.pathname==='/login'){loginPageVisits++;res.end(login);return;}
 if(url.pathname==='/slow-login'){
  res.setHeader('set-cookie','session=valid; HttpOnly; Path=/');res.end('<p>Finishing login...</p><script>setTimeout(()=>{location.href="/account?delay=500&password=1"},350)</script>');return;
 }
 if(url.pathname==='/account'){
  if(!logged){res.end(login);return;}
  const logout='<div style="display:none"><a href="/logout?token='+ ++token +'">Log out</a></div>';
  const password=url.searchParams.has('password')?'<form action="/change-password" method="post"><input type="password" name="current_password" autocomplete="current-password"><input type="password" name="new_password" autocomplete="new-password"><button>Change password</button></form>':'';
  const delay=Number(url.searchParams.get('delay'))||0;
  if(url.searchParams.has('background')){
   const target=url.searchParams.get('background'),marker=url.searchParams.has('missing')?'':logout;
   res.end('<h1>My account</h1><div id="nav"></div><script>fetch('+JSON.stringify(target)+',{method:"POST",body:"token=private-login-token"}).catch(()=>{}).finally(()=>{document.querySelector("#nav").innerHTML='+JSON.stringify(marker)+'})</script>');return;
  }
  res.end('<h1>My account</h1>'+password+(delay?'<div id="nav"></div><script>setTimeout(()=>{document.querySelector("#nav").innerHTML='+JSON.stringify(logout)+'},'+delay+')</script>':logout));return;
 }
 if(url.pathname==='/login-with-stale-logout'){res.end(login+'<a style="display:none" href="/logout">Log out</a>');return;}
 if(url.pathname==='/foreign-marker'){res.end('<a href="https://other.example/logout">Log out</a>');return;}
 if(url.pathname==='/storage-start'){res.end('<h1>Loading</h1><script>sessionStorage.setItem("rotation","fresh");setTimeout(()=>location.href="/storage-account",50)</script>');return;}
 if(url.pathname==='/storage-account'){res.end('<h1>My account</h1><div id="nav"></div><script>if(sessionStorage.getItem("rotation")==="fresh"){const link=document.createElement("a");link.href="/logout";link.textContent="Log out";document.getElementById("nav").appendChild(link);}</script>');return;}
 if(url.pathname==='/public'){res.end('<h1>Store</h1>');return;}
 res.writeHead(404);res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
let browser;
try{
 browser=await createOrderBrowser({url:base+'/slow-login'},{loginOnly:true,loginVerificationTimeoutMs:3000});
 const saved=await browser.remote.finish();assert.ok(saved.check.url.includes('/account'));assert.ok(saved.state.cookies.some(c=>c.name==='session'&&c.value==='valid'));assert.equal((await browser.remote.view()).fields.length,0,'Change-password fields are not login fields');await browser.close();browser=null;
 console.log('PASS single save waits for delayed auth redirect and navigation marker');
 browser=await createOrderBrowser({url:base+'/memory-login'},{loginOnly:true,loginVerificationTimeoutMs:300});
 await browser.remote.act({type:'click',x:50,y:140});await assert.rejects(browser.remote.finish(),e=>e.code==='ORDER_LOGIN_UNVERIFIED');assert.equal((await browser.remote.view()).loginStatus,'authenticated');await browser.close();browser=null;console.log('PASS a non-restorable live login is rejected and its window remains usable');
 let proofLaunches=0;
 browser=await createOrderBrowser({url:base+'/account'},{loginOnly:true,storageState:saved.state,launch:async options=>{if(++proofLaunches===2)throw new Error('Target page, context or browser has been closed');return chromium.launch(options);}});
 const recoveredSave=await browser.remote.finish();assert.equal(proofLaunches,3);assert.ok(recoveredSave.state.cookies.some(cookie=>cookie.name==='session'));await browser.close();browser=null;
 console.log('PASS one transient verification-browser launch failure is recovered without repeating login');
 browser=await createOrderBrowser({url:base+'/storage-start'},{loginOnly:true,storageState:saved.state,sessionStorageState:{rotation:'old'},loginVerificationTimeoutMs:2000});
 const rotated=await browser.remote.finish();assert.equal(rotated.sessionStorage.rotation,'fresh');assert.equal(Object.keys(rotated.sessionStorage).some(key=>key.startsWith('__radar_session_seed_')),false);await browser.close();browser=null;
 console.log('PASS sessionStorage is seeded once and rotated login tokens survive redirect and fresh-browser verification');
 const restored=async(url,check=saved.check,wait=250)=>createOrderBrowser({url},{storageState:saved.state,sessionStorageState:saved.sessionStorage,loginCheck:check,loginVerificationTimeoutMs:wait});
 browser=await restored(saved.check.url,saved.check,2000);await browser.close();browser=null;
 assert.equal(loginPageVisits,0);console.log('PASS restore accepts rotating logout token and unrelated visible password fields');
 await assert.rejects(restored(base+'/login-with-stale-logout',{...saved.check,url:base+'/login-with-stale-logout'}),e=>e.code==='ORDER_LOGIN_REQUIRED');
 console.log('PASS visible login form takes precedence over a stale logout menu');
 for(const route of ['/public','/foreign-marker'])await assert.rejects(restored(base+route,{...saved.check,url:base+route}),e=>e.code==='ORDER_LOGIN_UNVERIFIED');
 assert.ok(requests.every(r=>r.method==='GET'));assert.ok(!requests.some(r=>r.path==='/logout'));console.log('PASS missing or foreign auth markers cannot falsely confirm login, without clicking logout or submitting');
 const backgroundUrl=base+'/account?background='+encodeURIComponent('/index.php?action=background-status');
 browser=await createOrderBrowser({url:backgroundUrl},{loginOnly:true,storageState:saved.state,loginVerificationTimeoutMs:2000});
 const backgroundSaved=await browser.remote.finish();assert.equal(backgroundSaved.check.url,backgroundUrl);await browser.close();browser=null;
 const backgroundPosts=requests.filter(r=>r.method==='POST').length;
 browser=await createOrderBrowser({url:backgroundUrl},{storageState:backgroundSaved.state,sessionStorageState:backgroundSaved.sessionStorage,loginCheck:backgroundSaved.check,accountReadOnly:true,loginVerificationTimeoutMs:2000});
 assert.equal((await browser.verifyLogin(backgroundSaved.check)).url,backgroundUrl);assert.equal((await browser.remote.view()).loginStatus,'authenticated');await browser.close();browser=null;
 browser=await createOrderBrowser({url:backgroundUrl},{storageState:backgroundSaved.state,sessionStorageState:backgroundSaved.sessionStorage,loginCheck:backgroundSaved.check,loginVerificationTimeoutMs:2000});await browser.snapshot();await browser.close();browser=null;
 assert.equal(requests.filter(r=>r.method==='POST').length,backgroundPosts,'Restoring and verifying must not send background POST requests');
 console.log('PASS save and restored login tolerate blocked background POST without allowing it to reach the merchant');
 const monitor={id:'background-monitor'},user={id:'background-user',orderAccounts:[{monitorId:monitor.id,loginUrl:backgroundUrl,revision:1,status:'saved',session:backgroundSaved}]};
 const accounts=createOrderAccountService({persist:()=>{}});
 assert.equal((await accounts.check(user,monitor)).status,'saved');
 assert.match((await accounts.productPreview(user,monitor,{url:backgroundUrl})).html,/data-order-account-marker/);
 assert.equal(requests.filter(r=>r.method==='POST').length,backgroundPosts,'Account checks and private previews also block background POST');
 console.log('PASS account verification and private preview use the same read-only protection');
 const missingUrl=backgroundUrl+'&missing=1';
 await assert.rejects(createOrderBrowser({url:missingUrl},{storageState:saved.state,loginCheck:{...saved.check,url:missingUrl},accountReadOnly:true,loginVerificationTimeoutMs:300}),error=>error.code==='ORDER_LOGIN_UNVERIFIED'&&/后台写入请求/.test(error.message)&&!/付款/.test(error.message));
 console.log('PASS blocked background requests cannot substitute for authentication evidence');
 for(const target of ['/pay','/cart.php?a=complete']){
  const url=base+'/account?background='+encodeURIComponent(target);
  await assert.rejects(createOrderBrowser({url},{storageState:saved.state,loginCheck:{...saved.check,url},accountReadOnly:true,loginVerificationTimeoutMs:2000}),/未授权的提交或付款/);
  await assert.rejects(async()=>{
   let loginBrowser;try{loginBrowser=await createOrderBrowser({url},{storageState:saved.state,loginOnly:true,loginVerificationTimeoutMs:2000});await loginBrowser.verifyLogin();}finally{await loginBrowser?.close();}
  },/未授权的提交或付款/);
 }
 assert.equal(requests.filter(r=>r.method==='POST').length,backgroundPosts,'Financial requests remain blocked during account verification');
 console.log('PASS order submission and payment endpoints stay blocked during account verification');
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
