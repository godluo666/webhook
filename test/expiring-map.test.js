import {createElementPreview,selectedElements,discardElementPreview} from '../lib/element-picker.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ExpiringMap} from '../lib/expiring-map.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('闲置时自动释放过期缓存与定时器，不等待下一次请求',async()=>{
 const cache=new ExpiringMap({ttlMs:20,maxEntries:3});cache.set('preview',{body:'large preview'});assert.equal(cache.size,1);await pause(60);assert.equal(cache.size,0);assert.equal(cache.deadlines.size,0);assert.equal(cache.timer,null);
});
test('缓存限制容量，刷新条目保留新期限，删除或清空立即释放定时器',async()=>{
 const cache=new ExpiringMap({ttlMs:100,maxEntries:3});for(let i=0;i<100;i++)cache.set(i,{id:i});assert.equal(cache.size,3);assert.equal(cache.deadlines.size,3);assert.equal(cache.has(0),false);cache.delete(97);cache.delete(98);cache.delete(99);assert.equal(cache.timer,null);cache.set('a',1);cache.clear();assert.equal(cache.timer,null);assert.equal(cache.deadlines.size,0);
 let now=1000;const absolute=new ExpiringMap({expiresAt:item=>item.expiresAt,maxEntries:2,now:()=>now});absolute.set('old',{expiresAt:1040});const firstTimer=absolute.timer;now=1020;absolute.set('old',{expiresAt:1100});assert.notEqual(absolute.timer,firstTimer);now=1050;absolute.prune();assert.equal(absolute.has('old'),true);now=1100;absolute.prune();assert.equal(absolute.size,0);assert.equal(absolute.timer,null);absolute.clear();
});


test('关闭网页预览立即释放可选区域；其他账户不能释放它，重复关闭无副作用',()=>{
 const preview=createElementPreview('owner','https://shop.example/product','<h1 id="name">Product A</h1>');assert.ok(selectedElements('owner',preview.id,[0]).length);
 assert.equal(discardElementPreview('other',preview.id),false);assert.ok(selectedElements('owner',preview.id,[0]).length);
 assert.equal(discardElementPreview('owner',preview.id),true);assert.throws(()=>selectedElements('owner',preview.id,[0]),/已失效/);assert.equal(discardElementPreview('owner',preview.id),false);
});


test('在遍历期间刷新缓存遵守 Map 的原位更新语义，不重复迭代或占满 CPU',()=>{
 const cache=new ExpiringMap({ttlMs:10000});cache.set('a',1);cache.set('b',2);let visits=0;
 for(const [key,value]of cache){if(++visits>2)throw new Error('Iteration repeated');cache.set(key,value+1);}
 assert.equal(visits,2);assert.deepEqual([...cache],[['a',2],['b',3]]);cache.clear();
});
