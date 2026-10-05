import test from 'node:test';
import assert from 'node:assert/strict';
import { executeOrderScript } from '../lib/order-script.js';
import { parseOrderTotal } from '../lib/order-browser.js';
import { createOrderService, validateOrderTask, validateOrderProgram, orderProgramHash, publicOrderTask } from '../lib/orders.js';

const input = {label:'购买产品 A',url:'https://shop.example/product/a',product:'Product A',quantity:1,maxTotal:15,currency:'USD',executionMode:'submit',monitorId:'monitor-a'};
const program = {summary:'根据实际 DOM 选择产品 A 并核对订单',code:'function(order,browser){browser.goto(order.url);return browser.submit();}',checkout:{submitSelector:'#finish',productSelector:'#name',quantitySelector:'#quantity',totalSelector:'#total',currencySelector:'#currency',confirmationSelector:'#order-number'}};

test('AI JavaScript 在隔离解释器中动态分支和操作，不能访问 Node、网络和文件',async()=>{
  const calls=[];
  const result=await executeOrderScript('function(order,browser){ if(browser.text("#product")===order.product) browser.fill("#quantity",String(order.quantity)); return {safe:typeof process==="undefined"&&typeof require==="undefined"&&typeof fetch==="undefined", product:order.product};}',{product:'Product A',quantity:2},{text:async()=> 'Product A',fill:async(...args)=>calls.push(args)});
  assert.equal(result.safe,true);assert.deepEqual(calls,[['#quantity','2']]);
  await assert.rejects(executeOrderScript('function(){return {data:require("node:fs").readFileSync(".data/state.json")};}',{},{}),/require/);
});
test('AI 脚本的无限循环和超量操作会被中断',async()=>{
  await assert.rejects(executeOrderScript('function(){while(true){}}',{}, {},{timeoutMs:50}),/interrupted|超时/);
  await assert.rejects(executeOrderScript('function(order,browser){for(let i=0;i<20;i++)browser.text("#price");return {};}',{}, {text:async()=> '1'},{maxCalls:3}),/次数/);
});
test('下单配置拒绝无限预算、无效数量、带凭据的 URL；付款必须作为独立执行范围；总价必须唯一',()=>{
  for(const value of [{maxTotal:0},{quantity:0},{quantity:11},{executionMode:'anything'},{url:'https://user:pass@shop.example/a'}])assert.throws(()=>validateOrderTask({...input,...value}));
  assert.equal(validateOrderTask({...input,executionMode:'pay'}).executionMode,'pay');
  assert.equal(parseOrderTotal('USD 1,234.50'),1234.5);assert.throws(()=>parseOrderTotal('原价 $20 折后 $10'));
  const task=validateOrderTask({...input,username:'site-user',password:'private-site-secret'});
  assert.equal(task.enabled,false);assert.equal(JSON.stringify(publicOrderTask(task)).includes('private-site-secret'),false);
  assert.deepEqual(validateOrderTask({...input,url:'https://another-shop.example/a'},task).credentials,{});
});
function fixture({uncertain=false,fake=false,pay=false,paymentFailure=false,paymentUnknown=false}={}){
  const task=validateOrderTask({...input,executionMode:pay?'pay':input.executionMode}),user={id:'user-a',orderAccounts:[{monitorId:'monitor-a',loginUrl:input.url,revision:1,status:'saved',session:{state:{cookies:[],origins:[]},check:{url:input.url}}}],monitors:[{id:'monitor-a',kind:'webpage'}],orderTasks:[task]};let generated=0,commits=0,writes=0,payments=0;
  const service=createOrderService({persist:()=>writes++,requestAI:async(_user,messages)=>{generated++;assert.ok(messages[1].content.includes('actual-random-selector'));return pay?{...program,code:'function(order,browser){browser.goto(order.url);const receipt=browser.submit();if(receipt.status==="prepared")return receipt;return browser.pay({});}'}:program;},runScript:executeOrderScript,
    openBrowser:async(current,options)=>{const session={trace:[],receipt:null,snapshot:async()=>({text:'Product A USD 10',elements:[{id:'actual-random-selector'}]}),close:async()=>{},methods:{goto:async()=>true,submit:async()=>{
      if(current.dryRun||current.executionMode==='prepare'){session.trace.push({action:'核对'});session.receipt={status:'prepared',review:{product:current.product,quantity:1,total:10,currency:'USD'}};return session.receipt;}
      await options.onBeforeSubmit({product:current.product,quantity:1,total:10,currency:'USD'});commits++;session.trace.push({action:'提交'});
      if(uncertain)throw new Error('receipt timed out');
      if(fake&&!pay)return {status:'ordered'};
      session.receipt={status:'ordered',review:{product:current.product,quantity:1,total:10,currency:'USD'},confirmation:'Order #42'};return session.receipt;
    },pay:async()=>{
      if(paymentFailure)throw new Error('invoice price changed');
      assert.ok(task.submissionStartedAt, 'Submission ledger must be durable before payment');
      await options.onBeforePayment({invoiceId:'42',total:10,currency:'USD'});
      assert.ok(task.paymentStartedAt, 'Payment ledger must be durable before charge');payments++;
      if(paymentUnknown)throw new Error('payment confirmation timed out');
      if(fake)return {status:'paid'};
      session.receipt={...session.receipt,status:'paid',invoiceId:'42',payment:{total:10,currency:'USD'}};return session.receipt;
    }}};return session;}});
  return {service,task,user,get generated(){return generated},get commits(){return commits},get payments(){return payments},get writes(){return writes}};
}
test('代码必须来自 AI 并通过真实核对；审批绑定代码和配置，修改后不得执行',async()=>{
  const f=fixture();await f.service.generate(f.user,f.task);assert.equal(f.generated,1);assert.equal(f.task.enabled,false);assert.equal(f.task.trial.passed,true);
  assert.throws(()=>f.service.approve(f.user,f.task,'wrong'),/重新生成/);
  const hash=orderProgramHash(f.task);f.service.approve(f.user,f.task,hash);f.task.quantity=2;
  await assert.rejects(f.service.execute(f.user,f.task),/配置已变更/);assert.equal(f.commits,0);
});
test('监控触发只提交一次，失败、结果未知和重启后都不会自动重复下单',async()=>{
  for(const uncertain of [false,true]){
    const f=fixture({uncertain});await f.service.generate(f.user,f.task);f.service.approve(f.user,f.task,orderProgramHash(f.task));
    await f.service.trigger(f.user,f.user.monitors[0]);await f.service.trigger(f.user,f.user.monitors[0]);assert.equal(f.commits,1);assert.equal(f.task.enabled,false);assert.equal(f.task.status,uncertain?'uncertain':'ordered');
    await assert.rejects(f.service.execute(f.user,f.task),/已经执行/);
  }
  const f=fixture();f.task.status='running';f.task.enabled=true;f.task.startedAt=new Date().toISOString();f.service.recover([f.user]);assert.equal(f.task.status,'uncertain');assert.equal(f.task.enabled,false);assert.ok(f.task.result);
});
test('伪造成功返回值不能替代执行器确认的订单凭据',async()=>{
  const f=fixture({fake:true});await f.service.generate(f.user,f.task);f.service.approve(f.user,f.task,orderProgramHash(f.task));await f.service.execute(f.user,f.task);
  assert.equal(f.task.status,'uncertain');assert.match(f.task.error,/可验证/);
});

