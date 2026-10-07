import test from 'node:test';
import assert from 'node:assert/strict';
import { executeOrderScript } from '../lib/order-script.js';
import { parseOrderTotal } from '../lib/order-browser.js';
import { createOrderService, validateOrderTask, validateOrderProgram, orderProgramHash, publicOrderTask } from '../lib/orders.js';

const input = {label:'购买产品 A',url:'https://shop.example/product/a',product:'Product A',quantity:1,maxTotal:15,currency:'USD',executionMode:'submit',monitorId:'monitor-a'};
const program = {workflow:{version:1,prepareCode:'function(order,browser){browser.goto(order.url);return {ready:true};}',paymentCode:'function(){return {checks:{}};}'},summary:'根据实际 DOM 选择产品 A 并核对订单',code:'function(order,browser){browser.goto(order.url);return browser.submit();}',checkout:{submitSelector:'#finish',productSelector:'#name',quantitySelector:'#quantity',totalSelector:'#total',currencySelector:'#currency',confirmationSelector:'#order-number'}};

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
function fixture({uncertain=false,fake=false,pay=false,paymentFailure=false,paymentUnknown=false,insufficientBalance=false,paymentStructure=false,assistanceCode=null,trialAuthError=null,generatedProgram=null}={}){
  const task=validateOrderTask({...input,executionMode:pay?'pay':input.executionMode}),user={id:'user-a',orderAccounts:[{monitorId:'monitor-a',loginUrl:input.url,revision:1,status:'saved',session:{state:{cookies:[],origins:[]},check:{url:input.url}}}],monitors:[{id:'monitor-a',kind:'webpage'}],orderTasks:[task]};let generated=0,commits=0,writes=0,payments=0,loginError=null,missingPayment=paymentStructure,opened=0;
  const service=createOrderService({persist:()=>writes++,requestAI:async(_user,messages)=>{generated++;assert.ok(messages[1].content.includes('actual-random-selector'));if(generatedProgram)return generatedProgram;if(JSON.parse(messages[1].content).phase==='payment')return {summary:'从原订单账单真实 DOM 恢复付款定位',paymentCode:assistanceCode||'function(){return {checks:{}};}'};return pay?{...program,code:'function(order,browser){browser.goto(order.url);const receipt=browser.submit();if(receipt.status==="prepared")return receipt;return browser.pay({});}'}:program;},runScript:executeOrderScript,
    openBrowser:async(current,options)=>{if(loginError)throw loginError;if(trialAuthError&&++opened===2)throw trialAuthError;const session={trace:[],receipt:null,snapshot:async()=>({text:'Product A USD 10',elements:[{id:'actual-random-selector'}]}),close:async()=>{},methods:{goto:async()=>true,submit:async()=>{
      if(current.dryRun||current.executionMode==='prepare'){session.trace.push({action:'核对'});session.receipt={status:'prepared',review:{product:current.product,quantity:1,total:10,currency:'USD'}};return session.receipt;}
      await options.onBeforeSubmit({product:current.product,quantity:1,total:10,currency:'USD'});commits++;session.trace.push({action:'提交'});
      if(uncertain)throw new Error('receipt timed out');
      if(fake&&!pay)return {status:'ordered'};
      session.receipt={status:'ordered',review:{product:current.product,quantity:1,total:10,currency:'USD'},confirmation:'Order #42'};return session.receipt;
    },pay:async()=>{
      if(missingPayment){missingPayment=false;throw new Error('Missing payment field: original-invoice-pay');}
      if(insufficientBalance){session.receipt={...session.receipt,status:'awaiting_payment',invoiceId:'42',url:'https://shop.example/invoice?id=42',paymentPending:{reason:'insufficient_balance',message:'余额不足，已保留待付款订单',balance:0,total:10,currency:'USD'}};return session.receipt;}
      if(paymentFailure)throw new Error('invoice price changed');
      assert.ok(task.submissionStartedAt, 'Submission ledger must be durable before payment');
      await options.onBeforePayment({invoiceId:'42',total:10,currency:'USD'});
      assert.ok(task.paymentStartedAt, 'Payment ledger must be durable before charge');payments++;
      if(paymentUnknown)throw new Error('payment confirmation timed out');
      if(fake)return {status:'paid'};
      session.receipt={...session.receipt,status:'paid',invoiceId:'42',payment:{total:10,currency:'USD'}};return session.receipt;
    }}};return session;}});
  return {service,task,user,setLoginError(error){loginError=error;},get generated(){return generated},get commits(){return commits},get payments(){return payments},get writes(){return writes}};
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
    const service=createOrderService({persist:()=>{},requestAI:async()=>{generated++;return {...program,workflow:{version:1,prepareCode:'function(){return {ready:true};}'}};},openBrowser:async(current,options)=>{const session={receipt:null,trace:[],close:async()=>{},snapshot:async()=>({text:'actual changed DOM',elements:[{id:'new-submit'}]}),methods:{submit:async()=>{
      if(current.dryRun){session.receipt={status:'prepared'};return session.receipt;}
      if(afterSubmit){await options.onBeforeSubmit({total:10});commits++;throw new Error('网页元素不存在：#receipt');}
      if(failOnce){failOnce=false;throw new Error('网页元素不存在：#old-submit');}
      await options.onBeforeSubmit({total:10});commits++;session.receipt={status:'ordered'};return session.receipt;
    }}};return session;}});
    await service.generate(user,task);service.approve(user,task,orderProgramHash(task));await service.trigger(user,user.monitors[0]);await service.trigger(user,user.monitors[0]);
    assert.equal(commits,1);assert.equal(generated,afterSubmit?1:2);assert.equal(task.repairs.length,afterSubmit?0:1);assert.equal(task.status,afterSubmit?'uncertain':'ordered');
  }
});

