import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserSlots} from '../lib/browser-slots.js';
test('交互浏览器有上限并为触发下单保留容量，释放幂等',()=>{
 const slots=createBrowserSlots(),a=slots.acquire(),b=slots.acquire();
 assert.throws(()=>slots.acquire(),error=>error.code==='ORDER_BROWSER_BUSY');
 const c=slots.acquire(true);assert.equal(slots.active,3);assert.throws(()=>slots.acquire(true));
 c();c();assert.equal(slots.active,2);a();b();assert.equal(slots.active,0);assert.equal(slots.background,0);
 const d=slots.acquire();d();assert.equal(slots.active,0);
});

test('保存后的操作等待正在关闭的浏览器，无重复启动；取消立即移除等待',async()=>{
 const slots=createBrowserSlots({max:1,backgroundMax:1}),first=slots.acquire();first.closing();
 const pending=slots.acquireWhenClosing();assert.equal(slots.waiting,1);first();const next=await pending;assert.equal(slots.active,1);assert.equal(slots.waiting,0);
 next.closing();const controller=new AbortController(),cancelled=slots.acquireWhenClosing(false,{signal:controller.signal});controller.abort();await assert.rejects(cancelled);assert.equal(slots.waiting,0);next();assert.equal(slots.active,0);
});