test('付款记录先于扣款保存；成功、付款中断和未开始付款都不会再次执行',async()=>{
  for(const options of [{pay:true},{pay:true,paymentFailure:true},{pay:true,paymentUnknown:true},{pay:true,fake:true}]){
    const f=fixture(options);await f.service.generate(f.user,f.task);assert.equal(f.payments,0);assert.equal(f.commits,0);
    f.service.approve(f.user,f.task,orderProgramHash(f.task));await f.service.trigger(f.user,f.user.monitors[0]);await f.service.trigger(f.user,f.user.monitors[0]);
    assert.equal(f.commits,1);assert.equal(f.payments,options.paymentFailure?0:1);assert.equal(f.task.status,options.paymentFailure?'payment_failed':options.paymentUnknown||options.fake?'uncertain':'paid');
    await assert.rejects(f.service.execute(f.user,f.task),/已经执行/);
  }
  const f=fixture({pay:true});f.task.status='stopping';f.task.startedAt=new Date().toISOString();f.task.paymentStartedAt=f.task.startedAt;f.task.paymentReview={invoiceId:'42',total:10,currency:'USD'};f.service.recover([f.user]);assert.equal(f.task.status,'uncertain');assert.equal(f.task.result.invoiceId,'42');assert.equal(f.task.enabled,false);
});
test('触发监控变更或删除会撤销原下单授权，不沿用旧条件执行',async()=>{
  const f=fixture();await f.service.generate(f.user,f.task);f.service.approve(f.user,f.task,orderProgramHash(f.task));f.user.monitors[0].keyword='a different trigger';
  await assert.rejects(f.service.execute(f.user,f.task),/监控条件已变化/);assert.equal(f.task.enabled,false);assert.equal(f.commits,0);
  await assert.rejects(Promise.resolve().then(()=>f.service.approve(f.user,f.task,orderProgramHash(f.task))),/监控条件已变化/);
  await f.service.generate(f.user,f.task);f.service.approve(f.user,f.task,orderProgramHash(f.task));f.user.monitors=[];await assert.rejects(f.service.execute(f.user,f.task),/已删除/);assert.equal(f.task.enabled,false);assert.equal(f.commits,0);
});

