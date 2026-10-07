import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesProductSelection} from '../lib/order-evidence.js';

test('补货状态不改变商品身份，但名称、规格和数量变化仍被拒绝',()=>{
 for(const [before,after] of [['Product A — Out of stock','Product A — In stock'],['套餐 A · 暂无库存','套餐 A · 有货']])assert.ok(matchesProductSelection(before,after));
 assert.equal(matchesProductSelection('In Stock Industries','Industries'),false);
 for(const [before,after] of [['Product A — Out of stock','Product B — In stock'],['VPS 1 GB 缺货','VPS 2 GB 有货'],['Out of stock','In stock'],['缺货','有货'],['USD 10 Product A 缺货','USD 20 Product A 有货']])assert.equal(matchesProductSelection(before,after),false);
});
