import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../lib/store.js';
test('内容相同的存盘不重写文件，订单提交记录仍立即写入磁盘',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radar-store-'));t.after(()=>{assert.ok(dir.startsWith(os.tmpdir()+path.sep)&&path.basename(dir).startsWith('radar-store-'));fs.rmSync(dir,{recursive:true,force:true});});
 const store=createStore(dir),file=path.join(dir,'state.json');const marker=new Date('2001-01-01T00:00:00Z');fs.utimesSync(file,marker,marker);
 store.persist();store.persist();assert.equal(fs.statSync(file).mtimeMs,marker.getTime());
 store.state.users.push({orderTasks:[{submissionStartedAt:'durable-before-POST'}]});store.persist();assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).users[0].orderTasks[0].submissionStartedAt,'durable-before-POST');
});