test('缺少提前登录、账户变更和 AFF 变更不能沿用原下单授权',async()=>{
  const f=fixture();f.user.orderAccounts=[];await assert.rejects(f.service.generate(f.user,f.task),/请先/);assert.equal(f.generated,0);
  const g=fixture();await g.service.generate(g.user,g.task);g.service.approve(g.user,g.task,orderProgramHash(g.task));g.user.orderAccounts[0].revision++;
  await assert.rejects(g.service.execute(g.user,g.task),/账户已变化/);assert.equal(g.commits,0);assert.equal(g.task.enabled,false);
  const h=fixture();await h.service.generate(h.user,h.task);h.service.approve(h.user,h.task,orderProgramHash(h.task));h.task.affiliateUrl='https://shop.example/aff?aff=12';await assert.rejects(h.service.execute(h.user,h.task),/配置已变更/);assert.equal(h.commits,0);
  assert.throws(()=>validateOrderTask({...input,affiliateUrl:'javascript:alert(1)'}));assert.throws(()=>validateOrderTask({...input,affiliateUrl:'https://u:p@shop.example/aff'}));
});
test('下单前页面变化由 AI 修复并试跑，提交后的结构错误不重试',async()=>{
  for(const afterSubmit of[false,true]){
    const task=validateOrderTask(input),user={id:'a',orderTasks:[task],monitors:[{id:'monitor-a',kind:'webpage'}],orderAccounts:[{monitorId:'monitor-a',loginUrl:input.url,revision:1,status:'saved',session:{state:{cookies:[],origins:[]},check:{url:input.url}}}]};let generated=0,commits=0,failOnce=true;
    const service=createOrderService({persist:()=>{},requestAI:async()=>{generated++;return {...program,code:'function(order,browser){return browser.submit();}'};},openBrowser:async(current,options)=>{const session={receipt:null,trace:[],close:async()=>{},snapshot:async()=>({text:'actual changed DOM',elements:[{id:'new-submit'}]}),methods:{submit:async()=>{
      if(current.dryRun){session.receipt={status:'prepared'};return session.receipt;}
      if(afterSubmit){await options.onBeforeSubmit({total:10});commits++;throw new Error('网页元素不存在：#receipt');}
      if(failOnce){failOnce=false;throw new Error('网页元素不存在：#old-submit');}
      await options.onBeforeSubmit({total:10});commits++;session.receipt={status:'ordered'};return session.receipt;
    }}};return session;}});
    await service.generate(user,task);service.approve(user,task,orderProgramHash(task));await service.trigger(user,user.monitors[0]);await service.trigger(user,user.monitors[0]);
    assert.equal(commits,1);assert.equal(generated,afterSubmit?1:2);assert.equal(task.repairs.length,afterSubmit?0:1);assert.equal(task.status,afterSubmit?'uncertain':'ordered');
  }
});