test('商品名称与币种可留空，点选与试跑识别结果参与执行授权',()=>{
 const task=validateOrderTask({...input,product:'',currency:'',label:'',productSelection:{url:input.url,selector:'#product-name',text:'Product A'}});
 assert.equal(task.product,'');assert.equal(task.currency,'');assert.equal(task.label,'自动下单');
 assert.throws(()=>validateOrderTask({...input,productSelection:{url:'https://shop.example/other',selector:'#a',text:'a'}}),/页面已变化/);
 assert.throws(()=>validateOrderTask({...input,currency:'$'}),/币种/);
 const original=orderProgramHash(task);task.verifiedProduct='Product A';task.verifiedCurrency='USD';assert.notEqual(orderProgramHash(task),original);
 assert.throws(()=>parseOrderTotal('USD -5.00'),/无效/);
});
test('余额不足保留待付款账单，停止付款且不会重复下单或扣款',async()=>{
 const f=fixture({pay:true,insufficientBalance:true});await f.service.generate(f.user,f.task);f.service.approve(f.user,f.task,orderProgramHash(f.task));
 await f.service.execute(f.user,f.task);assert.equal(f.task.status,'awaiting_payment');assert.equal(f.task.result.invoiceId,'42');assert.equal(f.task.result.paymentPending.reason,'insufficient_balance');
 assert.equal(f.commits,1);assert.equal(f.payments,0);assert.equal(f.task.paymentStartedAt,undefined);
 await f.service.trigger(f.user,f.user.monitors[0]);await assert.rejects(f.service.execute(f.user,f.task),/已经执行/);assert.equal(f.commits,1);assert.equal(f.payments,0);
 f.service.recover([f.user]);assert.equal(f.task.status,'awaiting_payment');assert.equal(f.task.enabled,false);
});

test('登录暂时无法验证不删除会话或调用 AI 修复，恢复后继续使用同一账户授权',async()=>{
 const f=fixture(),account=f.user.orderAccounts[0],original=account.session;
 f.setLoginError(Object.assign(new Error('暂时无法确认登录'),{code:'ORDER_LOGIN_UNVERIFIED'}));await assert.rejects(f.service.generate(f.user,f.task),/无法确认/);assert.equal(account.status,'unavailable');assert.equal(account.session,original);assert.equal(f.generated,0);assert.equal(f.commits,0);
 f.setLoginError(null);await f.service.generate(f.user,f.task);assert.equal(account.status,'saved');assert.equal(account.error,'');assert.equal(f.generated,1);assert.equal(account.revision,1);
 f.service.approve(f.user,f.task,orderProgramHash(f.task));f.setLoginError(Object.assign(new Error('网站已返回登录页面'),{code:'ORDER_LOGIN_REQUIRED'}));await f.service.execute(f.user,f.task);assert.equal(account.status,'expired');assert.equal(account.session,original);assert.equal(f.generated,1);assert.equal(f.commits,0);
});


