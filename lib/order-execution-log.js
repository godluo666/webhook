import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {proxyEndpoint,redactProxy} from './source-proxy.js';

const hidden='[已隐藏]';
const privateKey=/^(?:credentials|cookies?|origins|storageState|sessionStorage(?:State)?|headers|requestBody|responseBody|authorization|proxyAuthorization|password|passwd|secret|apiKey|aiKey|accessToken|refreshToken|token|csrfToken|sessionId|sessionToken|key)$/i;
const routeKey=/^(?:a|action|id|pid|gid|invoiceid|billingcycle|cycle|currency|quantity|aff|affid|language)$/i;
export function diagnosticUrl(value){
  try{const url=new URL(value);if(url.protocol==='ss:')return '[Shadowsocks 节点已隐藏]';if(!['http:','https:'].includes(url.protocol))return hidden;
    url.username='';url.password='';url.hash='';
    for(const key of new Set(url.searchParams.keys()))if(!routeKey.test(key))url.searchParams.set(key,hidden);
    return url.href;
  }catch{return hidden;}
}
export function diagnosticError(error){
  if(!error)return null;
  return {name:error.name||'Error',code:error.code||null,message:String(error.message||error).slice(0,3000),stack:typeof error.stack==='string'?error.stack.slice(0,6000):undefined,cause:error.cause?{name:error.cause.name,code:error.cause.code,message:String(error.cause.message||error.cause).slice(0,2000)}:undefined};
}
export function diagnosticPage(page){
  if(!page)return null;
  return {url:page.url,title:page.title,submissionStarted:page.submissionStarted,paymentStarted:page.paymentStarted,blockedRequest:page.blockedRequest,authentication:page.authentication,unavailable:page.unavailable,
    controls:(page.controls||page.elements||[]).slice(0,100).map(el=>Object.fromEntries(['tag','id','class','name','type','href','action'].filter(key=>el[key]!==undefined).map(key=>[key,typeof el[key]==='string'&&el[key].length>500?'[控件属性过长]':el[key]])))};
}
export function diagnosticReceipt(receipt){
  if(!receipt)return null;
  return Object.fromEntries(['status','review','payment','paymentMethod','paymentVerification','invoiceId','orderId','url','confirmation','paymentPending','affiliate','timing'].filter(key=>receipt[key]!==undefined).map(key=>[key,receipt[key]]));
}
export function createOrderExecutionLogs({persist=()=>{},sourceOptions=()=>({}),maxRecords=20,maxEvents=400,maxBytes=128*1024}={}){
  function sanitizer(user,monitorId,extraSecrets=[]){
    const account=(user.orderAccounts||[]).find(a=>a.monitorId===monitorId),monitor=(user.monitors||[]).find(m=>m.id===monitorId);
    const proxies=[user.settings?.sourceProxy,...(user.settings?.sourceProxies||[]).map(p=>p.url),monitor?.sourceProxy];
    try{proxies.push(sourceOptions(user,monitor||{}).proxyUrl);}catch{}
    const secrets=[...extraSecrets,user.settings?.aiKey,...Object.values(account?.credentials||{}),...(account?.session?.redactions||[]),...(account?.session?.state?.cookies||[]).map(c=>c.value).filter(v=>v.length>=6),...Object.values(account?.session?.sessionStorage||{}).filter(v=>typeof v==='string'&&v.length>=6),...(user.orderTasks||[]).filter(t=>t.monitorId===monitorId).flatMap(t=>Object.values(t.credentials||{}))].filter(v=>typeof v==='string'&&v);
    const variants=[...new Set(secrets.flatMap(secret=>[secret,encodeURIComponent(secret),JSON.stringify(secret).slice(1,-1)]))].sort((a,b)=>b.length-a.length);
    const scrubText=value=>{
      let text=value;
      for(const proxy of proxies.filter(Boolean))try{text=redactProxy(text,proxy);}catch{}
      for(const secret of variants)text=text.split(secret).join(hidden);
      return text.replace(/\b(?:https?|ss):\/\/[^\s"'<>`]+/gi,diagnosticUrl)
        .replace(/([?&])([A-Za-z0-9_.%-]+)=([^&\s"'<>`]+)/g,(match,separator,key)=>routeKey.test(key)?match:separator+key+'='+hidden)
        .replace(/\bBearer\s+[A-Za-z0-9+/_=.-]+/gi,hidden)
        .replace(/\bBasic\s+([A-Za-z0-9+/_=.-]+)/gi,(match,token)=>Buffer.from(token,'base64').toString('utf8').includes(':')?hidden:match)
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,hidden)
        .replace(/((?:"|')?(?:password|passwd|secret|key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|csrf(?:token)?|cookie|session)(?:"|')?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s&;,]+)/gi,'$1'+hidden);
    };
    const scrub=(value,depth=0)=>{
      if(depth>10)return '[内容已截断]';
      if(typeof value==='string'){const safe=scrubText(value);return safe.length>24000?safe.slice(0,24000)+'\n[内容已截断]':safe;}
      if(Array.isArray(value))return value.slice(0,500).map(v=>scrub(v,depth+1));
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,100).map(([key,v])=>[key,privateKey.test(key)?hidden:scrub(v,depth+1)]));
      return value;
    };return scrub;
  }
  const flush=()=>{try{persist();}catch{/* Diagnostic writes cannot change a transaction's outcome. */}};
  const trim=user=>{const records=user.orderExecutionLogs||[];while(records.length>maxRecords){let index=records.findLastIndex(r=>r.status!=='running');if(index<0)index=records.length-1;records.splice(index,1);}};
  const bound=record=>{
    while(record.events.length>maxEvents||Buffer.byteLength(JSON.stringify(record))>maxBytes){if(record.events.length<=1)break;record.events.shift();record.droppedEvents++;}
    while(Buffer.byteLength(JSON.stringify(record))>maxBytes){
      let largest=null;const visit=value=>{if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){if(typeof item==='string'&&item.length>128&&key!=='codeHash'&&(!largest||item.length>largest.item.length))largest={value,key,item};else if(item&&typeof item==='object')visit(item);}};visit(record);
      if(!largest)break;largest.value[largest.key]=largest.item.slice(0,Math.floor(largest.item.length/2))+'\n[内容已截断]';record.metadataTruncated=true;
    }
  };
  function start(user,monitorId,{kind,task,url}={}){
    const started=Date.now(),extraSecrets=[],scrub=value=>sanitizer(user,monitorId,extraSecrets)(value);
    let proxy='';try{proxy=sourceOptions(user,(user.monitors||[]).find(m=>m.id===monitorId)||{}).proxyUrl||'';}catch{}
    const record={id:randomUUID(),monitorId,taskId:task?.id||null,kind,status:'running',startedAt:new Date(started).toISOString(),endedAt:null,durationMs:null,droppedEvents:0,
      context:scrub({url:url||task?.url,revision:task?.revision,label:task?.label,product:task?.product,verifiedProduct:task?.verifiedProduct,verifiedCurrency:task?.verifiedCurrency,quantity:task?.quantity,maxTotal:task?.maxTotal,couponCode:task?.couponCode||'',couponFailurePolicy:task?.couponFailurePolicy||'stop',currency:task?.currency,executionMode:task?.executionMode,paymentMethod:task?.paymentMethod,instruction:task?.instruction,affiliateUrl:task?.affiliateUrl}),
      network:{type:/^ss:/i.test(proxy)?'shadowsocks':proxy?'http_proxy':'direct',endpoint:proxyEndpoint(proxy)||null},events:[]};
    (user.orderExecutionLogs||=[]).unshift(record);trim(user);
    let sequence=0,finished=false;
    const event=(action,data={})=>{if(finished)return;record.events.push(scrub({sequence:++sequence,at:new Date().toISOString(),action,...data}));bound(record);};
    const program=(value,codeHash)=>{if(!value)return;record.program=scrub({codeHash,summary:value.summary,checkout:value.checkout,...(value.workflow?{workflow:value.workflow}:{code:value.code})});bound(record);};
    const finish=(status,{result,error,submissionStartedAt,paymentStartedAt}={})=>{if(finished)return;record.status=status;record.endedAt=new Date().toISOString();record.durationMs=Date.now()-started;record.result=scrub({receipt:diagnosticReceipt(result),error:diagnosticError(error),submissionStartedAt:submissionStartedAt||null,paymentStartedAt:paymentStartedAt||null});event('操作结束',{status});finished=true;bound(record);flush();};
    event('操作开始',{kind});if(task?.program&&kind!=='generate')program(task.program,null);flush();
    return {record,event,program,finish,checkpoint:flush,addSecrets:values=>extraSecrets.push(...values.filter(v=>typeof v==='string'&&v))};
  }
  function report(user,monitorId){
    const account=(user.orderAccounts||[]).find(a=>a.monitorId===monitorId),scrub=sanitizer(user,monitorId),records=(user.orderExecutionLogs||[]).filter(r=>r.monitorId===monitorId),tasks=(user.orderTasks||[]).filter(t=>t.monitorId===monitorId);
    return scrub({format:'webhook-radar/order-execution-log',schemaVersion:1,exportedAt:new Date().toISOString(),runtime:{node:process.version,platform:process.platform,browser:path.basename(process.env.MONITOR_BROWSER_EXECUTABLE||'chromium'),buildRevision:process.env.MONITOR_BUILD_REVISION||null},account:{status:account?.status||'logged_out',revision:account?.revision||null,hasSavedSession:Boolean(account?.session?.state),testedAt:account?.testedAt||null,loginUrl:account?.loginUrl},monitor:{id:monitorId,label:(user.monitors||[]).find(m=>m.id===monitorId)?.label},retention:{maxOperationsPerAccount:maxRecords,maxEventsPerOperation:maxEvents,maxBytesPerOperation:maxBytes},operations:records,
      previousResults:records.length?undefined:tasks.slice(0,5).map(task=>({taskId:task.id,label:task.label,status:task.status,error:task.error,trial:task.trial?{...diagnosticReceipt(task.trial),trace:task.trial.trace}:null,result:task.result?{...diagnosticReceipt(task.result),trace:task.result.trace}:null,program:task.program?{summary:task.program.summary,checkout:task.program.checkout,...(task.program.workflow?{workflow:task.program.workflow}:{code:task.program.code})}:null}))});
  }
  function recover(users){for(const user of users){for(const record of user.orderExecutionLogs||[])if(record.status==='running'){record.status='interrupted';record.endedAt=new Date().toISOString();record.events.push({at:record.endedAt,action:'服务重启中断操作',code:'ORDER_OPERATION_INTERRUPTED'});bound(record);}trim(user);}flush();}
  return {start,report,recover};
}