import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {validateOrderProgram,validateOrderTask,createOrderService,orderProgramHash} from '../lib/orders.js';
import {BUSINESS_SOP,validateBusinessWorkflow,agentError} from '../automation/agent/model.js';
import {validateStep,createPlanner} from '../automation/agent/planner.js';
import {locatorCandidates,resolveSemanticTarget} from '../automation/browser/locator.js';
import {discoverCommerceSite} from '../automation/browser/crawler.js';
import {runCommerceAgent} from '../automation/agent/executor.js';
import {canRecover} from '../automation/agent/recovery.js';
import {createSiteMemory} from '../automation/agent/memory.js';
import {createEvidenceStore} from '../automation/logs/evidence.js';
import {confirmationEvidence} from '../automation/adapters/generic-commerce.js';
const program=()=>validateOrderProgram({summary:'Explore and review',workflow:{version:2,requirements:[]}});
const order={url:'https://shop.example/start',product:'Product A',quantity:1,maxTotal:20,currency:'USD',executionMode:'prepare'};
const target=(meaning,ref='e0')=>({meaning,ref,confidence:0.95});
const bindings=()=>Object.fromEntries(['submit','product','quantity','total','currency'].map((name,i)=>[name,target(name,'e'+i)]));
const review=()=>({action:'review',reason:'Verified checkout',bindings:bindings()});
function sessionFixture(){
  const session={trace:[],receipt:null,submissionStarted:false,paymentStarted:false,observed:0,calls:[],methods:{}};
  session.methods={
    observe:async()=>({observationId:'page-'+(++session.observed),url:order.url,title:'Checkout',text:'Product A USD 10',elements:[{ref:'e0',text:'Product A'},{ref:'e1',value:'1'}]}),
    resolveSemantic:async value=>({selector:'runtime-'+value.ref,strategy:'aria'}),
    readSemantic:async value=>value.meaning==='product'?{text:'Product A'}:value.meaning==='quantity'?{value:'1'}:{value:'Monthly'},
    fill:async(...args)=>session.calls.push(['fill',...args]),
    cart:async()=>session.calls.push(['cart']),
    submit:async checks=>{session.calls.push(['submit',checks]);session.receipt={status:'prepared',review:{product:'Product A',quantity:1,total:10,currency:'USD'}};return session.receipt;},
    pay:async()=>{session.paymentStarted=true;throw agentError('AGENT_ELEMENT_MISSING','Result uncertain');}
  };
  return session;
}
test('业务 SOP v2 不保存代码或选择器，运行时才绑定元素',()=>{
  const value=program();assert.equal(value.workflow.version,2);assert.deepEqual(value.workflow.businessSop,BUSINESS_SOP);assert.equal(value.code,undefined);assert.equal(value.checkout,undefined);
  for(const bad of [{selector:'#x'},{prepareCode:'function(){}'},{nested:{xpath:'//x'}}])assert.throws(()=>validateBusinessWorkflow({version:2,...bad}),{code:'ORDER_WORKFLOW_INVALID'});
  assert.throws(()=>validateStep({action:'click',reason:'No fixed locator',target:{...target('buy'),selector:'#buy'}}),{code:'AGENT_PLAN_INVALID'});
  assert.throws(()=>validateStep({action:'eval',reason:'execute'}),{code:'AGENT_PLAN_INVALID'});
  assert.throws(()=>validateStep({action:'click',reason:'guess',target:{...target('buy'),confidence:0.5}}),{code:'AGENT_LOW_CONFIDENCE'});
});
test('定位按 ARIA、文本、Label、Placeholder、Name、ID、CSS、XPath 顺序，歧义时不取第一项',async()=>{
  assert.deepEqual(locatorCandidates({role:'button',accessibleName:'Buy',text:'Buy',label:'Buy',placeholder:'Buy',name:'buy',id:'x',runtimeSelector:'runtime',runtimeXPath:'xpath'}).map(c=>c.strategy),['aria','text','label','placeholder','name','id','css','xpath']);
  const candidates=[],loc=(kind,count,marker)=>({count:async()=>{candidates.push(kind);return count;},getAttribute:async()=>marker,isVisible:async()=>true});
  const page={getByRole:()=>loc('aria',2),getByText:()=>loc('text',1,'stale:e0'),getByLabel:()=>loc('label',1,'now:e0'),locator:()=>loc('css',0)};
  const found=await resolveSemanticTarget(page,{observationId:'now',elements:[{ref:'e0',role:'button',accessibleName:'Buy',text:'Buy',label:'Buy',visible:true}]},target('purchase'));
  assert.equal(found.strategy,'label');assert.deepEqual(candidates,['aria','text','label']);
});
test('每步重新观察，购物车必须核验商品和数量，不能凭点击宣称成功',async()=>{
  const session=sessionFixture(),steps=[{action:'cart',reason:'Enter cart',target:target('add_to_cart')},{action:'verify_cart',reason:'Check actual cart',bindings:{product:target('product'),quantity:target('quantity','e1')}},review()];
  const learned=[];const result=await runCommerceAgent(program(),order,session,{plan:async()=>steps.shift(),onLearn:async value=>learned.push(value)});
  assert.equal(result.status,'prepared');assert.equal(session.observed,3);assert.deepEqual(session.calls.map(call=>call[0]),['cart','submit']);assert.equal(learned[0].history[1].action,'verify_cart');
  const failed=sessionFixture();await assert.rejects(runCommerceAgent(program(),order,failed,{autoRepair:false,plan:async()=>failed.calls.length?review():{action:'cart',reason:'Enter cart',target:target('add_to_cart')}}),{code:'AGENT_STEP_UNVERIFIED'});assert.equal(failed.calls.some(call=>call[0]==='submit'),false);
});
test('商品规格不符时在提交前停止，选项和输入都验证实际值',async()=>{
  const session=sessionFixture(),value=program();value.workflow.requirements=[{name:'Cycle',value:'Yearly'}];
  await assert.rejects(runCommerceAgent(value,order,session,{autoRepair:false,plan:async()=>({...review(),configuration:[{name:'Cycle',target:target('billing_cycle')}]})}),{code:'AGENT_CONFIGURATION_UNVERIFIED'});
  assert.equal(session.calls.length,0);
  await assert.rejects(runCommerceAgent(program(),order,session,{autoRepair:false,plan:async()=>({action:'fill',reason:'Set quantity',target:target('quantity'),value:'2'})}),{code:'AGENT_STEP_UNVERIFIED'});
});
test('页面变化在同一浏览器采集证据并修复；认证错误和交易结果未知不恢复',async()=>{
  const session=sessionFixture();let attempts=0,context,stale=true;
  session.captureEvidence=async()=>({id:'evidence-id',image:'data:image/png;base64,AA=='});
  session.methods.resolveSemantic=async value=>{if(stale){stale=false;throw agentError('AGENT_ELEMENT_MISSING','DOM changed');}return {selector:value.ref,strategy:'text'};};
  await runCommerceAgent(program(),order,session,{plan:async args=>{attempts++;context=args;return review();}});
  assert.equal(attempts,2);assert.equal(context.feedback.evidenceId,'evidence-id');assert.ok(context.image);assert.equal(session.calls.filter(c=>c[0]==='submit').length,1);
  for(const state of [{submissionStarted:true,receipt:null},{paymentStarted:true},{submissionStarted:true,receipt:{status:'prepared'}}])assert.equal(canRecover(agentError('AGENT_ELEMENT_MISSING','missing'),state,{attempts:0}),false);
  assert.equal(canRecover(agentError('PROXY_AUTH_FAILED','auth'),session,{attempts:0}),false);
});
test('购物车已发送但响应丢失时先验证原购物车，不重新添加',async()=>{
  const session=sessionFixture();let first=true,carts=0;
  session.methods.cart=async()=>{carts++;throw agentError('AGENT_ELEMENT_MISSING','new page unknown');};
  const result=await runCommerceAgent(program(),order,session,{plan:async({context})=>{
    if(first){first=false;return {action:'cart',reason:'Enter cart',target:target('add_to_cart')};}
    return context.pendingVerification==='cart'?{action:'verify_cart',reason:'Read existing cart',bindings:{product:target('product'),quantity:target('quantity')}}:review();
  }});
  assert.equal(result.status,'prepared');assert.equal(carts,1);
});
test('经验按用户、监控及完整 origin 隔离，原子落盘后可读取且无定位/凭据',async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),'commerce-memory-'));
  try{
    const memory=createSiteMemory({directory:folder}),history=[{action:'review',pageType:'checkout',meanings:['submit_order'],verified:true,selector:'#secret',ref:'e0',password:'private'}];
    await Promise.all([memory.record('u1:m1',order.url,{history,status:'prepared'}),memory.record('u1:m1',order.url,{history,status:'ordered'})]);
    const profile=await createSiteMemory({directory:folder}).read('u1:m1',order.url);assert.equal(profile.outcomes.ordered,1);assert.equal(profile.successPaths.length,2);
    assert.equal(await memory.read('u2:m1',order.url),null);assert.equal(await memory.read('u1:m2',order.url),null);assert.equal(await memory.read('u1:m1','http://shop.example/start'),null);
    assert.doesNotMatch(JSON.stringify(profile),/selector|password|#secret|"ref"/);
    await memory.record('u1:m1',order.url,{history,status:'failed',error:agentError('AGENT_ELEMENT_MISSING','private error')});
    assert.equal((await memory.read('u1:m1',order.url)).failurePaths[0].errorCode,'AGENT_ELEMENT_MISSING');
  }finally{await rm(folder,{recursive:true,force:true});}
});
test('证据按用户任务隔离，并限制历史数量',async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),'commerce-evidence-'));
  try{
    const store=createEvidenceStore({directory:folder,maxRecords:2});
    const saved=await store.save('u:t',{stage:'before_submit',observation:{url:order.url},image:'data:image/png;base64,AA=='});
    assert.equal(JSON.parse(await store.read('u:t',saved.id)).stage,'before_submit');assert.equal((await store.read('u:t',saved.id,'png')).length,1);
    await assert.rejects(store.read('other:t',saved.id),{code:'ENOENT'});await assert.rejects(store.read('u:t','../bad'));
    await store.save('u:t',{stage:'recovery',observation:{}});await store.save('u:t',{stage:'review',observation:{}});
    const files=await readdir(path.join(folder,(await readdir(folder))[0]));assert.equal(files.filter(f=>f.endsWith('.json')).length,2);
  }finally{await rm(folder,{recursive:true,force:true});}
});
test('订单成功必须同时具有成功提示与编号，失败和旧状态不能作为结果',()=>{
  const page=texts=>({elements:texts.map(text=>({text,visible:true}))});
  assert.equal(confirmationEvidence(page(['Order confirmed']),'order'),null);
  assert.equal(confirmationEvidence(page(['Order confirmed','Order idea: example']),'order'),null);
  assert.deepEqual(confirmationEvidence(page(['Order confirmed','Order number: ABC-7']),'order'),{text:'Order confirmed',orderId:'ABC-7'});
  assert.equal(confirmationEvidence(page(['Order confirmed','Order number: ABC-7','Order number: OTHER-8']),'order'),null);
  assert.equal(confirmationEvidence(page(['Payment unsuccessful']),'payment'),null);
  assert.equal(confirmationEvidence(page(['Payment successful']),'payment').text,'Payment successful');
});
test('探索通过两次试跑才开放用户确认，动态执行仍绑定原任务审批哈希',async()=>{
  const task=validateOrderTask({...order,monitorId:'m',executionMode:'submit'}),user={id:'u',settings:{},monitors:[{id:'m',kind:'webpage'}],orderTasks:[task],orderAccounts:[{monitorId:'m',loginUrl:order.url,revision:1,status:'saved',session:{state:{cookies:[],origins:[]},check:{url:order.url}}}]};
  let submits=0,planning=0;
  const service=createOrderService({persist:()=>{},requestAI:async(_user,messages)=>{if(messages[0].content.includes('仅返回 JSON {summary'))return {summary:'业务 SOP',workflow:{version:2,requirements:[]}};planning++;return review();},openBrowser:async(current,options)=>{
    const session=sessionFixture();session.dryRun=!!current.dryRun;session.methods.submit=async()=>{
      if(!current.dryRun){await options.onBeforeSubmit({product:'Product A',quantity:1,total:10,currency:'USD'});submits++;session.submissionStarted=true;}
      session.receipt={status:current.dryRun?'prepared':'ordered',review:{product:'Product A',quantity:1,total:10,currency:'USD'},confirmation:'Order confirmed',orderId:'ABC-7'};return session.receipt;
    };session.snapshot=session.methods.observe;session.close=async()=>{};return session;
  }});
  await service.discover(user,task);assert.equal(task.program.workflow.version,2);assert.equal(task.trial.preflightPasses,2);assert.equal(submits,0);assert.equal(task.enabled,false);
  assert.throws(()=>service.approve(user,task,'wrong'));
  service.approve(user,task,orderProgramHash(task));await service.execute(user,task);assert.equal(task.status,'ordered');assert.equal(submits,1);assert.equal(planning,3);assert.equal((await service.profile(user,task)).outcomes.ordered,1);
  await assert.rejects(service.execute(user,task),/已经执行/);assert.equal(submits,1);
});

test('探索保留付款意图供试跑核验，只允许宿主 dryRun 会话',async()=>{const session=sessionFixture();session.dryRun=true;let mode;await discoverCommerceSite(program(),{...order,executionMode:'pay'},session,{plan:async({order})=>{mode=order.executionMode;return review();}});assert.equal(mode,'pay');session.dryRun=false;assert.throws(()=>discoverCommerceSite(program(),order,session,{}));});
