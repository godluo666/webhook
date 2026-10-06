import assert from 'node:assert/strict';
import test from 'node:test';
import {orderRequestKind,describeOrderRequest} from '../lib/order-request.js';

test('login return targets and unrelated query values are not transaction routes',()=>{
  for(const path of ['/clientarea.php?returnto=/cart.php?a=complete','/login?returnto=/pay?invoice=17','/account?next='+encodeURIComponent('/pay'),'/?note=/complete&token=/charge','/?a=complete-preview'])assert.equal(orderRequestKind('https://merchant.example'+path),null,path);
});
test('actual financial route actions, including encoded actions, remain protected',()=>{
  for(const path of ['/cart.php?a=complete','/api/submitorder','/place-order?token=secret','/cart.php?action=%63omplete','/cart.php?%61=complete'])assert.equal(orderRequestKind('https://merchant.example'+path),'submission',path);
  for(const path of ['/pay','/api/charge?invoice=1','/cart.php?action=processpayment','/cart.php?a=%70ay','/PAY/1','/cart.php?a=view&action=pay'])assert.equal(orderRequestKind('https://merchant.example'+path),'payment',path);
});
test('request diagnostics expose the route without credentials, invoice IDs or tokens',()=>{
  assert.equal(describeOrderRequest('POST','https://user:secret@merchant.example/cart.php?a=complete&token=private&invoice=17'),'POST /cart.php?a=complete');
  assert.equal(describeOrderRequest('GET','https://merchant.example/login?returnto=/pay?password=secret'),'GET /login');
  assert.equal(describeOrderRequest('POST','https://merchant.example/pay/'+'secret'.repeat(8)),'POST /pay/[已隐藏]');
});
