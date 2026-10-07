import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {requestOrderAI,readOrderTimeouts,DEFAULT_ORDER_TIMEOUTS} from '../lib/order-timeouts.js';
import {createOrderService,validateOrderTask,validateOrderProgram} from '../lib/orders.js';
import {runCommerceAgent} from '../automation/agent/executor.js';

test('超时预算有明确默认值，部署配置限制范围',()=>{
  assert.deepEqual(readOrderTimeouts({}),DEFAULT_ORDER_TIMEOUTS);
  assert.deepEqual(readOrderTimeouts({ORDER_AI_TIMEOUT_MS:'90000',ORDER_AGENT_TIMEOUT_MS:'900000',ORDER_TRIAL_TIMEOUT_MS:'1800000'}),{aiTimeoutMs:90000,agentTimeoutMs:900000,trialTimeoutMs:1800000});
  assert.equal(readOrderTimeouts({ORDER_AI_TIMEOUT_MS:'0',ORDER_AGENT_TIMEOUT_MS:'Infinity'}).agentTimeoutMs,DEFAULT_ORDER_TIMEOUTS.agentTimeoutMs);
});
test('AI 超时仅重试本次请求，迟到回复不能影响返回，且传入同一预算',async()=>{
  let calls=0,aborted=0;const events=[];
  const result=await requestOrderAI(async(_user,_messages,options)=>{
    assert.equal(options.timeoutMs,25);assert.equal(options.stage,'页面规划');
    if(++calls===1){options.signal.addEventListener('abort',()=>aborted++);return new Promise(()=>{});}
    return {action:'review'};
  },{},[],{timeoutMs:25,retryDelayMs:1,onEvent:(action,data)=>events.push({action,...data})});
  assert.deepEqual(result,{action:'review'});assert.equal(calls,2);assert.equal(aborted,1);assert.equal(events.find(event=>event.action==='AI 请求超时，重新请求').nextAttempt,2);
  const starts=events.filter(event=>event.action==='AI 请求开始');assert.equal(starts.length,2);assert.equal(starts[0].requestId,starts[1].requestId);assert.equal(events.at(-1).action,'AI 响应完成');assert.equal(events.at(-1).response.action,'review');
});
test('AI 上游 TimeoutError 被翻译为带阶段的错误，达到上限停止',async()=>{
  let calls=0;await assert.rejects(requestOrderAI(async()=>{calls++;throw new DOMException('The operation was aborted due to timeout','TimeoutError');},{},[],{timeoutMs:50,retryDelayMs:1,stage:'生成业务 SOP'}),error=>{
    assert.equal(error.code,'ORDER_AI_TIMEOUT');assert.equal(error.stage,'生成业务 SOP：AI 响应');assert.equal(error.attempts,2);assert.doesNotMatch(error.message,/The operation/);return true;
  });assert.equal(calls,2);
});
test('手动取消 AI 请求或重试等待立即停止，不再发送请求',async()=>{
  const controller=new AbortController();let calls=0;
  const pending=requestOrderAI(async()=>{calls++;return new Promise(()=>{});},{},[],{signal:controller.signal,timeoutMs:200,retryDelayMs:1});
  controller.abort(new Error('用户停止试跑'));await assert.rejects(pending,/用户停止/);assert.ok(calls<=1);
  const backoff=new AbortController();
  const retry=requestOrderAI(async()=>{throw new DOMException('timeout','TimeoutError');},{},[],{signal:backoff.signal,timeoutMs:200,retryDelayMs:1000,onEvent:action=>{if(action==='AI 请求超时，重新请求')backoff.abort(new Error('停止重试'));}});
  await assert.rejects(retry,/停止重试/);
});
test('认证和无效模型结果不作为超时重试',async()=>{
  let calls=0;await assert.rejects(requestOrderAI(async()=>{calls++;throw new Error('HTTP 401');},{},[],{timeoutMs:50,retryDelayMs:1}),/401/);assert.equal(calls,1);
});
test('AI HTTP 已返回头但响应体一直不结束，也会取消并按次数停止',{timeout:5000},async()=>{
  let calls=0;const sockets=new Set();
  const server=http.createServer((_req,res)=>{calls++;res.writeHead(200,{'content-type':'application/json'});res.write('{"choices":');});
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url='http://127.0.0.1:'+server.address().port;
    await assert.rejects(requestOrderAI(async(_user,_messages,{signal})=>{const response=await fetch(url,{signal});return JSON.parse(await response.text());},{},[],{timeoutMs:150,retryDelayMs:1,stage:'页面规划'}),{code:'ORDER_AI_TIMEOUT'});
    assert.equal(calls,2);
  }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
});
const target=(meaning,ref)=>({meaning,ref,confidence:0.95});
const review=()=>({action:'review',reason:'Review current page',bindings:Object.fromEntries(['submit','product','quantity','total','currency'].map((key,i)=>[key,target(key,'e'+i)]))});
function serviceFixture(options={}){
  const task=validateOrderTask({url:'https://shop.example/product',monitorId:'m',product:'Product A',quantity:1,maxTotal:20,currency:'USD',executionMode:'submit'});
  const user={id:'u',settings:{},monitors:[{id:'m',kind:'webpage'}],orderTasks:[task],orderAccounts:[{monitorId:'m',loginUrl:task.url,revision:1,status:'saved',session:{state:{cookies:[],origins:[]},check:{url:task.url}}}]};
  let business=0,plans=0,reviews=0,closed=0;const signals=[];
  const service=createOrderService({persist:()=>{},aiRetryDelayMs:1,...options,requestAI:async(_user,messages,request)=>{
    signals.push(request.signal);
    if(messages[0].content.includes('仅返回 JSON {summary')){business++;return {summary:'购买并验证',workflow:{version:2,requirements:[]}};}
    plans++;if(options.plan)return options.plan(plans,request);if(plans===1)throw new DOMException('The operation was aborted due to timeout','TimeoutError');return review();
  },openBrowser:async(current)=>{
    const session={dryRun:!!current.dryRun,trace:[],receipt:null,snapshot:async()=>({text:'Product A USD 10',elements:[]}),close:async()=>closed++,methods:{
      observe:async()=>({url:current.url,text:'Product A USD 10',elements:[]}),resolveSemantic:async value=>({selector:'runtime-'+value.ref,strategy:'aria'}),
      submit:async()=>{assert.equal(current.dryRun,true);reviews++;session.receipt={status:'prepared',review:{product:'Product A',quantity:1,total:10,currency:'USD'}};return session.receipt;}
    }};return session;
  }});
  return {user,task,service,signals,get business(){return business},get plans(){return plans},get reviews(){return reviews},get closed(){return closed}};
}
test('规划偶发超时不重新生成 SOP，两次试跑仍各核验一次',async()=>{
  const f=serviceFixture();await f.service.generate(f.user,f.task);
  assert.equal(f.task.status,'ready');assert.equal(f.task.trial.preflightPasses,2);assert.equal(f.business,1);assert.equal(f.plans,3);assert.equal(f.reviews,2);assert.equal(f.closed,3);
  assert.equal(f.task.progress.stage,'试跑完成');assert.ok(f.user.orderExecutionLogs[0].events.some(event=>event.action==='AI 请求超时，重新请求'));
});
test('规划超时达到重试上限后关闭浏览器，不重跑整个试跑',async()=>{
  const f=serviceFixture({timeouts:{aiTimeoutMs:25},plan:()=>new Promise(()=>{})});
  await assert.rejects(f.service.generate(f.user,f.task),{code:'ORDER_AI_TIMEOUT'});
  assert.equal(f.business,1);assert.equal(f.plans,2);assert.equal(f.reviews,0);assert.equal(f.closed,2);assert.equal(f.task.errorCode,'ORDER_AI_TIMEOUT');assert.equal(f.service.isBusy(f.user,f.task),false);
  assert.equal(f.signals.at(-1).aborted,true);assert.equal(f.task.enabled,false);
});
test('全程试跑预算到期会中断规划，并保持原审批关闭',async()=>{
  const f=serviceFixture({timeouts:{trialTimeoutMs:35,aiTimeoutMs:1000},plan:()=>new Promise(()=>{})});
  await assert.rejects(f.service.generate(f.user,f.task),{code:'ORDER_TRIAL_TIMEOUT'});
  assert.equal(f.plans,1);assert.equal(f.reviews,0);assert.equal(f.closed,2);assert.equal(f.task.approvedHash,null);assert.equal(f.task.errorCode,'ORDER_TRIAL_TIMEOUT');
});
test('动态探索整体预算约束观察和规划，忽略取消的迟到计划不会执行',async()=>{
  let acted=0,ttl;
  const session={trace:[],methods:{observe:async()=>({url:'https://shop.example/product',elements:[]}),resolveSemantic:async()=>({selector:'temporary',strategy:'aria'}),click:async()=>acted++},keepAlive:value=>ttl=value};
  const program=validateOrderProgram({summary:'Explore',workflow:{version:2,requirements:[]}});
  await assert.rejects(runCommerceAgent(program,{},session,{timeoutMs:20,plan:async()=>{await delay(60);return {action:'click',reason:'Next',target:target('next','e0')};}}),{code:'AGENT_BUDGET_EXCEEDED'});
  await delay(80);assert.equal(acted,0);assert.ok(ttl>=15000);
});

test('AI 诊断记录 HTTP 和响应信息，日志回调失败不影响原响应或请求次数',async()=>{
  const events=[];let calls=0;
  const result=await requestOrderAI(async(_user,_messages,{onMetadata})=>{calls++;onMetadata({httpStatus:200,usage:{total_tokens:50}});return {action:'stop',reason:'真实输入缺失'};},{settings:{aiModel:'fixture',aiBaseUrl:'https://ai.example/v1'}},[],{onEvent:(action,data)=>events.push({action,...data})});
  assert.equal(result.action,'stop');assert.equal(calls,1);assert.equal(events.find(event=>event.action==='AI 传输信息').httpStatus,200);assert.equal(events.at(-1).response.reason,'真实输入缺失');
  await assert.doesNotReject(requestOrderAI(async()=>({configuration:'malformed'}),{},[],{onEvent:()=>{throw new Error('log unavailable');}}));
});
