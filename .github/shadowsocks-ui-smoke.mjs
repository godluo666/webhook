import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
const root=process.cwd();
const {buildShadowsocksUrl,parseShadowsocks,SHADOWSOCKS_METHODS}=await import(pathToFileURL(path.join(root,'lib/shadowsocks.js')));
const {sourceProxyFromInput,proxyEndpoint}=await import(pathToFileURL(path.join(root,'lib/source-proxy.js')));
const choose=async(field,value)=>field.locator('..').locator('.choice-control [data-choice-value="'+value+'"]').click();
const dataDir=await fs.mkdtemp(path.join(tmpdir(),'radar-ss-ui-'));
const reservation=http.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const base='http://127.0.0.1:'+port;
let child,browser,page;const errors=[],requests=[],privateProxies=new Map();let state,defaultProxy='',failSave=false,serverOutput='';
const verified={ip:'203.0.113.42',durationMs:12,testedAt:new Date().toISOString()};
const finish=async route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(state)});
const waitIdle=()=>page.waitForFunction(()=>!document.querySelector('#source-proxy-test').disabled);
const routeWithErrors=(pattern,handler)=>page.route(pattern,async route=>{
 try{await handler(route);}catch(error){errors.push(error.message);await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'UI fixture failed: '+error.message})}).catch(()=>{});}
});
try {
 child=spawn(process.execPath,['server.js'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DATA_DIR:dataDir,PORT:String(port),HOST:'127.0.0.1',MONITOR_SS_EXECUTABLE:'',RESEND_API_KEY:'',MAIL_FROM:'',SIGNUP_CODE:''}});
 for(const stream of[child.stdout,child.stderr])stream.on('data',chunk=>{serverOutput=(serverOutput+chunk.toString()).slice(-4000);});
 let started=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/auth/status')).ok){started=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
 assert.ok(started,serverOutput);
 const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':'/usr/bin/chromium');
 browser=await chromium.launch({executablePath:executable,headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 const registration=await context.request.post(base+'/api/auth/register',{data:{username:'ss-ui-user',password:'ss-ui-test-password'}});assert.equal(registration.status(),201);
 state=await(await context.request.get(base+'/api/state')).json();
 page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await routeWithErrors('**/api/state',finish);
 // Network connectivity has separate API/bridge regressions. These UI fixtures
 // verify that the raw parameters reach the production generator without secrets
 // being returned to the browser as saved state.
 await routeWithErrors('**/api/source-proxy/test',async route=>{
  const body=route.request().postDataJSON();requests.push({action:'test',body});
  let url;try{url=body.sourceProxyId?privateProxies.get(body.sourceProxyId):sourceProxyFromInput(body,defaultProxy);}catch(error){console.error('UI proxy request diagnostics:',{keys:Object.keys(body),candidateScheme:/^[a-z]+:/i.exec(body.proxyUrl||'')?.[0],fallbackScheme:/^[a-z]+:/i.exec(defaultProxy)?.[0],hasStructured:Boolean(body.shadowsocks)});throw error;}assert.ok(url);
  if(body.shadowsocks)assert.deepEqual(parseShadowsocks(url),parseShadowsocks(buildShadowsocksUrl(body.shadowsocks)));
  const result=body.targetUrl?{purpose:'target',status:200,method:body.mode,durationMs:12}:{ok:true,purpose:'connectivity',...verified};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
 });
 await routeWithErrors('**/api/source-proxies',async route=>{
  const body=route.request().postDataJSON();requests.push({action:'save',body});
  const url=sourceProxyFromInput(body);assert.ok(url);
  if(failSave){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'fixture: SS connection refused',code:'PROXY_CONNECTION_REFUSED'})});return;}
  const id='proxy-'+(privateProxies.size+1);privateProxies.set(id,url);
  state.settings.sourceProxies.push({id,name:body.name||proxyEndpoint(url),endpoint:proxyEndpoint(url),test:verified});
  await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify(state)});
 });
 await routeWithErrors('**/api/source-proxy',async route=>{
  const body=route.request().postDataJSON();requests.push({action:'default',body});
  defaultProxy=body.sourceProxyId?privateProxies.get(body.sourceProxyId):sourceProxyFromInput(body,defaultProxy);assert.ok(defaultProxy);
  let profile=state.settings.sourceProxies.find(item=>privateProxies.get(item.id)===defaultProxy);
  if(!profile){const id='proxy-'+(privateProxies.size+1);privateProxies.set(id,defaultProxy);profile={id,name:body.name||proxyEndpoint(defaultProxy),endpoint:proxyEndpoint(defaultProxy),test:verified};state.settings.sourceProxies.push(profile);}
  if(body.shadowsocks)assert.equal(await page.locator('#source-ss-password').isDisabled(),true,'Parameter controls stay locked while applying a proxy');
  Object.assign(state.settings,{hasSourceProxy:true,sourceProxyEndpoint:proxyEndpoint(defaultProxy),sourceProxyTest:verified,sourceProxyId:profile.id});
  await finish(route);
 });
 await page.goto(base+'/#fetch-settings');await page.locator('#source-ss-server').waitFor();
 assert.equal(await page.locator('#source-proxy-type').inputValue(),'shadowsocks');
 assert.equal(await page.locator('#source-ss-method').isVisible(),true);
 assert.equal(await page.locator('#source-ss-password').getAttribute('type'),'password');
 const options=await page.locator('#source-ss-method option').evaluateAll(nodes=>nodes.map(node=>node.value));assert.deepEqual(options.sort(),[...SHADOWSOCKS_METHODS].sort());
 await page.locator('#source-ss-server').fill('2001:db8::1');await page.locator('#source-proxy-test').click();assert.match(await page.locator('#source-connection-result').innerText(),/端口/);assert.equal(requests.length,0);
 await page.locator('#source-ss-port').fill('0');await page.locator('#source-proxy-test').click();assert.match(await page.locator('#source-connection-result').innerText(),/端口/);assert.equal(requests.length,0);
 await page.locator('#source-ss-port').fill('8388');await page.locator('#source-proxy-test').click();assert.match(await page.locator('#source-connection-result').innerText(),/密码/);assert.equal(requests.length,0);
 for(const method of SHADOWSOCKS_METHODS){
  const password=method.startsWith('2022-')?Buffer.alloc(method.includes('aes-128')?16:32,251).toString('base64'):' 密码:@?#/%+ ';
  await page.locator('#source-ss-method').selectOption(method);await page.locator('#source-ss-password').fill(password);
  await page.locator('#source-proxy-test').click();await waitIdle();assert.match(await page.locator('#source-connection-result').innerText(),/203\.0\.113\.42/);
  const candidate=requests.at(-1).body;assert.equal(candidate.proxyUrl,undefined);assert.equal(candidate.shadowsocks.password,password);assert.equal(candidate.shadowsocks.server,'2001:db8::1');assert.equal(parseShadowsocks(buildShadowsocksUrl(candidate.shadowsocks)).method,method);
  assert.equal(await page.locator('#source-ss-password').inputValue(),password,'Testing keeps the draft password');
 }
 console.log('PASS native cipher selection, all supported methods, raw special-character passwords, IPv6 and SS 2022 parameter generation');
 await page.locator('#source-proxy-name').fill('参数填写的 SS');await page.locator('#source-ss-method').selectOption('aes-256-gcm');await page.locator('#source-ss-password').fill('private-password:@?#/%');
 failSave=true;await page.locator('#source-proxy-add').click();await waitIdle();assert.match(await page.locator('#source-connection-result').innerText(),/fixture/);assert.equal(await page.locator('#source-ss-password').inputValue(),'private-password:@?#/%');assert.equal(state.settings.sourceProxies.length,0);
 failSave=false;await page.locator('#source-proxy-add').click();await page.locator('.proxy-profile-row').filter({hasText:'参数填写的 SS'}).waitFor();await waitIdle();
 assert.equal(await page.locator('#source-ss-password').inputValue(),'');assert.equal(state.settings.hasSourceProxy,false,'Saving a profile does not change the active proxy');assert.equal(JSON.stringify(state).includes('private-password'),false);
 const profile=state.settings.sourceProxies[0];await page.locator('[data-proxy-use="'+profile.id+'"]').click();await waitIdle();assert.equal(state.settings.sourceProxyId,profile.id);
 const count=requests.length;await page.locator('#source-ss-server').fill('198.51.100.1');await page.locator('#source-proxy-test').click();assert.match(await page.locator('#source-connection-result').innerText(),/端口/);assert.equal(requests.length,count,'Incomplete SS input must not test a saved proxy');
 await page.locator('#source-ss-server').fill('');await page.locator('#source-test-url').fill('http://target.invalid/status');await page.locator('#source-target-test').click();await waitIdle();assert.match(await page.locator('#source-proxy-result').innerText(),/目标读取成功/);assert.equal(requests.at(-1).body.proxyUrl,'');
 await choose(page.locator('#source-proxy-type'),'url');await page.locator('#source-proxy').fill('http://proxy-user:proxy-secret@127.0.0.1:8080');await page.locator('#source-ss-server').evaluate(field=>{field.value='stale.invalid';});
 await page.locator('#source-proxy-test').click();await waitIdle();assert.equal(requests.at(-1).body.shadowsocks,undefined);assert.match(requests.at(-1).body.proxyUrl,/^http:/);
 console.log('PASS save failure preserves the draft; successful save hides credentials; explicit default selection, target testing and incomplete-input protection');
 await choose(page.locator('#source-proxy-type'),'shadowsocks');await page.locator('#source-ss-server').fill('2001:db8::1');await page.locator('#source-ss-port').fill('443');await page.locator('#source-ss-method').selectOption('2022-blake3-aes-256-gcm');await page.locator('#source-ss-password').fill(Buffer.alloc(32,1).toString('base64'));
 const suppliedKey=await page.locator('#source-ss-password').inputValue();
 await page.locator('#source-proxy-save').click();await waitIdle();assert.equal(requests.at(-1).action,'default');assert.equal(requests.at(-1).body.shadowsocks.password,suppliedKey);assert.equal(requests.at(-1).body.proxyUrl,undefined);
 assert.equal(state.settings.sourceProxyEndpoint,'ss://[2001:db8::1]:443');assert.equal(await page.locator('#source-ss-password').inputValue(),'');assert.equal(JSON.stringify(state).includes(suppliedKey),false);
 console.log('PASS direct parameter submission adds and selects the intended default without using the hidden HTTP draft');
 await page.locator('#source-ss-server').fill('2001:db8::1');await page.locator('#source-ss-port').fill('443');await page.locator('#source-ss-method').selectOption('2022-blake3-aes-256-gcm');await page.locator('#source-ss-password').fill(suppliedKey);
 const output=process.env.UI_SMOKE_SCREENSHOT_DIR?path.resolve(process.env.UI_SMOKE_SCREENSHOT_DIR):path.join(root,'release','shadowsocks-ui-smoke');await fs.mkdir(output,{recursive:true});
 for(const width of[1440,390,320]){
  await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'SS form overflows at '+width);
  await page.screenshot({path:path.join(output,'ss-form-'+width+'.png'),fullPage:true});
 }
 await page.locator('#logout-button').click();await page.locator('#auth-username').waitFor();assert.equal(await page.locator('#source-ss-password').inputValue(),'');assert.equal(await page.locator('#source-proxy').inputValue(),'');assert.equal(await page.locator('#source-ss-server').inputValue(),'');
 assert.deepEqual(errors,[]);console.log('PASS HTTP link import, responsive SS form at 1440/390/320px, and credentials cleared on logout');
}finally{
 await browser?.close();if(child){child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));}
 const resolved=path.resolve(dataDir);assert.ok(resolved.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(resolved).startsWith('radar-ss-ui-'));await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}