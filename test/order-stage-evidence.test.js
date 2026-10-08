import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOrderQuantity,explicitOrderCurrency,sameOrderReview} from '../lib/order-evidence.js';
import {orderFailure} from '../lib/order-diagnostics.js';
import {inspectRequestStructure} from '../lib/order-request.js';
import {validateStep} from '../automation/agent/planner.js';
test('quantity and currency require explicit unambiguous evidence',()=>{
  assert.equal(parseOrderQuantity('Qty: 2'),2);assert.equal(parseOrderQuantity('数量：2 件'),2);
  assert.equal(parseOrderQuantity('2 × 3'),null);assert.equal(parseOrderQuantity(''),null);
  assert.equal(explicitOrderCurrency('$ 20'),null);assert.equal(explicitOrderCurrency('Currency: USD'), 'USD');
  assert.equal(explicitOrderCurrency('USD EUR'),null);
});
test('trial comparison normalizes configuration ordering without ignoring prices',()=>{
  const a={product:'Server A',quantity:2,total:10,currency:'USD',configuration:[{name:'RAM',value:'8 GB'},{name:'Region',value:'US'}]};
  assert.equal(sameOrderReview(a,{...a,configuration:a.configuration.toReversed()}),true);
  assert.equal(sameOrderReview(a,{...a,total:11}),false);
});
test('unknown financial outcome cannot be recoverable',()=>{
  const diagnostic=orderFailure({code:'AGENT_ELEMENT_MISSING'},{submissionStarted:true});
  assert.equal(diagnostic.category,'hard_stop');assert.equal(diagnostic.retryAllowed,false);
  assert.equal(orderFailure({code:'ORDER_CONTRACT_UNVERIFIED'}).category,'needs_input');
});
test('AJAX candidate exposes structure not credentials or body values',()=>{
  const result=inspectRequestStructure({headers:()=>({'content-type':'application/json'}),postData:()=>JSON.stringify({quantity:2,csrf:'secret'}),method:()=>'POST',url:()=>'https://example.test/checkout?token=secret'});
  assert.equal(result.valid,true);assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes('csrf'));
});
test('configuration and bounded wait are separate planning actions',()=>{
  assert.equal(validateStep({action:'configure',reason:'continue current configuration'}).action,'configure');
  assert.equal(validateStep({action:'wait',reason:'settle current page',value:200}).action,'wait');
});
