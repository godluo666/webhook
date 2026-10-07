import test from 'node:test';
import assert from 'node:assert/strict';
import {runOrderWorkflow,runOrderPaymentCode,validateOrderWorkflow} from '../lib/order-workflow.js';
import {validateOrderProgram} from '../lib/orders.js';
import {validateOrderScript} from '../lib/order-script.js';
const checkout={submitSelector:'#submit',productSelector:'#product',quantitySelector:'#quantity',totalSelector:'#total',currencySelector:'#currency',confirmationSelector:'#confirmation'};
const program=(prepareCode='function(){return {ready:true};}',paymentCode='function(){return {checks:{paySelector:"#pay"}};}')=>validateOrderProgram({summary:'配置后由宿主按 SOP 核对提交',checkout,workflow:{version:1,prepareCode,paymentCode}},{requireWorkflow:true});
test('SOP 禁止商品准备脚本提交或付款，未就绪和歧义都停在财务操作前',async()=>{
 let commits=0;const methods={submit:async()=>{commits++;return {status:'ordered'};},pay:async()=>assert.fail('must not pay')};
 for(const source of ['function(o,b){return b.submit();}','function(o,b){return b.pay({});}','function(){return {ready:false};}','function(){return {error:"商品歧义"};}'])await assert.rejects(runOrderWorkflow(program(source),{executionMode:'pay'},methods));
 assert.equal(commits,0);assert.throws(()=>validateOrderWorkflow(null,{required:true}),/固定 SOP/);
});
test('SOP 试跑只核对，正式下单与关联账单付款按固定顺序各执行一次',async()=>{
 for(const dryRun of [true,false]){
  const calls=[];let invoice=false;
  const methods={submit:async checks=>{assert.deepEqual(checks,checkout);calls.push('submit');return {status:dryRun?'prepared':'ordered'};},exists:async()=>invoice,invoice:async()=>{calls.push('invoice');invoice=true;return {status:'ordered',invoiceId:'42'};},pay:async checks=>{assert.equal(checks.paySelector,'#pay');calls.push('pay');return {status:'paid'};}};
  const p=program(undefined,'function(o,b){if(!b.exists("#invoice"))return {invoiceLinkSelector:"#original-invoice"};return {checks:{paySelector:"#pay"}};}');
  const result=await runOrderWorkflow(p,{executionMode:'pay'},methods);assert.equal(result.status,dryRun?'prepared':'paid');assert.deepEqual(calls,dryRun?['submit']:['submit','invoice','pay']);
 }
});
test('只读付款定位不能提交、改商品或选择其他账户，重复账单链接不触发支付',async()=>{
 let payments=0,invoices=0;const methods={submit:async()=>assert.fail('must not submit'),fill:async()=>assert.fail('must not change product'),invoice:async()=>{invoices++;return {status:'ordered'};},pay:async()=>{payments++;}};
 for(const source of ['function(o,b){return b.submit();}','function(o,b){return b.fill("#item",2);}','function(){return {invoiceLinkSelector:"#invoice"};}'])await assert.rejects(runOrderPaymentCode(source,{},methods,{status:'ordered'}));
 assert.equal(payments,0);assert.equal(invoices,1);
});
test('SOP 的操作预算跨阶段共用，超量准备不会进入提交阶段',async()=>{
 let commits=0;const methods={text:async()=> 'ready',submit:async()=>{commits++;return {status:'ordered'};}};
 await assert.rejects(runOrderWorkflow(program('function(o,b){for(let i=0;i<10;i++)b.text("#item");return {ready:true};}'),{executionMode:'submit'},methods,{maxCalls:5}),/次数/);assert.equal(commits,0);
});

