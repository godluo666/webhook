import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {diagnosticUrl} from '../../lib/order-execution-log.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function createSiteMemory({directory=null}={}){
  const cache=new Map(),queues=new Map();
  const key=(scope,url)=>hash(scope)+'/'+hash(new URL(url).origin)+'.json';
  async function read(scope,url){
    const name=key(scope,url);
    if(cache.has(name))return structuredClone(cache.get(name));
    if(!directory)return null;
    try{const value=JSON.parse(await fs.readFile(path.join(directory,name),'utf8'));if(value.schemaVersion!==1||value.origin!==new URL(url).origin)return null;cache.set(name,value);return structuredClone(value);}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}
  }
  async function record(scope,url,{history=[],status,error}){
    const name=key(scope,url),previous=queues.get(name)||Promise.resolve();
    const pending=previous.catch(()=>{}).then(async()=>{
      const profile=await read(scope,url)||{schemaVersion:1,origin:new URL(url).origin,platformType:'generic-commerce',pageTypes:[],elementSemantics:[],successPaths:[],failurePaths:[],outcomes:{}};
      const steps=history.slice(-60).map(step=>({pageType:step.pageType||'unknown',action:step.action,meanings:step.meanings||[],verified:step.verified===true}));
      profile.pageTypes=[...new Set([...profile.pageTypes,...steps.map(step=>step.pageType)])].slice(-30);
      profile.availableActions=[...new Set([...(profile.availableActions||[]),...steps.filter(step=>step.action!=='recover').map(step=>step.action)])];
      profile.flowCharacteristics={...(profile.flowCharacteristics||{}),...Object.fromEntries(['cart','apply_coupon','invoice','pay'].filter(action=>steps.some(step=>step.action===action)).map(action=>[action,true]))};
      if(error){profile.exceptionHandling||={};profile.exceptionHandling[error.code||'AGENT_FAILED']=status==='recovery'?'reobserve_then_replan':'stop_and_review';}
      profile.elementSemantics=[...new Set([...profile.elementSemantics,...steps.flatMap(step=>step.meanings)])].slice(-100);
      const entry={at:new Date().toISOString(),status,steps},list=error?profile.failurePaths:profile.successPaths;
      if(error)entry.errorCode=error.code||'AGENT_FAILED';
      list.push(entry);if(list.length>10)list.shift();
      profile.outcomes[status]=(profile.outcomes[status]||0)+1;profile.updatedAt=entry.at;
      profile.lastEntry=diagnosticUrl(url);
      if(directory){const file=path.join(directory,name);await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temp,JSON.stringify(profile,null,2),{mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true}).catch(()=>{});}}
      cache.set(name,profile);return structuredClone(profile);
    });queues.set(name,pending);try{return await pending;}finally{if(queues.get(name)===pending)queues.delete(name);}
  }
  return {read,record};
}
