import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {createEvidenceStore} from '../automation/logs/evidence.js';
import {createSiteMemory} from '../automation/agent/memory.js';
test('探索、网站经验与证据 HTTP API 保留登录鉴权及用户/任务隔离',{timeout:20000},async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),'commerce-api-'));
  const merchant=http.createServer((_req,res)=>res.end('<p>Stock ready</p>'));
  await new Promise(resolve=>merchant.listen(0,'127.0.0.1',resolve));
  const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const child=spawn(process.execPath,['server.js'],{cwd:process.cwd(),windowsHide:true,stdio:'ignore',env:{...process.env,DATA_DIR:folder,PORT:String(port),HOST:'127.0.0.1',RESEND_API_KEY:'',MAIL_FROM:'',SIGNUP_CODE:''}});
  const base='http://127.0.0.1:'+port;
  const call=async(url,method='GET',body,cookie)=>fetch(base+url,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});
  try{
    for(let i=0;i<100;i++){try{if((await call('/api/auth/status')).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,30));}
    assert.equal((await call('/api/order-tasks/missing/profile')).status,401);
    const register=await call('/api/auth/register','POST',{username:'agent-api-a',password:'strong-test-password-123'});
    assert.equal(register.status,201);const cookie=register.headers.get('set-cookie').split(';')[0],state=await (await call('/api/state','GET',undefined,cookie)).json();
    const url='http://127.0.0.1:'+merchant.address().port+'/product';
    const settings=await call('/api/settings','PUT',{webhooks:[{id:'local-test',name:'Local fixture',url,enabled:true}]},cookie);assert.equal(settings.status,200);
    const createdMonitor=await call('/api/monitors','POST',{kind:'webpage',label:'Commerce API',url,keyword:'Stock',mode:'contains',intervalMinutes:60,webhookIds:['local-test']},cookie);
    assert.equal(createdMonitor.status,201,await createdMonitor.clone().text());
    const monitorId=(await createdMonitor.json()).monitors[0].id;
    const createdTask=await call('/api/order-tasks','POST',{url,monitorId,product:'Product A',quantity:1,maxTotal:20,currency:'USD',executionMode:'prepare'},cookie);
    assert.equal(createdTask.status,201);const task=(await createdTask.json()).task;
    assert.equal((await call('/api/order-tasks/'+task.id)).status,401);
    const details=await (await call('/api/order-tasks/'+task.id,'GET',undefined,cookie)).json();assert.equal(details.task.id,task.id);assert.equal(details.task.credentials,undefined);
    assert.deepEqual(await (await call('/api/order-tasks/'+task.id+'/profile','GET',undefined,cookie)).json(),{profile:null});
    const discover=await call('/api/order-tasks/'+task.id+'/discover','POST',{},cookie);assert.equal(discover.status,400);assert.match((await discover.json()).error,/登录|账户/);
    const background=await call('/api/order-tasks/'+task.id+'/generate','POST',{background:true},cookie);assert.equal(background.status,400);assert.match((await background.json()).error,/登录|账户/);
    const profile=createSiteMemory({directory:path.join(folder,'automation','profiles')});
    await profile.record(state.user.id+':'+monitorId,url,{status:'prepared',history:[{action:'review',pageType:'checkout',meanings:['submit_order'],verified:true}]});
    const loaded=await (await call('/api/order-tasks/'+task.id+'/profile','GET',undefined,cookie)).json();assert.equal(loaded.profile.origin,new URL(url).origin);
    const store=createEvidenceStore({directory:path.join(folder,'automation','logs')});
    const saved=await store.save(state.user.id+':'+task.id,{stage:'review',observation:{url},image:'data:image/png;base64,AA=='});
    const endpoint='/api/order-tasks/'+task.id+'/evidence/'+saved.id;
    const json=await call(endpoint,'GET',undefined,cookie);assert.equal(json.status,200);assert.equal((await json.json()).stage,'review');assert.equal(json.headers.get('cache-control'),'no-store');
    const png=await call(endpoint+'.png','GET',undefined,cookie);assert.equal(png.status,200);assert.equal(png.headers.get('content-type'),'image/png');
    const other=await call('/api/auth/register','POST',{username:'agent-api-b',password:'strong-test-password-456'});const otherCookie=other.headers.get('set-cookie').split(';')[0];
    assert.equal((await call(endpoint,'GET',undefined,otherCookie)).status,404);
    assert.equal((await call('/api/order-tasks/'+task.id,'GET',undefined,otherCookie)).status,404);
    assert.equal((await call('/api/order-tasks/'+task.id+'/profile','GET',undefined,otherCookie)).status,404);
    assert.equal((await call('/api/order-tasks/'+task.id+'/discover','POST',{},otherCookie)).status,404);
  }finally{
    child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
    merchant.closeAllConnections();await new Promise(resolve=>merchant.close(resolve));
    assert.equal(path.dirname(path.resolve(folder)),path.resolve(tmpdir()));await rm(folder,{recursive:true,force:true});
  }
});
