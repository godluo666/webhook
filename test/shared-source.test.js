import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createSharedSourceReader } from '../lib/shared-source.js';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve=yes; reject=no; }); return {promise, resolve, reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const url = 'https://shop.example/stock';
const options = {userId:'alice', mode:'browser', proxyUrl:'http://u:secret@proxy.example:80'};

test('overlapping reads use one snapshot; the next check reads fresh content', async () => {
  const gate=deferred(); let reads=0;
  const read=createSharedSourceReader(async()=>{reads++;await gate.promise;return {body:'stock-'+reads,metadata:{attempts:[{method:'browser'}]}};});
  const requests=Array.from({length:16},()=>read(url,options));
  await tick(); assert.equal(reads,1); assert.equal(read.active,1); gate.resolve();
  const snapshots=await Promise.all(requests);
  assert.equal(read.active,0); assert.ok(snapshots.every(result=>result.body==='stock-1'));
  snapshots[0].metadata.attempts[0].method='changed';
  assert.equal(snapshots[1].metadata.attempts[0].method,'browser');
  assert.equal((await read(url,options)).body,'stock-2'); assert.equal(reads,2);
});

test('users, URLs, proxy credentials, methods, JSON and direct routing stay isolated', async () => {
  const gate=deferred();let reads=0;
  const read=createSharedSourceReader(async()=>{reads++;await gate.promise;return {body:'ok'};});
  const requests=[
    read(url,options),read(url,{...options}),
    read(url,{...options,userId:'bob'}),
    read(url+'/other',options),
    read(url,{...options,proxyUrl:'http://u:different@proxy.example:80'}),
    read(url,{...options,mode:'http'}),
    read(url,{...options,expectsJson:true}),
    read(url,{...options,direct:true}),
    read(url,{...options,proxyIdentity:'another-bridge'})
  ];
  await tick();assert.equal(reads,8);gate.resolve();await Promise.all(requests);assert.equal(read.active,0);
});

test('canceling a preview does not cancel another monitor sharing its read', async () => {
  const gate=deferred(),first=new AbortController(),second=new AbortController();let workSignal;
  const read=createSharedSourceReader(async(_url,{signal})=>{workSignal=signal;await gate.promise;return {body:'available'};});
  const canceled=read(url,{...options,signal:first.signal});
  const remaining=read(url,{...options,signal:second.signal});
  await tick();first.abort();await assert.rejects(canceled,error=>error.name==='AbortError');
  assert.equal(workSignal.aborted,false);assert.equal(read.active,1);
  assert.equal(getEventListeners(first.signal,'abort').length,0);
  gate.resolve();assert.equal((await remaining).body,'available');
  assert.equal(getEventListeners(second.signal,'abort').length,0);assert.equal(read.active,0);
});

test('canceling all consumers aborts the read, and a new request can start immediately', async () => {
  let reads=0;const signals=[];
  const read=createSharedSourceReader((_url,{signal})=>{reads++;signals.push(signal);return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
  const first=new AbortController(),second=new AbortController();
  const a=read(url,{...options,signal:first.signal}),b=read(url,{...options,signal:second.signal});
  const settled=Promise.allSettled([a,b]);await tick();first.abort();second.abort();await settled;
  assert.equal(signals[0].aborted,true);assert.equal(read.active,0);
  const next=new AbortController(),c=read(url,{...options,signal:next.signal});
  await tick();assert.equal(reads,2);assert.equal(read.active,1);
  next.abort();await assert.rejects(c);assert.equal(read.active,0);
  assert.throws(()=>read(url,{...options,signal:next.signal}),error=>error.name==='AbortError');
  await tick();assert.equal(reads,2);
});

test('shared failures remain independent and are not reused by a later attempt', async () => {
  const gate=deferred();let reads=0;
  const failure=Object.assign(new Error('temporary failure'),{code:'SOURCE_CHALLENGE',fetchDetails:{attempts:[{outcome:'challenge'}]}});
  const read=createSharedSourceReader(async()=>{reads++;await gate.promise;throw failure;});
  const requests=Promise.allSettled([read(url,options),read(url,options)]);
  await tick();gate.resolve();const [a,b]=await requests;
  assert.equal(reads,1);assert.notEqual(a.reason,b.reason);assert.equal(a.reason.code,'SOURCE_CHALLENGE');
  a.reason.fetchDetails.attempts[0].outcome='changed';a.reason.last_test_result={rule:'first'};
  assert.equal(b.reason.fetchDetails.attempts[0].outcome,'challenge');assert.equal(b.reason.last_test_result,undefined);
  await assert.rejects(read(url,options));assert.equal(reads,2);assert.equal(read.active,0);
});

test('sharing bookkeeping is bounded, and anonymous reads are never shared', async () => {
  const gate=deferred();let reads=0;
  const read=createSharedSourceReader(async()=>{reads++;await gate.promise;return {body:'ok'};},{maxEntries:1,maxConsumers:2});
  const requests=[read(url,options),read(url,options),read(url,options),read(url+'/2',options),read(url,{}),read(url,{})];
  await tick();assert.equal(read.active,1);assert.equal(reads,5);
  gate.resolve();await Promise.all(requests);assert.equal(read.active,0);
});
