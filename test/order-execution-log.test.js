import test from 'node:test';
import assert from 'node:assert/strict';
import {buildShadowsocksUrl} from '../lib/shadowsocks.js';
import {createOrderExecutionLogs,diagnosticError,diagnosticPage} from '../lib/order-execution-log.js';

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
