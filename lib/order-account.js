import { randomUUID, createHash } from 'node:crypto';
import { createOrderBrowser } from './order-browser.js';

export function publicOrderAccount(account) {
  if(!account)return null;
  return {monitorId:account.monitorId,loginUrl:account.loginUrl,revision:account.revision,status:account.status||'logged_out',testedAt:account.testedAt||null,error:account.error||'',hasCredentials:Boolean(account.credentials?.username&&account.credentials?.password)};
}
export function orderAccountFingerprint(account) {
  if(!account)return null;
  return createHash('sha256').update(JSON.stringify([account.monitorId,account.loginUrl,account.revision])).digest('hex');
}
export function savedOrderAccount(user, task) {
  const account=(user.orderAccounts||[]).find(a=>a.monitorId===task.monitorId);
  if(!account?.session?.state||!['saved','unavailable'].includes(account.status))throw Object.assign(new Error(account?.session?.state?'网站已确认登录失效，请重新登录并保存会话':'请先在此监控的下单账户区登录并保存会话'),{code:'ORDER_LOGIN_REQUIRED'});
  if(new URL(account.loginUrl).origin!==new URL(task.url).origin)throw new Error('下单网站与已登录账户的网站不符，请重新配置登录地址');
  return account;
}
export function createOrderAccountService({persist,withProxy=async(_url,fn)=>fn(''),sourceOptions=()=>({}),openBrowser=createOrderBrowser,isOrderBusy=()=>false,timeoutMs=10*60_000}) {
  const sessions=new Map(),locks=new Set(),closing=new Set(),completed=new Map();
  const key=(user,monitor)=>user.id+':'+monitor.id;
  const find=(user,monitor)=>(user.orderAccounts||[]).find(a=>a.monitorId===monitor.id);
  const assertFree=(user,monitor)=>{if(locks.has(key(user,monitor))||locks.has(user.id+':login-start')||isOrderBusy(user,monitor))throw new Error('此监控的账户或下单流程正在执行');};
  function save(user,monitor,input) {
    assertFree(user,monitor);
    if([...sessions.values()].some(s=>s.userId===user.id&&s.monitorId===monitor.id))throw new Error('请先结束当前登录窗口');
    const url=new URL(String(input.loginUrl||''));
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.href.length>2000)throw new Error('登录地址需要使用完整且不带密码的 HTTP 或 HTTPS 网址');
    const username=String(input.username||'').trim(),password=String(input.password||'');
    if(username.length>254||password.length>512)throw new Error('账户信息过长');
    let account=find(user,monitor);
    const credentials={...(account&&new URL(account.loginUrl).origin===url.origin?account.credentials:{}),...(username?{username}:{}),...(password?{password}:{})};
    const changed=!account||account.loginUrl!==url.href||JSON.stringify(credentials)!==JSON.stringify(account.credentials);
    if(!account){account={monitorId:monitor.id,revision:0};(user.orderAccounts||= []).push(account);}
    if(changed){account.revision++;account.session=null;account.status='logged_out';delete account.testedAt;}
    Object.assign(account,{loginUrl:url.href,credentials,error:''});persist();return publicOrderAccount(account);
  }
  const owned=(user,monitor,id)=>{
    const record=sessions.get(id);
    if(!record||record.userId!==user.id||record.monitorId!==monitor.id)throw Object.assign(new Error('登录窗口已过期或不存在，请重新打开'),{status:404});
    return record;
  };
  async function stop(record){
    if(!record.stopping){
      sessions.delete(record.id);clearTimeout(record.timer);record.controller.abort();record.release();closing.add(record);
      record.stopping=record.lease.catch(()=>{}).finally(()=>closing.delete(record));
    }
    // A durable save must not wait indefinitely for Chromium or the proxy to close.
    let timer;try{await Promise.race([record.stopping,new Promise(resolve=>{timer=setTimeout(resolve,250);})]);}finally{clearTimeout(timer);}
  }
  async function start(user,monitor){
    assertFree(user,monitor);if(locks.has(user.id+':login-start'))throw new Error('登录浏览器正在打开，请稍候');locks.add(user.id+':login-start');
    try{
    for(const record of [...sessions.values()])if(record.userId===user.id)await stop(record);
    if(sessions.size+closing.size>=2)throw new Error('登录浏览器正在使用中，请稍后重试');
    const account=find(user,monitor);if(!account)throw new Error('请先保存登录地址');
    const controller=new AbortController();let ready,failed,release;
    const opened=new Promise((resolve,reject)=>{ready=resolve;failed=reject;});
    const done=new Promise(resolve=>{release=resolve;});
    const record={id:randomUUID(),userId:user.id,monitorId:monitor.id,controller,release,account,revision:account.revision,busy:false};
    sessions.set(record.id,record);
    record.timer=setTimeout(()=>{void stop(record);},timeoutMs);record.timer.unref();
    record.lease=Promise.resolve().then(()=>withProxy(sourceOptions(user,monitor).proxyUrl,async proxyUrl=>{
      const browser=await openBrowser({url:account.loginUrl,credentials:account.credentials},{proxyUrl,loginOnly:true,storageState:account.session?.state,sessionStorageState:account.session?.sessionStorage,signal:controller.signal,timeoutMs:timeoutMs+1000});
      record.browser=browser;ready(browser);
      try{await done;}finally{await browser.close();}
    })).catch(error=>{failed(error);sessions.delete(record.id);clearTimeout(record.timer);throw error;});
    // Attach a rejection handler immediately; the lease lives across requests.
    record.lease.catch(()=>{});
    try{const browser=await opened;return {sessionId:record.id,view:await browser.remote.view()};}
    catch(error){await stop(record);throw error;}
    }finally{locks.delete(user.id+':login-start');}
  }
  async function action(user,monitor,input){
    const record=owned(user,monitor,input.sessionId);if(record.busy)throw new Error('登录操作正在处理，请稍后');record.busy=true;
    try{return {sessionId:record.id,view:await record.browser.remote.act(input)};}catch(error){if(input.value)error.message=error.message.split(String(input.value)).join('[已隐藏]');throw error;}finally{record.busy=false;}
  }
  async function finish(user,monitor,input){
    for(const [id,item]of completed)if(item.expiresAt<Date.now())completed.delete(id);
    const prior=completed.get(input.sessionId),account=find(user,monitor);
    if(prior&&prior.userId===user.id&&prior.monitorId===monitor.id){
      if(account?.revision!==prior.revision||account.status!=='saved')throw new Error('此保存结果已被新的账户操作替代，请查看当前账户状态');
      return publicOrderAccount(account);
    }
    const record=owned(user,monitor,input.sessionId);
    if(record.finishPromise)return record.finishPromise;
    if(record.busy)throw new Error('登录操作正在处理');
    assertFree(user,monitor);record.busy=true;locks.add(key(user,monitor));
    record.finishPromise=(async()=>{
      try{
        if(record.account.revision!==record.revision)throw new Error('登录配置已修改，请重新登录');
        const session=await record.browser.remote.finish();
        if(record.controller.signal.aborted||!sessions.has(record.id))throw new Error('登录窗口已关闭，请重新打开');
        session.redactions=[...new Set([...(record.account.session?.redactions||[]),...(session.redactions||[])])].slice(-40);
        const previous=Object.fromEntries(['session','revision','status','testedAt','error'].map(key=>[key,record.account[key]]));
        record.account.session=session;record.account.revision++;record.account.status='saved';record.account.testedAt=session.testedAt;record.account.error='';
        try{persist();}catch(error){Object.assign(record.account,previous);throw error;}
        completed.set(record.id,{userId:user.id,monitorId:monitor.id,revision:record.account.revision,expiresAt:Date.now()+2*60_000});
        if(completed.size>200)completed.delete(completed.keys().next().value);
        await stop(record);return publicOrderAccount(record.account);
      }finally{record.busy=false;locks.delete(key(user,monitor));record.finishPromise=null;}
    })();
    return record.finishPromise;
  }
  async function cancel(user,monitor,input){assertFree(user,monitor);await stop(owned(user,monitor,input.sessionId));return publicOrderAccount(find(user,monitor));}
  async function check(user,monitor){
    assertFree(user,monitor);if([...sessions.values()].some(s=>s.userId===user.id&&s.monitorId===monitor.id))throw new Error('请先保存或关闭当前登录窗口');const account=find(user,monitor);if(!account?.session)throw new Error('请先登录并保存会话');
    locks.add(key(user,monitor));
    try{
      await withProxy(sourceOptions(user,monitor).proxyUrl,async proxyUrl=>{
        const browser=await openBrowser({url:account.session.check?.url||account.loginUrl,credentials:account.credentials},{proxyUrl,storageState:account.session.state,sessionStorageState:account.session.sessionStorage,loginCheck:account.session.check});
        try{if(browser.accountState)Object.assign(account.session,await browser.accountState());}finally{await browser.close();}
      });
      account.status='saved';account.testedAt=new Date().toISOString();account.error='';
    }catch(error){account.status=error.code==='ORDER_LOGIN_REQUIRED'?'expired':'unavailable';account.error=error.message;throw error;}
    finally{locks.delete(key(user,monitor));persist();}
    return publicOrderAccount(account);
  }
  async function logout(user,monitor){assertFree(user,monitor);for(const record of [...sessions.values()])if(record.userId===user.id&&record.monitorId===monitor.id)await stop(record);const account=find(user,monitor);if(account){account.session=null;account.status='logged_out';account.revision++;account.error='';persist();}return publicOrderAccount(account);}
  function busy(user,monitor){return locks.has(user.id+':'+(typeof monitor==='string'?monitor:monitor.id))||locks.has(user.id+':login-start')||[...sessions.values()].some(s=>s.userId===user.id&&s.monitorId===(typeof monitor==='string'?monitor:monitor.id));}
  async function productPreview(user,monitor,input){
    assertFree(user,monitor);if(busy(user,monitor.id))throw new Error('请先结束当前登录操作');
    const url=new URL(String(input.url||''));if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.href.length>2000)throw new Error('商品地址无效');
    const account=savedOrderAccount(user,{monitorId:monitor.id,url:url.href});locks.add(key(user,monitor));
    try{return await withProxy(sourceOptions(user,monitor).proxyUrl,async proxyUrl=>{
      const browser=await openBrowser({url:url.href,credentials:{...account.credentials,...Object.fromEntries((account.session.redactions||[]).map((value,i)=>['login'+i,value]))}},{proxyUrl,storageState:account.session.state,sessionStorageState:account.session.sessionStorage,loginCheck:account.session.check,timeoutMs:30000});
      try{return {url:url.href,html:await browser.productHtml()};}
      finally{try{if(browser.accountState)Object.assign(account.session,await browser.accountState());}finally{await browser.close();persist();}}
    });}finally{locks.delete(key(user,monitor));}
  }
  return {save,start,action,finish,cancel,check,logout,busy,productPreview};
}
