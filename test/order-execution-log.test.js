import test from 'node:test';
import assert from 'node:assert/strict';
import {buildShadowsocksUrl} from '../lib/shadowsocks.js';
import {createOrderExecutionLogs,diagnosticError,diagnosticPage,diagnosticAIInput,diagnosticAIOutput} from '../lib/order-execution-log.js';

const fixture=()=>({id:'owner',settings:{aiKey:'ai-key-private',sourceProxy:'http://proxy-user:proxy-password@proxy.example:8080'},monitors:[{id:'m',label:'监控 A'},{id:'other'}],orderAccounts:[{monitorId:'m',credentials:{username:'site-private-user',password:'site-private-password'},session:{state:{cookies:[{name:'session',value:'cookie-private-value'}]},sessionStorage:{auth:'storage-private-value'},redactions:['otp-private-value']}}],orderTasks:[{id:'task',monitorId:'m',credentials:{password:'task-private-value'}}]});
test('执行日志在写入和导出时隐藏凭据、Cookie、存储、请求体和 URL 令牌',()=>{
  const user=fixture(),store=createOrderExecutionLogs({sourceOptions:()=>({proxyUrl:user.settings.sourceProxy})}),task={...user.orderTasks[0],url:'https://shop.example/clientarea.php?token=url-only-secret',quantity:1,maxTotal:10,couponCode:'SAVE20',couponFailurePolicy:'continue'};
  const log=store.start(user,'m',{kind:'execute',task});
  log.program({summary:'按实际页面核对',workflow:{version:1,prepareCode:'function(o,b){b.goto("/cart.php?a=view&key=relative-url-secret");return {ready:true};}'},checkout:{submitSelector:'#finish'}},'f'.repeat(64));
  log.event('请求失败',{error:diagnosticError(new Error('site-private-user site-private-password ai-key-private cookie-private-value storage-private-value otp-private-value task-private-value http://proxy-user:proxy-password@proxy.example:8080 Basic cHJveHk6c2VjcmV0 /pay?token=relative-token-secret {"password":"json-field-secret"}')),
    page:diagnosticPage({url:task.url,controls:[{tag:'input',id:'invoice',name:'invoiceid',value:'never-log-input',text:'never-log-page-body'},{tag:'a',href:'/account?key=control-url-secret'}]}),headers:{cookie:'never-log-header'},requestBody:'never-log-body',cookies:['never-log-cookie']});
  log.finish('failed',{result:{status:'prepared',review:{total:10,couponFailure:{code:'SAVE20',status:'unverified',failurePolicy:'continue',reason:'无法确认优惠生效'}}}});
  for(const value of [user.orderExecutionLogs,store.report(user,'m')]){
    const text=JSON.stringify(value);
    for(const secret of ['site-private-user','site-private-password','ai-key-private','cookie-private-value','storage-private-value','otp-private-value','task-private-value','proxy-user','proxy-password','url-only-secret','relative-url-secret','relative-token-secret','control-url-secret','cHJveHk6c2VjcmV0','never-log-input','never-log-page-body','never-log-header','never-log-body','never-log-cookie','json-field-secret'])assert.ok(!text.includes(secret),secret);
    assert.ok(text.includes('a=view'));assert.ok(text.includes('#finish'));
  }
  assert.equal(store.report(user,'m').operations[0].network.type,'http_proxy');assert.equal(store.report(user,'m').operations[0].context.quantity,1);assert.equal(store.report(user,'m').operations[0].context.couponFailurePolicy,'continue');assert.equal(store.report(user,'m').operations[0].result.receipt.review.couponFailure.status,'unverified');const basic=store.start(user,'m',{kind:'generate',task:{product:'Basic Plan'}});basic.finish('passed');assert.equal(store.report(user,'m').operations[0].context.product,'Basic Plan');
});
test('日志限制操作数量、事件数量和字节数，保留最终结果并明确标记截断',()=>{
  const user=fixture(),store=createOrderExecutionLogs({maxRecords:3,maxEvents:4,maxBytes:4096});
  for(let run=0;run<7;run++){
    const log=store.start(user,'m',{kind:'generate'});log.program({summary:'full code',code:'x'.repeat(15000)},'a'.repeat(64));
    for(let i=0;i<10;i++)log.event('步骤',{detail:'detail'.repeat(500),i});
    log.finish('failed',{error:new Error('e'.repeat(8000))});
  }
  assert.equal(user.orderExecutionLogs.length,3);
  for(const record of user.orderExecutionLogs){assert.ok(record.events.length<=4);assert.ok(Buffer.byteLength(JSON.stringify(record))<=4096);assert.ok(record.droppedEvents>0);assert.equal(record.metadataTruncated,true);assert.equal(record.events.at(-1).action,'操作结束');assert.ok(record.endedAt);assert.equal(record.program.codeHash,'a'.repeat(64));}
});
test('日志按用户和监控隔离，重启只记录中断；旧结果可导出而不补造运行',()=>{
  const user=fixture(),store=createOrderExecutionLogs();store.start(user,'m',{kind:'execute'});
  const restored=JSON.parse(JSON.stringify(user));store.recover([restored]);
  assert.equal(store.report(restored,'m').operations[0].status,'interrupted');assert.equal(store.report(restored,'m').operations[0].events.at(-1).code,'ORDER_OPERATION_INTERRUPTED');
  assert.equal(store.report(restored,'other').operations.length,0);assert.equal(store.report({id:'foreign',settings:{},monitors:[{id:'m'}]},'m').operations.length,0);
  const legacy=fixture();legacy.orderTasks[0].result={status:'uncertain',error:'failed',trace:[{action:'提交',detail:'cookie-private-value'}]};
  const report=store.report(legacy,'m');assert.equal(report.operations.length,0);assert.equal(report.previousResults[0].result.status,'uncertain');assert.ok(!JSON.stringify(report).includes('cookie-private-value'));
});
test('诊断日志存盘失败不改变执行结果，错误和页面摘要不包含输入值',()=>{
  const user=fixture(),store=createOrderExecutionLogs({persist:()=>{throw new Error('disk full');}});
  const log=store.start(user,'m',{kind:'execute'});assert.doesNotThrow(()=>log.finish('paid',{result:{status:'paid',invoiceId:'42'}}));assert.equal(store.report(user,'m').operations[0].result.receipt.invoiceId,'42');
  assert.equal(diagnosticError(new Error('x'.repeat(10000))).message.length,3000);assert.ok(diagnosticError(new Error('test')).stack.length<=6000);
  assert.deepEqual(diagnosticPage({elements:[{tag:'input',id:'field',value:'secret',options:['secret']}]}).controls,[{tag:'input',id:'field'}]);
});
test('Shadowsocks 节点、密码及编码认证信息不会出现在日志里',()=>{
  const user=fixture(),password='ss-private-password',node=buildShadowsocksUrl({server:'node.example',port:8388,method:'aes-256-gcm',password}),store=createOrderExecutionLogs({sourceOptions:()=>({proxyUrl:node})});
  const log=store.start(user,'m',{kind:'generate'});log.event('代理认证失败',{detail:node+' '+password+' '+Buffer.from('aes-256-gcm:'+password).toString('base64url')});log.finish('failed');const text=JSON.stringify(store.report(user,'m'));assert.ok(!text.includes(password));assert.ok(!text.includes(node));assert.ok(!text.includes(Buffer.from('aes-256-gcm:'+password).toString('base64url')));assert.equal(store.report(user,'m').operations[0].network.type,'shadowsocks');
});