test('优惠码由宿主固定阶段应用后才提交；留空不应用、失败不下单，准备脚本无优惠写入权限',async()=>{
 const coupon={inputSelector:'#promo',applySelector:'#apply',appliedCodeSelector:'#applied',discountSelector:'#discount'};
 const p=validateOrderProgram({summary:'优惠后核对',checkout,coupon,workflow:{version:1,prepareCode:'function(){return {ready:true};}'}},{requireWorkflow:true});
 for(const couponCode of ['', 'Save20']){
  const calls=[];await runOrderWorkflow(p,{executionMode:'prepare',couponCode},{applyCoupon:async (fields,checks)=>{assert.deepEqual(fields,coupon);assert.deepEqual(checks,checkout);calls.push('coupon');},submit:async()=>{calls.push('review');return {status:'prepared'};}});
  assert.deepEqual(calls,couponCode?['coupon','review']:['review']);
 }
 await assert.rejects(runOrderWorkflow(p,{couponCode:'INVALID'},{applyCoupon:async()=>{throw new Error('优惠码无效');},submit:async()=>assert.fail('must not submit')}),/优惠码无效/);
 await assert.rejects(runOrderWorkflow(program('function(o,b){b.applyCoupon({});return {ready:true};}'),{couponCode:'SAVE20'},{applyCoupon:async()=>assert.fail('must not apply'),submit:async()=>assert.fail('must not submit')}));
});

test('优惠阶段使用准备代码返回的实时选择器，编译代码与固定流程保持相同顺序',async()=>{
 const dynamic={inputSelector:'#live-promo',applySelector:'#live-apply',appliedCodeSelector:'#live-applied',discountSelector:'#live-discount'};
 const p=program('function(){return {ready:true,coupon:'+JSON.stringify(dynamic)+'};}');
 for(const compiled of [false,true]){
  const calls=[],methods={applyCoupon:async(fields)=>{assert.deepEqual(fields,dynamic);calls.push('coupon');},submit:async()=>{calls.push('review');return {status:'prepared'};}};
  const {executeOrderScript}=await import('../lib/order-script.js');
  if(compiled)await executeOrderScript(p.code,{couponCode:'SAVE20',executionMode:'prepare'},methods);else await runOrderWorkflow(p,{couponCode:'SAVE20',executionMode:'prepare'},methods);
  assert.deepEqual(calls,['coupon','review']);
 }
});

test('零金额优惠订单保留确认结果，不运行付款定位或发起付款',async()=>{
 const receipt={status:'awaiting_payment',review:{total:0},paymentPending:{reason:'zero_total'}};
 const p=program('function(){return {ready:true};}','function(){throw new Error("must not locate payment");}');
 assert.deepEqual(await runOrderWorkflow(p,{executionMode:'pay'},{submit:async()=>receipt,pay:async()=>assert.fail('must not pay')}),receipt);
});
test('付款定位语法必须在准备和提交前通过，编译不执行函数体',async()=>{
 let prepared=0,submits=0;
 const p=program('function(o,b){b.text("#item");return {ready:true};}','function(){return {checks: ;}');
 await assert.rejects(runOrderWorkflow(p,{executionMode:'pay'},{text:async()=>prepared++,submit:async()=>submits++}),error=>error.code==='ORDER_SCRIPT_INVALID');
 assert.equal(prepared,0);assert.equal(submits,0);
 await validateOrderScript('function(){while(true){} return {}; }');
 for(const code of ['async function(){return {};}', '(function(){throw new Error("must not execute");})()', 'function(){throw new Error("must not execute");}()', 'function(){}.call(null)', 'function(){},function(){}', 'function(){return ; ; ; broken( }'])await assert.rejects(validateOrderScript(code),error=>error.code==='ORDER_SCRIPT_INVALID');
});
test('明确缺货在商品准备阶段返回等待状态，不调用提交或付款',async()=>{
 let submits=0;
 await assert.rejects(runOrderWorkflow(program('function(){return {status:"out_of_stock"};}'),{executionMode:'pay'},{submit:async()=>submits++}),error=>error.code==='ORDER_OUT_OF_STOCK');
 assert.equal(submits,0);
});
