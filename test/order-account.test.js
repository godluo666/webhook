import test from 'node:test';
import assert from 'node:assert/strict';
import {createOrderAccountService,publicOrderAccount,savedOrderAccount,orderAccountFingerprint} from '../lib/order-account.js';
const monitor={id:'monitor-a'},userFor=id=>({id,monitors:[monitor],orderAccounts:[]});
test('账户验证设置只接受同源账户页面，并参与会话版本变更',()=>{
 const service=createOrderAccountService({persist:()=>{}}),user=userFor('proof');
 const first=service.save(user,monitor,{loginUrl:'https://shop.example/login',checkUrl:'https://shop.example/profile',loggedInSelector:'#account-name'});
 assert.equal(first.checkUrl,'https://shop.example/profile');assert.equal(first.loggedInSelector,'#account-name');
 const unchanged=service.save(user,monitor,{loginUrl:first.loginUrl});assert.equal(unchanged.revision,first.revision);
 for(const checkUrl of ['https://other.example/profile','https://user:pass@shop.example/profile','https://shop.example/cart.php?a=complete'])assert.throws(()=>service.save(user,monitor,{loginUrl:first.loginUrl,checkUrl}));
 const changed=service.save(user,monitor,{loginUrl:first.loginUrl,loggedInSelector:'#other-name'});assert.equal(changed.revision,first.revision+1);
});
function setup(timeoutMs=10000,options={}){let leased=0,closed=0,valid=false,finishCalls=0,checkError=null;const openedTasks=[];const user=userFor('a');
  const service=createOrderAccountService({persist:()=>{if(options.persistError?.())throw new Error('会话写入失败');},timeoutMs,saveTimeoutMs:options.saveTimeoutMs,withProxy:async(_url,fn)=>{leased++;try{return await fn('http://proxy.example');}finally{leased--;}},openBrowser:async(task,browserOptions)=>{openedTasks.push(task);if(browserOptions.loginCheck&&checkError)throw checkError;return {close:async()=>{closed++;await options.closeGate;},productHtml:async()=>'<h1>Product A</h1>',remote:{view:async()=>({fields:[],image:'fixture'}),act:async()=>({fields:[],image:'updated'}),finish:async()=>{finishCalls++;await options.finishGate;if(!valid)throw new Error('登录尚未完成');return {state:{cookies:[{name:'private',value:'secret-session'}],origins:[]},check:{url:'https://shop.example/account'},testedAt:new Date().toISOString()};}}};}});
  service.save(user,monitor,{loginUrl:'https://shop.example/login',username:'private-user',password:'private-password'});
  return {service,user,get leased(){return leased},get closed(){return closed},get finishCalls(){return finishCalls},openedTasks,setCheckError(error){checkError=error;},login(){valid=true;}};
}
test('提前登录跨请求保留浏览器及代理，完成后释放；未完成验证时保留窗口',async()=>{
  const f=setup(),opened=await f.service.start(f.user,monitor);assert.equal(f.leased,1);
  await assert.rejects(f.service.finish(f.user,monitor,{sessionId:opened.sessionId}),/尚未完成/);assert.equal(f.leased,1);assert.equal(f.closed,0);
  await f.service.action(f.user,monitor,{sessionId:opened.sessionId,type:'refresh'});const before=orderAccountFingerprint(f.user.orderAccounts[0]);f.login();const account=await f.service.finish(f.user,monitor,{sessionId:opened.sessionId});
  assert.equal(account.status,'saved');assert.equal(f.leased,0);assert.equal(f.closed,1);assert.notEqual(before,orderAccountFingerprint(f.user.orderAccounts[0]));
  const value=JSON.stringify(publicOrderAccount(f.user.orderAccounts[0]));assert.equal(value.includes('secret-session'),false);assert.equal(value.includes('private-password'),false);assert.equal(value.includes('private-user'),false);
});
test('登录会话只能由所属用户和监控访问，清除状态使原授权失效',async()=>{
  const f=setup(),opened=await f.service.start(f.user,monitor);const other=userFor('b');
  for(const method of ['action','finish','cancel'])await assert.rejects(f.service[method](other,monitor,{sessionId:opened.sessionId}),error=>error.status===404);
  await assert.rejects(f.service.action(f.user,{id:'another'},{sessionId:opened.sessionId}),error=>error.status===404);
  f.login();await f.service.finish(f.user,monitor,{sessionId:opened.sessionId});assert.ok(savedOrderAccount(f.user,{monitorId:monitor.id,url:'https://shop.example/product'}));
  assert.throws(()=>savedOrderAccount(f.user,{monitorId:monitor.id,url:'https://different.example/product'}),/网站不符/);
  const before=orderAccountFingerprint(f.user.orderAccounts[0]);await f.service.logout(f.user,monitor);assert.notEqual(before,orderAccountFingerprint(f.user.orderAccounts[0]));assert.throws(()=>savedOrderAccount(f.user,{monitorId:monitor.id,url:'https://shop.example/product'}),/请先/);
});
test('关闭、登录超时和打开新登录会话都释放原浏览器和代理',async()=>{
  const f=setup(50),first=await f.service.start(f.user,monitor),second=await f.service.start(f.user,monitor);assert.equal(f.closed,1);assert.equal(f.leased,1);
  await assert.rejects(f.service.action(f.user,monitor,{sessionId:first.sessionId}),error=>error.status===404);
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(f.closed,2);assert.equal(f.leased,0);assert.equal(f.service.busy(f.user,monitor),false);
  await assert.rejects(f.service.action(f.user,monitor,{sessionId:second.sessionId}),error=>error.status===404);
});

