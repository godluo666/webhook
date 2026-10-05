import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {createOrderBrowser}=await import(pathToFileURL(path.join(process.cwd(),'lib/order-browser.js')));
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
  res.end('<h1>My account</h1>'+password+(delay?'<div id="nav"></div><script>setTimeout(()=>{document.querySelector("#nav").innerHTML='+JSON.stringify(logout)+'},'+delay+')</script>':logout));return;
 }
 if(url.pathname==='/login-with-stale-logout'){res.end(login+'<a style="display:none" href="/logout">Log out</a>');return;}
 if(url.pathname==='/foreign-marker'){res.end('<a href="https://other.example/logout">Log out</a>');return;}
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
 const restored=async(url,check=saved.check,wait=250)=>createOrderBrowser({url},{storageState:saved.state,sessionStorageState:saved.sessionStorage,loginCheck:check,loginVerificationTimeoutMs:wait});
 browser=await restored(saved.check.url,saved.check,2000);await browser.close();browser=null;
 assert.equal(loginPageVisits,0);console.log('PASS restore accepts rotating logout token and unrelated visible password fields');
 await assert.rejects(restored(base+'/login-with-stale-logout',{...saved.check,url:base+'/login-with-stale-logout'}),e=>e.code==='ORDER_LOGIN_REQUIRED');
 console.log('PASS visible login form takes precedence over a stale logout menu');
 for(const route of ['/public','/foreign-marker'])await assert.rejects(restored(base+route,{...saved.check,url:base+route}),e=>e.code==='ORDER_LOGIN_UNVERIFIED');
 assert.ok(requests.every(r=>r.method==='GET'));assert.ok(!requests.some(r=>r.path==='/logout'));console.log('PASS missing or foreign auth markers cannot falsely confirm login, without clicking logout or submitting');
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
