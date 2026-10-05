import test from 'node:test';
import assert from 'node:assert/strict';
import {createOrderAccountService,publicOrderAccount,savedOrderAccount,orderAccountFingerprint} from '../lib/order-account.js';
const monitor={id:'monitor-a'},userFor=id=>({id,monitors:[monitor],orderAccounts:[]});
function setup(timeoutMs=10000){let leased=0,closed=0,valid=false;const user=userFor('a');
  const service=createOrderAccountService({persist:()=>{},timeoutMs,withProxy:async(_url,fn)=>{leased++;try{return await fn('http://proxy.example');}finally{leased--;}},openBrowser:async(_task,options)=>({close:async()=>closed++,remote:{view:async()=>({fields:[],image:'fixture'}),act:async()=>({fields:[],image:'updated'}),finish:async()=>{if(!valid)throw new Error('登录尚未完成');return {state:{cookies:[{name:'private',value:'secret-session'}],origins:[]},check:{url:'https://shop.example/account'},testedAt:new Date().toISOString()};}}})});
  service.save(user,monitor,{loginUrl:'https://shop.example/login',username:'private-user',password:'private-password'});
  return {service,user,get leased(){return leased},get closed(){return closed},login(){valid=true;}};
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