test('商品点选读取保存的私有会话，未完成登录或跨网站时拒绝，读取后释放资源',async()=>{
 const f=setup();await assert.rejects(f.service.productPreview(f.user,monitor,{url:'https://shop.example/product'}),/请先/);
 const opened=await f.service.start(f.user,monitor);assert.equal(f.service.busy(f.user,monitor.id),true);assert.equal(f.service.busy(f.user,monitor),true);
 await assert.rejects(f.service.productPreview(f.user,monitor,{url:'https://shop.example/product'}),/结束当前登录/);f.login();await f.service.finish(f.user,monitor,{sessionId:opened.sessionId});
 const revision=f.user.orderAccounts[0].revision;const preview=await f.service.productPreview(f.user,monitor,{url:'https://shop.example/product'});
 assert.equal(preview.html,'<h1>Product A</h1>');assert.equal(preview.url,'https://shop.example/product');assert.equal(f.leased,0);assert.equal(f.closed,2);assert.equal(f.service.busy(f.user,monitor.id),false);assert.equal(f.user.orderAccounts[0].revision,revision);
 await assert.rejects(f.service.productPreview(f.user,monitor,{url:'https://other.example/product'}),/网站不符/);
});

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('保存成功不被浏览器关闭阻塞；重复请求返回同一保存结果，且不重复写入账户',async()=>{
 const close=deferred(),f=setup(10000,{closeGate:close.promise}),opened=await f.service.start(f.user,monitor);f.login();
 const started=Date.now();try{
  const result=await f.service.finish(f.user,monitor,{sessionId:opened.sessionId});assert.equal(result.status,'saved');assert.ok(Date.now()-started<1000);assert.equal(f.leased,1);assert.equal(f.service.busy(f.user,monitor),false);
  const fingerprint=orderAccountFingerprint(f.user.orderAccounts[0]);const retry=await f.service.finish(f.user,monitor,{sessionId:opened.sessionId});assert.deepEqual(retry,result);assert.equal(f.finishCalls,1);assert.equal(fingerprint,orderAccountFingerprint(f.user.orderAccounts[0]));
  await assert.rejects(f.service.finish(userFor('other'),monitor,{sessionId:opened.sessionId}),error=>error.status===404);
  await f.service.logout(f.user,monitor);await assert.rejects(f.service.finish(f.user,monitor,{sessionId:opened.sessionId}),/替代/);
 }finally{close.resolve();await new Promise(r=>setImmediate(r));}assert.equal(f.leased,0);
});
test('并发保存合并为一次验证，保存中拒绝清除、验证、点击和重新打开操作',async()=>{
 const gate=deferred(),f=setup(10000,{finishGate:gate.promise}),opened=await f.service.start(f.user,monitor);f.login();
 const first=f.service.finish(f.user,monitor,{sessionId:opened.sessionId}),second=f.service.finish(f.user,monitor,{sessionId:opened.sessionId});
 try{
  assert.equal(f.finishCalls,1);assert.equal(f.service.busy(f.user,monitor),true);
  for(const method of ['check','logout','start','cancel','action'])await assert.rejects(f.service[method](f.user,monitor,{sessionId:opened.sessionId,type:'refresh'}),/正在/);
 }finally{gate.resolve();}const results=await Promise.all([first,second]);assert.deepEqual(results[0],results[1]);assert.equal(f.finishCalls,1);assert.equal(f.leased,0);
});
test('网页暂时缺少登录证据保留私有会话，重试验证可恢复；只有明确退出才标记失效',async()=>{
 const f=setup(),opened=await f.service.start(f.user,monitor);await assert.rejects(f.service.check(f.user,monitor),/保存或关闭/);f.login();await f.service.finish(f.user,monitor,{sessionId:opened.sessionId});
 const account=f.user.orderAccounts[0],fingerprint=orderAccountFingerprint(account),session=account.session;
 f.setCheckError(Object.assign(new Error('网页尚未完成加载'),{code:'ORDER_LOGIN_UNVERIFIED'}));await assert.rejects(f.service.check(f.user,monitor),/尚未/);assert.equal(account.status,'unavailable');assert.equal(account.session,session);assert.equal(savedOrderAccount(f.user,{monitorId:monitor.id,url:'https://shop.example/product'}),account);
 f.setCheckError(null);await f.service.check(f.user,monitor);assert.equal(account.status,'saved');assert.equal(account.error,'');assert.equal(orderAccountFingerprint(account),fingerprint);assert.equal(f.openedTasks.at(-1).url,'https://shop.example/account');
 f.setCheckError(Object.assign(new Error('网站返回登录页面'),{code:'ORDER_LOGIN_REQUIRED'}));await assert.rejects(f.service.check(f.user,monitor),/登录页面/);assert.equal(account.status,'expired');assert.equal(account.session,session);assert.throws(()=>savedOrderAccount(f.user,{monitorId:monitor.id,url:'https://shop.example/product'}),/登录失效/);
});
test('登录窗口超时关闭后，迟到的保存结果不能覆盖当前账户',async()=>{
 const gate=deferred(),f=setup(50,{finishGate:gate.promise,saveTimeoutMs:50}),opened=await f.service.start(f.user,monitor);f.login();
 const result=f.service.finish(f.user,monitor,{sessionId:opened.sessionId}),failed=assert.rejects(result,/保存登录会话超时/);await new Promise(r=>setTimeout(r,100));gate.resolve();await failed;assert.equal(f.user.orderAccounts[0].status,'logged_out');assert.equal(f.user.orderAccounts[0].session,null);assert.equal(f.leased,0);assert.equal(f.service.busy(f.user,monitor),false);
});

