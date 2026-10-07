import test from 'node:test';
import assert from 'node:assert/strict';
import {LOG_TIME_ZONE,shanghaiTimestamp,shanghaiLogTimes} from '../lib/log-time.js';
test('上海时间保留毫秒和绝对时间，UTC 跨日与已带偏移时间一致',()=>{
  assert.equal(LOG_TIME_ZONE,'Asia/Shanghai');
  for(const value of ['2026-10-07T16:12:34.567Z','2026-10-08T00:12:34.567+08:00',new Date('2026-10-07T16:12:34.567Z')]){
    assert.equal(shanghaiTimestamp(value),'2026-10-08T00:12:34.567+08:00');
    assert.equal(Date.parse(shanghaiTimestamp(value)),Date.parse('2026-10-07T16:12:34.567Z'));
  }
  assert.equal(shanghaiTimestamp('invalid'),null);
});
test('旧日志导出递归转换时间但不改原记录、业务值或错误正文',()=>{
  const original={startedAt:'2026-10-07T16:00:00.000Z',events:[{at:'2026-10-07T16:00:01.123Z',value:'2026-10-07T16:00:00.000Z'}],result:{paymentStartedAt:'2026-10-07T16:00:02.000Z'},message:'2026-10-07T16:00:00.000Z',invalidAt:'bad'};
  const converted=shanghaiLogTimes(original);
  assert.equal(converted.events[0].at,'2026-10-08T00:00:01.123+08:00');
  assert.equal(converted.result.paymentStartedAt,'2026-10-08T00:00:02.000+08:00');
  assert.equal(converted.events[0].value,original.events[0].value);assert.equal(converted.message,original.message);assert.equal(converted.invalidAt,'bad');
  assert.equal(original.events[0].at,'2026-10-07T16:00:01.123Z');
});
