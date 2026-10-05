import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserSlots} from '../lib/browser-slots.js';
test('交互浏览器有上限并为触发下单保留容量，释放幂等',()=>{
 const slots=createBrowserSlots(),a=slots.acquire(),b=slots.acquire();
 assert.throws(()=>slots.acquire(),error=>error.code==='ORDER_BROWSER_BUSY');
 const c=slots.acquire(true);assert.equal(slots.active,3);const d=slots.acquire(true);assert.equal(slots.active,4);assert.throws(()=>slots.acquire(true));d();
 c();c();assert.equal(slots.active,2);a();b();assert.equal(slots.active,0);assert.equal(slots.background,0);
 const again=slots.acquire();again();assert.equal(slots.active,0);
});

test('保存后的操作等待正在关闭的浏览器，无重复启动；取消立即移除等待',async()=>{
 const slots=createBrowserSlots({max:1,backgroundMax:1}),first=slots.acquire();first.closing();
 const pending=slots.acquireWhenClosing();assert.equal(slots.waiting,1);first();const next=await pending;assert.equal(slots.active,1);assert.equal(slots.waiting,0);
 next.closing();const controller=new AbortController(),cancelled=slots.acquireWhenClosing(false,{signal:controller.signal});controller.abort();await assert.rejects(cancelled);assert.equal(slots.waiting,0);next();assert.equal(slots.active,0);
});

test('两个登录窗口与一次恢复校验可以并存，仍保留真实下单容量且校验不叠加',async()=>{
 const slots=createBrowserSlots(),a=slots.acquire(),b=slots.acquire(),proof=slots.acquire(false,{verification:true});
 const financial=slots.acquire(true);assert.equal(slots.active,4);assert.throws(()=>slots.acquire(true));
 const queued=slots.acquireWhenClosing(false,{verification:true});assert.equal(slots.waiting,1);proof();const secondProof=await queued;assert.equal(slots.active,4);assert.equal(slots.waiting,0);
 secondProof();financial();a();b();assert.equal(slots.active,0);assert.equal(slots.background,0);
});
