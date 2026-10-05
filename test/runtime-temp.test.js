import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {configureRuntimeTemp} from '../lib/runtime-temp.js';
test('优先使用私有临时目录，只读旧编排安全回退到数据卷，探测目录立即释放',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radar-runtime-temp-'));t.after(()=>{assert.ok(dir.startsWith(os.tmpdir()+path.sep)&&path.basename(dir).startsWith('radar-runtime-temp-'));fs.rmSync(dir,{recursive:true,force:true});});
 const env={MONITOR_TEMP_DIR:path.join(dir,'ram')};assert.equal(configureRuntimeTemp(dir,{env}),env.MONITOR_TEMP_DIR);assert.deepEqual(fs.readdirSync(env.MONITOR_TEMP_DIR),[]);assert.equal(env.TMPDIR,env.MONITOR_TEMP_DIR);
 const old={MONITOR_TEMP_DIR:path.join(dir,'readonly')};const filesystem={...fs,mkdirSync:(target,options)=>{if(target===old.MONITOR_TEMP_DIR)throw Object.assign(new Error('Read-only'),{code:'EROFS'});return fs.mkdirSync(target,options);}};
 assert.equal(configureRuntimeTemp(dir,{env:old,filesystem}),path.join(dir,'browser-tmp'));assert.deepEqual(fs.readdirSync(old.MONITOR_TEMP_DIR),[]);
});