test('新版导出包含上海时间、请求及失败摘要，事件名称不被计划动作覆盖',()=>{
  const user=fixture(),store=createOrderExecutionLogs(),log=store.start(user,'m',{kind:'discover'});
  log.event('AI 请求开始',{requestId:'request-1',stage:'页面规划',attempt:1});
  log.event('AI 请求超时，重新请求',{requestId:'request-1',stage:'页面规划',attempt:1});
  log.event('AI 请求开始',{requestId:'request-1',stage:'页面规划',attempt:2});
  log.event('动态计划',{action:'click',reason:'进入配置',sequence:999,at:'2026-10-07T16:00:00.000Z'});
  const failure=Object.assign(new Error('定位失败'),{code:'AGENT_ELEMENT_MISSING',stage:'页面规划',timeoutMs:120000,locatorAttempts:[{strategy:'aria',matchCount:2,outcome:'ambiguous'}]});
  log.event('动态步骤失败',{step:3,error:diagnosticError(failure),recovery:{allowed:true}});
  log.event('重新观察并修复',{attempt:1});log.finish('failed',{error:failure});
  const report=store.report(user,'m'),operation=report.operations[0];
  assert.equal(report.schemaVersion,2);assert.equal(report.timeZone,'Asia/Shanghai');assert.match(report.exportedAt,/\+08:00$/);
  for(const event of operation.events){assert.match(event.at,/\+08:00$/);assert.equal(typeof event.operationElapsedMs,'number');assert.ok(event.level);}
  const planned=operation.events.find(event=>event.action==='动态计划');assert.equal(planned.stepAction,'click');assert.notEqual(planned.sequence,999);assert.equal(planned.sourceAt,'2026-10-08T00:00:00.000+08:00');
  assert.equal(operation.diagnostics.aiAttempts,2);assert.equal(operation.diagnostics.aiRequests,1);assert.equal(operation.diagnostics.aiTimeouts,1);assert.equal(operation.diagnostics.recoveryAttempts,1);
  assert.equal(operation.diagnostics.lastFailure.error.code,'AGENT_ELEMENT_MISSING');assert.equal(operation.diagnostics.lastFailure.error.timeoutMs,120000);assert.equal(operation.diagnostics.lastFailure.error.locatorAttempts[0].outcome,'ambiguous');
});
test('详细日志超过 500 条时完整导出已保留事件并含最终结果',()=>{
  const user=fixture(),store=createOrderExecutionLogs(),log=store.start(user,'m',{kind:'discover'});
  for(let i=0;i<700;i++)log.event('步骤',{step:i});
  log.finish('prepared',{result:{status:'prepared',review:{total:10,currency:'USD'}}});
  const report=store.report(user,'m'),operation=report.operations[0];
  assert.equal(operation.events.length,user.orderExecutionLogs[0].events.length);assert.equal(operation.events.length,702);
  assert.equal(operation.events.at(-1).action,'操作结束');assert.equal(operation.diagnostics.droppedEvents,0);assert.equal(report.retention.maxEventsPerOperation,1200);assert.equal(report.retention.maxBytesPerOperation,512*1024);
});
test('AI 诊断摘要保留页面规模和语义计划，不记录页面 HTML、输入值或图片',()=>{
  const messages=[{role:'system',content:'planner'},{role:'user',content:[{type:'text',text:JSON.stringify({page:{url:'https://shop.example/product',title:'Product',html:'private-page-value',text:'private-text-value',elements:[{value:'private-input-value'}]},history:[{}],context:{submissionStarted:false,credentials:{password:'private-password'}}})},{type:'image_url',image_url:{url:'data:image/png;base64,private-image'}}]}];
  const input=diagnosticAIInput(messages),output=diagnosticAIOutput({action:'fill',reason:'填写数量',target:{meaning:'quantity',ref:'e1',confidence:0.95},value:'private-fill-value'});
  assert.equal(input.imageCount,1);assert.equal(input.page.elementCount,1);assert.equal(input.page.htmlChars,18);assert.equal(output.target.ref,'e1');assert.equal(output.valueLength,18);
  for(const secret of ['private-page-value','private-text-value','private-input-value','private-password','private-image','private-fill-value'])assert.ok(!JSON.stringify({input,output}).includes(secret));
  assert.doesNotThrow(()=>diagnosticAIOutput({configuration:'malformed',bindings:null}));
});
