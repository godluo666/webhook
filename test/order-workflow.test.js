import test from 'node:test';
import assert from 'node:assert/strict';
import {runOrderWorkflow,runOrderPaymentCode,validateOrderWorkflow} from '../lib/order-workflow.js';
import {validateOrderProgram} from '../lib/orders.js';
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