test('持久化失败保留原状态和登录窗口，存储恢复后仍可保存同一次登录',async()=>{
 let fail=false;const f=setup(10000,{persistError:()=>fail}),opened=await f.service.start(f.user,monitor);f.login();fail=true;
 const before=orderAccountFingerprint(f.user.orderAccounts[0]);await assert.rejects(f.service.finish(f.user,monitor,{sessionId:opened.sessionId}),/写入失败/);assert.equal(f.user.orderAccounts[0].status,'logged_out');assert.equal(orderAccountFingerprint(f.user.orderAccounts[0]),before);assert.equal(f.leased,1);
 fail=false;assert.equal((await f.service.finish(f.user,monitor,{sessionId:opened.sessionId})).status,'saved');assert.equal(f.leased,0);
});


test('保存有独立时间预算，跨过登录空闲期限仍能完成且只写入一次',async()=>{
 const gate=deferred(),f=setup(50,{finishGate:gate.promise,saveTimeoutMs:500}),opened=await f.service.start(f.user,monitor);f.login();
 const result=f.service.finish(f.user,monitor,{sessionId:opened.sessionId});await new Promise(r=>setTimeout(r,100));assert.equal(f.leased,1);gate.resolve();
 assert.equal((await result).status,'saved');assert.equal(f.finishCalls,1);assert.equal(f.leased,0);
});
test('登录操作延长空闲期限，长期无人操作仍关闭窗口',async()=>{
 const f=setup(150),opened=await f.service.start(f.user,monitor);await new Promise(r=>setTimeout(r,80));
 await f.service.action(f.user,monitor,{sessionId:opened.sessionId,type:'refresh'});await new Promise(r=>setTimeout(r,80));
 assert.equal(f.leased,1);await f.service.cancel(f.user,monitor,{sessionId:opened.sessionId});assert.equal(f.leased,0);
});

