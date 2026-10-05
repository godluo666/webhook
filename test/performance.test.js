import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const bootstrap="import fs from 'node:fs';import path from 'node:path';\nlet writes=0;const original=fs.writeFileSync;\nfs.writeFileSync=function(file,...args){if(path.basename(String(file))==='state.json.tmp')writes++;return original.call(this,file,...args);};\nprocess.on('message',message=>{if(message==='stats')process.send({writes});});\nawait import('./server.js');\n";
test('actual monitor reads, state writes and conditional polling avoid redundant work',{timeout:30000},async t=>{
 let sourceReads=0,hold=null,cookie='',stderr='',failSource=false;
 const source=http.createServer(async(req,res)=>{assert.equal(req.method,'GET','No notifications should be triggered');sourceReads++;if(hold)await hold;res.setHeader('content-type','text/html');res.writeHead(failSource?404:200);res.end('<p>waiting</p>');});
 const sourcePort=await listen(source),reserve=http.createServer(),port=await listen(reserve);
 await new Promise(resolve=>reserve.close(resolve));
 const dir=await mkdtemp(path.join(tmpdir(),'radar-performance-'));
 const child=spawn(process.execPath,['--input-type=module','-e',bootstrap],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir,SIGNUP_CODE:'',RESEND_API_KEY:'',MAIL_FROM:'',MONITOR_BROWSER_ENABLED:'0'},stdio:['ignore','ignore','pipe','ipc']});
 child.stderr.on('data',part=>{stderr=(stderr+part).slice(-4000);});
 const exited=new Promise(resolve=>child.once('exit',resolve)),base='http://127.0.0.1:'+port;
 const stats=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Missing child stats')),3000);child.once('message',value=>{clearTimeout(timer);resolve(value.writes);});child.send('stats');});
 const request=async(endpoint,method='GET',body,headers={})=>{
  const response=await fetch(base+endpoint,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
  if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  return response;
 };
 const json=async(endpoint,method='GET',body)=>{const response=await request(endpoint,method,body);const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
 try{
  let started=false;
  for(let i=0;i<100;i++){try{if((await request('/api/auth/status')).ok){started=true;break;}}catch{}await pause(30);}
  assert.ok(started,stderr);await json('/api/auth/register','POST',{username:'performance',password:'performance-password-2026'});
  await json('/api/settings','PUT',{webhooks:[{id:'hook',name:'Hook',url:'http://127.0.0.1:'+sourcePort+'/hook',format:'generic'}]});
  const monitors=[];
  for(let i=0;i<8;i++){const state=await json('/api/monitors','POST',{kind:'webpage',label:'Task '+i,url:'http://127.0.0.1:'+sourcePort+'/stock',keyword:'available',mode:'contains',intervalMinutes:30,fetch:{mode:'http',proxy:'direct'},webhookIds:['hook']});monitors.push(state.monitors[0]);}
  await t.test('a normal check writes the final snapshot, log and next schedule once',async()=>{
   const before=await stats();const checked=await json('/api/monitors/'+monitors[0].id+'/check','POST');
   assert.equal(checked.check.checked,true);assert.equal(await stats()-before,1);
   const saved=JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')),monitor=saved.users[0].monitors.find(item=>item.id===monitors[0].id);
   assert.equal(monitor.lastCheckAt,checked.monitors.find(item=>item.id===monitor.id).lastCheckAt);
   assert.ok(monitor.next_run_time);assert.ok(saved.users[0].logs.some(log=>log.monitorId===monitor.id));
  });
  await t.test('a failed check persists its error, log, event and retry time once',async()=>{
   const before=await stats();failSource=true;
   const failed=await json('/api/monitors/'+monitors[0].id+'/check','POST');failSource=false;
   assert.equal(failed.check.checked,false);assert.equal(await stats()-before,1);
   const saved=JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')),monitor=saved.users[0].monitors.find(item=>item.id===monitors[0].id);
   assert.match(monitor.lastError,/404/);assert.ok(monitor.sourceRetryAt);
   assert.ok(saved.users[0].logs.some(log=>log.monitorId===monitor.id&&log.status==='error'));
   assert.ok(saved.users[0].events.some(event=>event.monitorId===monitor.id&&event.type==='error'));
  });
  await t.test('eight simultaneous checks read the page once and retain independent results',async()=>{
   const before=sourceReads;let release;hold=new Promise(resolve=>{release=resolve;});
   const checks=monitors.map(monitor=>json('/api/monitors/'+monitor.id+'/check','POST'));
   try{await pause(200);}finally{hold=null;release();}
   const results=await Promise.all(checks);assert.equal(sourceReads-before,1);
   assert.ok(results.every(result=>result.check.checked));
   const state=await json('/api/state');assert.equal(state.monitors.length,8);assert.ok(state.monitors.every(monitor=>monitor.lastResult));
   await json('/api/monitors/'+monitors[0].id+'/check','POST');assert.equal(sourceReads-before,2,'The next check reads fresh content');
  });
  await t.test('unchanged state returns an empty 304; changes and different accounts return 200',async()=>{
   const first=await request('/api/state'),tag=first.headers.get('etag');assert.ok(tag);const state=await first.json();
   const before=await stats(),same=await request('/api/state','GET',undefined,{'if-none-match':tag});
   assert.equal(same.status,304);assert.equal(await same.text(),'');assert.equal(await stats(),before);
   const weak=await request('/api/state','GET',undefined,{'if-none-match':'"different", W/'+tag});assert.equal(weak.status,304);await weak.text();
   await json('/api/monitors/'+monitors[0].id,'PATCH',{enabled:false});
   const changed=await request('/api/state','GET',undefined,{'if-none-match':tag});assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),tag);await changed.text();
   const firstCookie=cookie;
   await json('/api/auth/register','POST',{username:'other-user',password:'another-performance-password'});
   const other=await request('/api/state','GET',undefined,{'if-none-match':tag});assert.equal(other.status,200);assert.notEqual((await other.json()).user.id,state.user.id);
   cookie='';const signedOut=await request('/api/state','GET',undefined,{'if-none-match':tag});assert.equal(signedOut.status,401);await signedOut.text();
   cookie=firstCookie;
  });
 }finally{
  hold=null;child.kill();await exited;source.closeAllConnections();await new Promise(resolve=>source.close(resolve));
  const target=path.resolve(dir);assert.ok(target.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(target).startsWith('radar-performance-'));
  await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
});
