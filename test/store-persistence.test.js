import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../lib/store.js';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radar-store-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return {dir,store:createStore(dir),block:()=>fs.mkdirSync(path.join(dir,'state.json.tmp')),unblock:()=>fs.rmdirSync(path.join(dir,'state.json.tmp'))};
}
test('内容相同的存盘不重写文件，订单提交记录仍立即写入磁盘',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radar-store-'));t.after(()=>{assert.ok(dir.startsWith(os.tmpdir()+path.sep)&&path.basename(dir).startsWith('radar-store-'));fs.rmSync(dir,{recursive:true,force:true});});
 const store=createStore(dir),file=path.join(dir,'state.json');const marker=new Date('2001-01-01T00:00:00Z');fs.utimesSync(file,marker,marker);
 store.persist();store.persist();assert.equal(fs.statSync(file).mtimeMs,marker.getTime());
 store.state.users.push({orderTasks:[{submissionStartedAt:'durable-before-POST'}]});store.persist();assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).users[0].orderTasks[0].submissionStartedAt,'durable-before-POST');
});

test('重启保留网站登录签名和完整下单会话；修改密码后旧 Cookie 持续失效',t=>{
 const {dir,store}=fixture(t),{user}=store.register('session-user','original-password-123',process.env.SIGNUP_CODE);
 const session={state:{cookies:[{name:'auth',value:'cookie-secret',domain:'shop.example',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'}],origins:[{origin:'https://shop.example',localStorage:[{name:'access',value:'local-secret'}],indexedDB:[{name:'auth-db',version:1,stores:[]}]}]},sessionStorage:{token:'session-secret'},check:{url:'https://shop.example/account'}};
 user.orderAccounts.push({monitorId:'monitor-a',loginUrl:'https://shop.example/login',revision:1,status:'saved',session});store.persist();
 const request={headers:{cookie:store.issueCookie(user).split(';')[0]}},reloaded=createStore(dir),restored=reloaded.userFromRequest(request);
 assert.equal(restored.id,user.id);assert.deepEqual(restored.orderAccounts[0].session,session);
 assert.equal(reloaded.userFromRequest({headers:{cookie:request.headers.cookie+'0'}}),null);
 const publicText=JSON.stringify(reloaded.publicWorkspace(restored));for(const secret of ['cookie-secret','local-secret','session-secret'])assert.ok(!publicText.includes(secret));
 reloaded.changePassword(restored,'original-password-123','replacement-password-456');
 assert.equal(reloaded.userFromRequest(request),null);assert.equal(createStore(dir).userFromRequest(request),null);
 const updatedRequest={headers:{cookie:reloaded.issueCookie(restored).split(';')[0]}};assert.equal(createStore(dir).userFromRequest(updatedRequest).id,user.id);
});

test('密码修改、恢复和恢复码轮换落盘失败时，原登录和恢复凭据仍有效',t=>{
 const f=fixture(t),{user,recoveryCode}=f.store.register('rollback-user','original-password-123',process.env.SIGNUP_CODE),previous=structuredClone(user);
 const request={headers:{cookie:f.store.issueCookie(user).split(';')[0]}};f.block();
 for(const change of [
  ()=>f.store.changePassword(user,'original-password-123','replacement-password-456'),
  ()=>f.store.recoverPassword(user.username,recoveryCode,'replacement-password-456'),
  ()=>f.store.rotateRecoveryCode(user,'original-password-123')
 ]){
  assert.throws(change,error=>error.code==='EISDIR');assert.deepEqual(user,previous);
  assert.equal(f.store.verifyLogin(user.username,'original-password-123'),user);assert.equal(f.store.verifyLogin(user.username,'replacement-password-456'),null);assert.equal(f.store.userFromRequest(request),user);
 }
 f.unblock();f.store.persist();assert.deepEqual(createStore(f.dir).state.users[0],previous);
 const recovered=f.store.recoverPassword(user.username,recoveryCode,'replacement-password-456');assert.equal(recovered.user,user);assert.equal(f.store.userFromRequest(request),null);
});

test('注册落盘失败不占用用户名，存储恢复后可以使用同一用户名注册',t=>{
 const f=fixture(t);f.block();assert.throws(()=>f.store.register('retry-user','original-password-123',process.env.SIGNUP_CODE),error=>error.code==='EISDIR');assert.equal(f.store.state.users.length,0);
 f.unblock();const {user}=f.store.register('retry-user','original-password-123',process.env.SIGNUP_CODE);assert.equal(createStore(f.dir).verifyLogin('retry-user','original-password-123').id,user.id);
});