test('登录保存失败和成功分别保留脱敏日志，重复完成请求不重复保存或制造执行记录',async()=>{
  const f=setup(),opened=await f.service.start(f.user,monitor);await assert.rejects(f.service.finish(f.user,monitor,{sessionId:opened.sessionId}));
  assert.equal(f.user.orderExecutionLogs[0].kind,'login-save');assert.equal(f.user.orderExecutionLogs[0].status,'failed');f.login();await f.service.finish(f.user,monitor,{sessionId:opened.sessionId});
  const count=f.user.orderExecutionLogs.length;await f.service.finish(f.user,monitor,{sessionId:opened.sessionId});assert.equal(f.user.orderExecutionLogs.length,count);assert.equal(f.finishCalls,2);
  assert.equal(f.user.orderExecutionLogs[0].status,'saved');const text=JSON.stringify(f.user.orderExecutionLogs);for(const secret of ['private-user','private-password','secret-session'])assert.ok(!text.includes(secret));
});
test('取消卡在代理启动前的登录立即释放用户锁，迟到的代理不能再启动浏览器',async()=>{
 const gate=deferred(),controller=new AbortController(),user=userFor('cancel-start');let launches=0;
 const service=createOrderAccountService({persist:()=>{},withProxy:async(_url,fn)=>{await gate.promise;return fn('');},openBrowser:async(_task,options)=>{options.signal.throwIfAborted();launches++;throw new Error('unexpected browser');}});
 service.save(user,monitor,{loginUrl:'https://shop.example/login'});
 const pending=service.start(user,monitor,{}, {signal:controller.signal});const settled=pending.then(()=>false,error=>error.name==='AbortError');await new Promise(r=>setImmediate(r));controller.abort();
 try{assert.equal(await Promise.race([settled,new Promise(r=>setTimeout(()=>r(false),600))]),true);assert.equal(service.busy(user,monitor),false);}
 finally{gate.resolve();await settled;}assert.equal(launches,0);
});
test('代理打开超时后释放用户锁并保留旧会话，迟到结果不能打开登录窗口',async()=>{
 const gate=deferred(),user=userFor('timeout-start');let launches=0;
 const service=createOrderAccountService({persist:()=>{},openTimeoutMs:25,withProxy:async(_url,fn)=>{await gate.promise;return fn('');},openBrowser:async(_task,options)=>{options.signal.throwIfAborted();launches++;throw new Error('unexpected browser');}});
 service.save(user,monitor,{loginUrl:'https://shop.example/login'});const account=user.orderAccounts[0];account.status='saved';account.session={state:{cookies:[]},check:{url:'https://shop.example/account'}};const previous=account.session;
 const pending=service.start(user,monitor),settled=pending.then(()=>null,error=>error);
 try{const failure=await Promise.race([settled,new Promise(r=>setTimeout(()=>r(null),600))]);assert.equal(failure?.code,'ORDER_LOGIN_OPEN_TIMEOUT');assert.equal(service.busy(user,monitor),false);assert.equal(account.session,previous);assert.equal(account.status,'saved');}
 finally{gate.resolve();await settled;}assert.equal(launches,0);
});
test('另一监控打开登录不能中断当前监控正在保存的会话',async()=>{
 const gate=deferred(),f=setup(10000,{finishGate:gate.promise}),other={id:'monitor-b'};f.user.monitors.push(other);f.service.save(f.user,other,{loginUrl:'https://shop.example/login'});
 const opened=await f.service.start(f.user,monitor);f.login();const saving=f.service.finish(f.user,monitor,{sessionId:opened.sessionId}),settled=saving.then(value=>value,error=>error);
 let otherLogin;
 try{await assert.rejects(async()=>{otherLogin=await f.service.start(f.user,other);},/正在/);assert.equal(f.service.busy(f.user,monitor),true);}
 finally{gate.resolve();const result=await settled;if(otherLogin)await f.service.cancel(f.user,other,{sessionId:otherLogin.sessionId});assert.equal(result.status,'saved');}assert.equal(f.leased,0);
});
test('登录地址修改和清除持久化失败时恢复原会话、凭据与配置版本',async()=>{
 let fail=false;const f=setup(10000,{persistError:()=>fail}),opened=await f.service.start(f.user,monitor);f.login();await f.service.finish(f.user,monitor,{sessionId:opened.sessionId});
 const account=f.user.orderAccounts[0],previous={...account};fail=true;
 assert.throws(()=>f.service.save(f.user,monitor,{loginUrl:'https://other.example/login',username:'new-user',password:'new-password'}),/写入失败/);assert.deepEqual(account,previous);
 await assert.rejects(f.service.logout(f.user,monitor),/写入失败/);assert.deepEqual(account,previous);fail=false;
 const other={id:'new-monitor'};assert.equal(f.user.orderAccounts.length,1);fail=true;assert.throws(()=>f.service.save(f.user,other,{loginUrl:'https://shop.example/login'}),/写入失败/);assert.equal(f.user.orderAccounts.length,1);
});