test('订单创建后的 DOM 变化由 AI 在同一浏览器协助原账单付款，永不创建第二单',async()=>{
 const f=fixture({pay:true,paymentStructure:true});await f.service.generate(f.user,f.task);f.service.approve(f.user,f.task,orderProgramHash(f.task));
 await f.service.execute(f.user,f.task);assert.equal(f.task.status,'paid');assert.equal(f.commits,1);assert.equal(f.payments,1);assert.equal(f.generated,2);assert.equal(f.task.paymentAssistance.length,1);
 await f.service.trigger(f.user,f.user.monitors[0]);assert.equal(f.commits,1);assert.equal(f.payments,1);
});

test('付款 AI 辅助不能提交订单或访问商品操作，付款结果不明时不调用 AI 再付款',async()=>{
 const f=fixture({pay:true,paymentStructure:true,assistanceCode:'function(order,browser){return browser.submit();}'});await f.service.generate(f.user,f.task);f.service.approve(f.user,f.task,orderProgramHash(f.task));await f.service.execute(f.user,f.task);
 assert.equal(f.task.status,'payment_failed');assert.equal(f.commits,1);assert.equal(f.payments,0);assert.equal(f.generated,2);
 const g=fixture({pay:true,paymentUnknown:true});await g.service.generate(g.user,g.task);g.service.approve(g.user,g.task,orderProgramHash(g.task));await g.service.execute(g.user,g.task);
 assert.equal(g.task.status,'uncertain');assert.equal(g.generated,1);assert.equal(g.commits,1);assert.equal(g.payments,1);
});


test('连续两次试跑发现会话购物车数量累加，AI 修正后才允许启用且试跑不提交',async()=>{
 const f=fixture();let cart=0,generated=0;
 const nextProgram={workflow:{version:1,prepareCode:'function(order,browser){browser.fill("#quantity",String(order.quantity));return {ready:true};}'},checkout:program.checkout,summary:'调整已有购物车',code:'function(order,browser){browser.fill("#quantity",String(order.quantity));return browser.submit();}'};
 const service=createOrderService({persist:()=>{},requestAI:async(_user,messages)=>{generated++;if(generated===2)assert.match(messages.at(-1).content,/连续试跑/);return nextProgram;},openBrowser:async current=>{
  const session={trace:[],snapshot:async()=>({url:current.url,elements:[]}),close:async()=>{},methods:{fill:async()=>{cart=generated===1?cart+1:1;},submit:async()=>{session.receipt={status:'prepared',review:{product:'Switch',quantity:cart,total:cart*10,currency:'USD'}};return session.receipt;}}};return session;
 }});
 await service.generate(f.user,f.task);assert.equal(generated,2);assert.equal(f.task.trial.preflightPasses,2);assert.equal(f.task.trial.review.quantity,1);assert.equal(f.task.trial.review.total,10);assert.equal(f.task.enabled,false);assert.equal(f.task.submissionStartedAt,undefined);
 service.approve(f.user,f.task,orderProgramHash(f.task));assert.equal(f.task.enabled,true);
});

test('代理认证或网站 HTTP 认证失败停止试跑，不重新生成 AI 代码或删除网页登录会话',async()=>{
 for(const code of ['PROXY_AUTH_FAILED','SITE_HTTP_AUTH_REQUIRED']){
  const f=fixture({pay:true,trialAuthError:Object.assign(new Error('认证未完成'),{code})}),account=f.user.orderAccounts[0],saved=account.session;
  await assert.rejects(f.service.generate(f.user,f.task),error=>error.code===code);
  assert.equal(f.generated,1);assert.equal(f.commits,0);assert.equal(f.payments,0);assert.equal(account.status,'saved');assert.equal(account.session,saved);assert.equal(f.task.status,'failed');assert.equal(f.task.approvedHash,null);
  const execution=fixture({pay:true});await execution.service.generate(execution.user,execution.task);execution.service.approve(execution.user,execution.task,orderProgramHash(execution.task));const original=execution.user.orderAccounts[0].session;execution.setLoginError(Object.assign(new Error('认证未完成'),{code}));await execution.service.execute(execution.user,execution.task);
  assert.equal(execution.generated,1);assert.equal(execution.commits,0);assert.equal(execution.payments,0);assert.equal(execution.user.orderAccounts[0].status,'saved');assert.equal(execution.user.orderAccounts[0].session,original);
 }
});

