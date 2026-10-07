import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesProductSelection} from '../lib/order-evidence.js';

test('补货状态不改变商品身份，但名称、规格和数量变化仍被拒绝',()=>{
 for(const [before,after] of [['Product A — Out of stock','Product A — In stock'],['套餐 A · 暂无库存','套餐 A · 有货']])assert.ok(matchesProductSelection(before,after));
 assert.equal(matchesProductSelection('In Stock Industries','Industries'),false);
 for(const [before,after] of [['Product A — Out of stock','Product B — In stock'],['VPS 1 GB 缺货','VPS 2 GB 有货'],['Out of stock','In stock'],['缺货','有货'],['USD 10 Product A 缺货','USD 20 Product A 有货']])assert.equal(matchesProductSelection(before,after),false);
});

test('列表中的库存数量及购买按钮前的状态变化不改变型号，金额和配置仍必须相同',()=>{
 for(const [before,after] of [
  ['DS.CN.HK.BGP.V2 64G RAM 4 Available Order Now','DS.CN.HK.BGP.V2 64G RAM 3 Available Order Now'],
  ['DS.CN.HK.BGP.V2 64G RAM Out of stock Order Now','DS.CN.HK.BGP.V2 64G RAM 4 Available Order Now'],
  ['Product A 缺货 Order Now','Product A 有货 Order Now'],
  ['套餐 A 缺货 立即购买','套餐 A 有货 立即购买']
 ])assert.ok(matchesProductSelection(before,after),before);
 for(const [before,after] of [
  ['DS.CN.HK.BGP.V2 64G RAM 4 Available','DS.CN.HK.BGP.V3 64G RAM 3 Available'],
  ['DS.CN.HK.BGP.V2 64G RAM 4 Available','DS.CN.HK.BGP.V2 32G RAM 3 Available'],
  ['Product A USD 4 Available','Product A USD 3 Available'],
  ['Product A USD 4.50 Available','Product A USD 4.60 Available'],
  ['Product A $ 4 Available','Product A $ 3 Available'],
  ['4 Available','3 Available'],
  ['4 Available Order Now','3 Available Order Now'],
  ['Out of stock Order Now','In stock Order Now'],
  ['In Stock Industries Order Now','Industries Order Now']
 ])assert.equal(matchesProductSelection(before,after),false,before);
});
