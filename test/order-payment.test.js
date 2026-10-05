import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaymentMethod, paymentMatchesIntent, paymentBrand } from '../lib/order-payment.js';
import { validateOrderTask, orderProgramHash } from '../lib/orders.js';

test('付款方式按实际可读名称识别中外文，不将 credit card 或 PayPal Credit 误认为余额',()=>{
 const balance={kind:'balance',name:'账户余额'};
 for(const label of ['Account Balance','账户余额','Guthaben','Solde du compte','Saldo','アカウント残高'])assert.equal(paymentMatchesIntent(label,balance),true,label);
 for(const label of ['Credit Card','PayPal Credit','支付宝','pay_with_balance'])assert.equal(paymentMatchesIntent(label,balance),false,label);
 for(const label of ['Alipay','支付宝','支付寶'])assert.equal(paymentMatchesIntent(label,{kind:'website',name:'支付宝'}),true,label);
 assert.equal(paymentBrand('Credit Card'),'card');assert.equal(paymentBrand('PayPal Credit'),'paypal');
 assert.equal(paymentMatchesIntent('LOCAL Wallet',{kind:'website',name:'Local wallet'}),true);
 assert.equal(paymentMatchesIntent('Another wallet',{kind:'website',name:'Local wallet'}),false);
 assert.equal(paymentMatchesIntent('gateway_a17',{kind:'website',name:'支付宝'}),false,'Opaque values alone are not evidence');
});

test('付款方式和真实试跑选择均参与授权，变更不能沿用原代码审批',()=>{
 const task=validateOrderTask({url:'https://shop.example/product',monitorId:'a',quantity:1,maxTotal:20,executionMode:'pay',paymentMethod:{kind:'website',name:'支付宝'}});
 const before=orderProgramHash(task);task.paymentMethod={kind:'website',name:'PayPal'};assert.notEqual(orderProgramHash(task),before);
 const next=orderProgramHash(task);task.verifiedPaymentMethod={kind:'website',label:'PayPal',value:'opaque_02'};assert.notEqual(orderProgramHash(task),next);
 for(const value of ['alipay',{}, {kind:'website',name:''},{kind:'website',name:'<script>'},{kind:'unknown',name:'PayPal'}])assert.throws(()=>normalizePaymentMethod(value));
 assert.deepEqual(normalizePaymentMethod(null),{kind:'balance',name:'账户余额'});
});