test('日志保留同一次生成的两次试跑、执行结果和真实代码哈希，读取日志不重新执行',async()=>{
  const f=fixture({pay:true});await f.service.generate(f.user,f.task);
  const generated=f.user.orderExecutionLogs[0];assert.equal(generated.kind,'generate');assert.equal(generated.status,'passed');assert.equal(generated.program.codeHash,orderProgramHash(f.task));assert.deepEqual(generated.events.filter(e=>e.action==='试跑通过').map(e=>e.pass),[1,2]);
  f.service.approve(f.user,f.task,orderProgramHash(f.task));await f.service.execute(f.user,f.task);
  const executed=f.user.orderExecutionLogs[0];assert.equal(executed.kind,'execute');assert.equal(executed.status,'paid');assert.ok(executed.result.submissionStartedAt);assert.ok(executed.result.paymentStartedAt);assert.ok(executed.events.some(e=>e.action==='订单提交前记录'));assert.ok(executed.events.some(e=>e.action==='付款前记录'));assert.equal(f.commits,1);assert.equal(f.payments,1);
});
test('浏览器启动认证失败仍保留生成日志和错误代码，既不调用 AI 也不丢失阶段',async()=>{
  const f=fixture();f.setLoginError(Object.assign(new Error('proxy authentication failed'),{code:'PROXY_AUTH_FAILED'}));await assert.rejects(f.service.generate(f.user,f.task));
  const log=f.user.orderExecutionLogs[0];assert.equal(log.status,'failed');assert.equal(log.result.error.code,'PROXY_AUTH_FAILED');assert.ok(log.events.some(e=>e.action==='浏览器执行失败'&&e.stage==='读取实际商品页面'&&e.error.code==='PROXY_AUTH_FAILED'));assert.equal(f.generated,0);assert.equal(f.commits,0);
});
test('优惠码选填且保持大小写，拒绝非文本、超长和多行码，修改后审批哈希失效',()=>{
 assert.equal(validateOrderTask(input).couponCode,'');assert.equal(validateOrderTask({...input,couponCode:'  Save-20  '}).couponCode,'Save-20');
 for(const couponCode of [20,{},'x'.repeat(129),'SAVE\n20','SAVE\u000020'])assert.throws(()=>validateOrderTask({...input,couponCode}),/优惠码/);
 const task=validateOrderTask(input),hash=orderProgramHash(task);task.couponCode='SAVE20';assert.notEqual(orderProgramHash(task),hash);task.couponCode='';assert.equal(orderProgramHash(task),hash);
});
test('无效付款代码不再取得试跑或启用资格，未产生订单',async()=>{
 const f=fixture({pay:true,generatedProgram:{...program,workflow:{...program.workflow,paymentCode:'function(){return {checks: ;}'}}});
 await assert.rejects(f.service.generate(f.user,f.task),error=>error.code==='ORDER_SCRIPT_INVALID');assert.equal(f.task.trial,null);assert.equal(f.commits,0);assert.equal(f.payments,0);assert.throws(()=>f.service.approve(f.user,f.task,orderProgramHash(f.task)));
});
test('缺货不会反复调用 AI，保留配置且不允许启用未完成的试跑',async()=>{
 for(const generatedProgram of [{status:'out_of_stock'},{...program,workflow:{...program.workflow,prepareCode:'function(){return {status:"out_of_stock"};}'}}]){
  const f=fixture({generatedProgram});await assert.rejects(f.service.generate(f.user,f.task),error=>error.code==='ORDER_OUT_OF_STOCK');assert.equal(f.generated,1);assert.equal(f.task.status,'waiting_stock');assert.equal(f.task.enabled,false);assert.equal(f.commits,0);assert.equal(f.task.validation.preflight,'waiting_stock');assert.throws(()=>f.service.approve(f.user,f.task,orderProgramHash(f.task)));
 }
});
test('提交前临时登录失败可在同一配置重新验证，旧授权不能直接重试',async()=>{
 const f=fixture();await f.service.generate(f.user,f.task);f.service.approve(f.user,f.task,orderProgramHash(f.task));
 f.setLoginError(Object.assign(new Error('暂时无法确认登录'),{code:'ORDER_LOGIN_UNVERIFIED'}));await f.service.execute(f.user,f.task);
 assert.equal(f.task.status,'needs_validation');assert.equal(f.task.result,null);assert.equal(f.task.trial,null);assert.equal(f.task.approvedHash,null);assert.equal(f.task.lastAttempt.code,'ORDER_LOGIN_UNVERIFIED');assert.equal(f.commits,0);
 await assert.rejects(f.service.execute(f.user,f.task));
 f.setLoginError(null);await f.service.generate(f.user,f.task);assert.equal(f.task.status,'ready');assert.equal(f.task.validation.preflight,'passed');f.service.approve(f.user,f.task,orderProgramHash(f.task));await f.service.execute(f.user,f.task);assert.equal(f.commits,1);
});
