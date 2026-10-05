import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
const {createOrderBrowser}=await import(pathToFileURL(path.join(process.cwd(),'lib/order-browser.js')));
const {createOrderAccountService}=await import(pathToFileURL(path.join(process.cwd(),'lib/order-account.js')));
const {createBrowserSource}=await import(pathToFileURL(path.join(process.cwd(),'lib/browser-source.js')));
const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':'/usr/bin/chromium');
process.env.MONITOR_BROWSER_EXECUTABLE=executable;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const dataDir=await fs.mkdtemp(path.join(tmpdir(),'radar-resource-smoke-'));
const processes=new Set(),profiles=new Set(),browsers=new Set();let launches=0,activeProxies=0;
async function inspect(browser){
 let cdp;try{
  cdp=await browser.newBrowserCDPSession();
  const info=await cdp.send('SystemInfo.getProcessInfo');for(const process of info.processInfo)processes.add(process.id);
  try{const command=await cdp.send('Browser.getBrowserCommandLine');const arg=command.arguments.find(arg=>arg.startsWith('--user-data-dir='));if(arg)profiles.add(arg.slice('--user-data-dir='.length));}catch{/* Persistent contexts omit the automation flag. */}
 }finally{await cdp?.detach().catch(()=>{});}
}
async function track(browser){
 launches++;browsers.add(browser);await inspect(browser);
 const close=browser.close.bind(browser);let closing;
 browser.close=()=>closing||=(async()=>{try{if(browser.isConnected())await inspect(browser);}catch{}await close();browsers.delete(browser);})();
 return browser;
}
const launch=async options=>track(await chromium.launch({...options,executablePath:executable}));
const openBrowser=(task,options)=>createOrderBrowser(task,{...options,launch,loginVerificationTimeoutMs:300});
const service=createOrderAccountService({persist:()=>{},openBrowser,timeoutMs:3000,withProxy:async(_url,work)=>{activeProxies++;try{return await work('');}finally{activeProxies--;}}});
const monitor={id:'monitor'},user={id:'user',orderAccounts:[]};
const server=http.createServer((req,res)=>{
 assert.equal(req.method,'GET','Resource tests never create real orders');res.setHeader('content-type','text/html; charset=utf-8');
 const html=req.url==='/missing'?'<p>Public store</p>':'<a href="/logout">Log out</a><h1>Product</h1>';
 if(req.url==='/slow'){const timer=setTimeout(()=>res.end(html),5000);res.once('close',()=>clearTimeout(timer));}else res.end(html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;throw error;}};
async function assertReleased(){
 for(let i=0;i<80;i++){
  const running=[...processes].filter(alive),existing=[];for(const directory of profiles){try{await fs.stat(directory);existing.push(directory);}catch(error){if(error.code!=='ENOENT')throw error;}}
  if(!running.length&&!existing.length&&activeProxies===0)return;
  if(i===79){assert.deepEqual(running,[],'Owned Chromium processes remain');assert.deepEqual(existing,[],'Temporary browser profiles remain');assert.equal(activeProxies,0,'Proxy lease remains');}
  await pause(100);
 }
}
try{
 service.save(user,monitor,{loginUrl:base});
 for(let i=0;i<3;i++){const opened=await service.start(user,monitor);await service.cancel(user,monitor,{sessionId:opened.sessionId});await assertReleased();assert.equal(service.busy(user,monitor),false);}
 const saved=await service.start(user,monitor);await service.finish(user,monitor,{sessionId:saved.sessionId});await assertReleased();
 await service.check(user,monitor);await service.productPreview(user,monitor,{url:base});await assertReleased();
 console.log('PASS repeated login open/cancel/save, fresh-session verification and product previews release owned processes, profiles and proxy leases');
 const expiring=await service.start(user,monitor);await pause(3500);await assertReleased();await assert.rejects(service.action(user,monitor,{sessionId:expiring.sessionId,type:'refresh'}),/过期/);
 const controller=new AbortController(),pending=service.start(user,monitor,{}, {signal:controller.signal});setTimeout(()=>controller.abort(),100);await assert.rejects(pending);await assertReleased();
 const watchdog=await openBrowser({url:base},{timeoutMs:1000});await pause(1200);await assertReleased();await watchdog.close();await watchdog.close();
 await assert.rejects(openBrowser({url:base+'/missing'},{loginCheck:{url:base+'/missing'}}),error=>error.code==='ORDER_LOGIN_UNVERIFIED');await assertReleased();
 const one=await openBrowser({url:base},{loginOnly:true}),two=await openBrowser({url:base},{loginOnly:true});
 await assert.rejects(openBrowser({url:base},{loginOnly:true}),error=>error.code==='ORDER_BROWSER_BUSY');
 const restored=await one.remote.finish();assert.equal(restored.check.url,base+'/','Saving remains usable with another login window open');
 const reserved=await openBrowser({url:base,program:{checkout:{}},executionMode:'submit'},{});
 const secondOrder=await openBrowser({url:base,program:{checkout:{}},executionMode:'submit'},{});
 await assert.rejects(openBrowser({url:base,program:{checkout:{}},executionMode:'submit'},{}),error=>error.code==='ORDER_BROWSER_BUSY');
 await one.close();await two.close();await reserved.close();await secondOrder.close();await assertReleased();
 console.log('PASS actual Chromium concurrency limit and reserved triggered-order capacity; no orders submitted');
 console.log('PASS login expiry, canceled startup, browser watchdog and failed login release resources without a later operation');
 const read=createBrowserSource({dataDir,launchContext:async(profile,options)=>{profiles.add(profile);const context=await chromium.launchPersistentContext(profile,{...options,executablePath:executable});await track(context.browser());return context;}});
 const first=new AbortController(),queued=new AbortController();const countBefore=launches;
 const reading=read(base+'/slow',{userId:'reader',signal:first.signal});reading.catch(()=>{});
 for(let i=0;i<100&&launches===countBefore;i++)await pause(50);assert.equal(launches,countBefore+1);
 const waiting=read(base,{userId:'reader-queued',signal:queued.signal});queued.abort();await assert.rejects(waiting);first.abort();await assert.rejects(reading);await assertReleased();assert.equal(launches,countBefore+1,'Canceled queue does not launch another browser');
 assert.deepEqual((await fs.readdir(path.join(process.env.MONITOR_TEMP_DIR || dataDir,'browser-tmp'))).filter(name=>name.startsWith('source-')),[]);
 console.log('PASS canceled running and queued monitor previews release browser profiles and remove waiting entries');
 console.log('PASS '+launches+' browser launches, '+processes.size+' owned process IDs checked; zero processes, temporary profiles or proxy leases remain');
}finally{
 for(const browser of browsers)await browser.close().catch(()=>{});
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 const resolved=path.resolve(dataDir);assert.ok(resolved.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(resolved).startsWith('radar-resource-smoke-'));await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
