import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePressure,parseCounters,cpuDelta} from '../lib/diagnostics.js';
test('诊断区分 CPU 工作、I/O 等待和宿主抢占且不重复累计 guest',()=>{
 assert.deepEqual(cpuDelta('cpu 10 0 10 50 20 0 0 10 8 0','cpu 20 0 20 110 30 0 0 20 18 0'),{busyPercent:20,ioWaitPercent:10,stealPercent:10});
 assert.equal(cpuDelta(null,null),null);
});
test('解析内核压力与容器事件计数，缺少指标不伪造数据',()=>{
 assert.deepEqual(parsePressure('some avg10=2.50 avg60=1.00 avg300=0.1 total=42\nfull avg10=0.00 total=0'),{some:{avg10:2.5,avg60:1,avg300:0.1,total:42},full:{avg10:0,total:0}});
 assert.deepEqual(parsePressure(null),{});assert.deepEqual(parseCounters('nr_throttled 5\nusage_usec 42\nmax'),{nr_throttled:5,usage_usec:42});
});
