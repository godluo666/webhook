import test from 'node:test';
import assert from 'node:assert/strict';
import {browserOperation,settledBrowserRead} from '../lib/browser-operation.js';
test('无自带超时的 Cookie/CDP 操作会被有界中断并清理，迟到结果无作用',async()=>{
 let cleaned=0;await assert.rejects(browserOperation(()=>new Promise(()=>{}),{timeoutMs:20,code:'SOURCE_BROWSER_TIMEOUT',message:'Cookie restore timed out',onTimeout:()=>cleaned++}),error=>error.code==='SOURCE_BROWSER_TIMEOUT');await new Promise(resolve=>setImmediate(resolve));assert.equal(cleaned,1);
});
test('只重试跳转打断的读取，其他错误不重试，超时之后停止后台轮询',async()=>{
 let reads=0;assert.equal(await settledBrowserRead(async()=>{if(++reads===1)throw new Error('Execution context was destroyed');return 'fresh document';},{timeoutMs:200}),'fresh document');assert.equal(reads,2);
 let errors=0;await assert.rejects(settledBrowserRead(()=>{errors++;throw new Error('authentication failed');},{timeoutMs:100}),/authentication/);assert.equal(errors,1);
 let loops=0;await assert.rejects(settledBrowserRead(()=>{loops++;throw new Error('Cannot find context');},{timeoutMs:70}),/超时/);const ended=loops;await new Promise(resolve=>setTimeout(resolve,100));assert.equal(loops,ended);
});
test('取消 CDP 读取后立即传播取消原因，不重新启动操作',async()=>{
 const controller=new AbortController();let calls=0;const pending=browserOperation(()=>{calls++;return new Promise(()=>{});},{signal:controller.signal,timeoutMs:1000});controller.abort(new Error('user closed login'));await assert.rejects(pending,/user closed login/);assert.equal(calls,1);
});
