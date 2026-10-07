import test from 'node:test';
import assert from 'node:assert/strict';
import {replayOrderPayment} from '../lib/order-replay.js';

const fixture=()=>({
  paymentCode:'function(o,b){if(b.exists("#invoice-link"))return {invoiceLinkSelector:"#invoice-link"};return {checks:{paySelector:"#pay",invoiceSelector:"#invoice",totalSelector:"#total",currencySelector:"#currency",confirmationSelector:"#paid"}};}',
  order:{maxTotal:20},receipt:{status:'ordered',invoiceId:'42',review:{total:10,currency:'USD'}},
  pages:[{url:'https://merchant.test/confirmed',html:'<a id="invoice-link" href="/invoice?id=42">Invoice</a>'},{url:'https://merchant.test/invoice?id=42',html:'<form action="https://never-contact.invalid/pay"><input id="invoice" name="invoiceid" value="42"><p id="total">USD 10.00</p><p id="currency">USD</p><button id="pay">Pay</button></form><script>throw new Error("must not run")</script>'}],
  confirmationPage:{url:'https://merchant.test/paid',html:'<p id="paid">Payment successful</p>'}
});
test('缺货时离线回放订单页与账单定位，不执行网页脚本或付款请求',async()=>{
  const result=await replayOrderPayment(fixture());assert.equal(result.status,'replayed');assert.equal(result.invoicePages,2);assert.equal(result.financialRequests,0);assert.equal(result.livePaymentVerified,false);assert.equal(result.confirmationSelector,'matched');
});
test('回放拒绝付款代码越权、错误账单、价格变化及未匹配的付款结果',async()=>{
  for(const mutate of [f=>f.paymentCode='function(o,b){return b.submit();}',f=>f.receipt.invoiceId='43',f=>f.receipt.review.total=11,f=>f.order.maxTotal=5,f=>delete f.order.maxTotal,f=>f.order.maxTotal='20',f=>f.confirmationPage.html='<p id="changed">Paid</p>',f=>f.confirmationPage.url='https://foreign.test/paid',f=>f.pages[1].url='https://foreign.test/invoice?id=42']){
    const input=fixture();mutate(input);await assert.rejects(replayOrderPayment(input));
  }
});
