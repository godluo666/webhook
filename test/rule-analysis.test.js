import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuleService } from '../lib/rule-service.js';
const url='https://shop.example/product',endpoint='https://shop.example/api/stock';
const body='<html><body><main data-stock-api="/api/stock"><h1>Product</h1><p>Out of stock</p></main></body></html>';
const payload='{"product":{"sku":"PRODUCT","available":false,"price":10}}';
const sourceOptions=()=>({userId:'alice'});
test('browser API responses that already yielded candidates are not probed again',async()=>{
 const reads=[];const service=createRuleService({sourceOptions,fetchSource:async target=>{
  reads.push(target);return {body,status:200,metadata:{method:'browser'},apiResponses:[{url:endpoint,method:'GET',body:payload}]};
 }});
 const analysis=await service.analyze({id:'alice'},url,{}, {browser:true});
 assert.deepEqual(reads,[url]);
 assert.ok(analysis.candidates.some(candidate=>candidate.detection_method==='api'&&candidate.extraction_rule.endpoint===endpoint));
});
test('missing or malformed captured APIs are still checked before becoming candidates',async()=>{
 for(const apiResponses of [[],[{url:endpoint,method:'GET',body:'not JSON'}],[{url:endpoint,method:'POST',body:payload}]]){
  const reads=[];const service=createRuleService({sourceOptions,fetchSource:async target=>{
   reads.push(target);return target===url?{body,status:200,metadata:{method:'browser'},apiResponses}:{body:payload,status:200,metadata:{method:'http'}};
  }});
  const analysis=await service.analyze({id:'alice'},url);
  assert.deepEqual(reads,[url,endpoint]);
  assert.ok(analysis.candidates.some(candidate=>candidate.detection_method==='api'));
 }
});
