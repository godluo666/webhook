import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {diagnosticError,diagnosticAIInput,diagnosticAIOutput,diagnosticUrl} from './order-execution-log.js';

export const DEFAULT_ORDER_TIMEOUTS=Object.freeze({aiTimeoutMs:120000,agentTimeoutMs:600000,trialTimeoutMs:1500000});
export function readOrderTimeouts(env=process.env){
  const duration=(name,fallback,max)=>{const value=Number(env[name]);return Number.isFinite(value)&&value>=1000&&value<=max?Math.round(value):fallback;};
  return {aiTimeoutMs:duration('ORDER_AI_TIMEOUT_MS',DEFAULT_ORDER_TIMEOUTS.aiTimeoutMs,300000),agentTimeoutMs:duration('ORDER_AGENT_TIMEOUT_MS',DEFAULT_ORDER_TIMEOUTS.agentTimeoutMs,1800000),trialTimeoutMs:duration('ORDER_TRIAL_TIMEOUT_MS',DEFAULT_ORDER_TIMEOUTS.trialTimeoutMs,3600000)};
}
export function orderTimeoutError(code,stage,timeoutMs){
  return Object.assign(new Error(stage+'超时（等待 '+Number((timeoutMs/1000).toFixed(2))+' 秒），请查看执行日志后重试'),{code,stage,timeoutMs});
}
export function createOrderDeadline({signal,timeoutMs,code,stage}){
  const controller=new AbortController(),abort=()=>controller.abort(signal.reason);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(()=>controller.abort(orderTimeoutError(code,stage,timeoutMs)),timeoutMs);
  return {signal:controller.signal,close:()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);}};
}
// Racing reads also bounds injected transports that fail to honor cancellation.
// Late replies never authorize an action, and their rejections remain handled.
export async function abortable(operation,signal){
  signal?.throwIfAborted();let abort;
  const cancelled=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
  try{const result=await Promise.race([Promise.resolve().then(()=>{signal?.throwIfAborted();return operation();}),cancelled]);signal?.throwIfAborted();return result;}
  finally{signal?.removeEventListener('abort',abort);}
}
export async function requestOrderAI(requestAI,user,messages,{signal,timeoutMs=DEFAULT_ORDER_TIMEOUTS.aiTimeoutMs,stage='页面规划',maxRetries=1,retryDelayMs=1000,onEvent=()=>{}}={}){
  const requestId=randomUUID(),emit=(action,data)=>{try{onEvent(action,{requestId,stage,...data});}catch{/* Logging cannot alter a request or authorize a retry. */}};
  const input=diagnosticAIInput(messages);
  for(let attempt=0;attempt<=maxRetries;attempt++){
    signal?.throwIfAborted();
    const deadline=createOrderDeadline({signal,timeoutMs,code:'ORDER_AI_TIMEOUT',stage:stage+'：AI 响应'});
    const started=Date.now();
    emit('AI 请求开始',{attempt:attempt+1,maxAttempts:maxRetries+1,timeoutMs,retryDelayMs,model:user.settings?.aiModel||null,endpoint:user.settings?.aiBaseUrl?diagnosticUrl(user.settings.aiBaseUrl):null,input});
    try{
      const output=await abortable(()=>requestAI(user,messages,{signal:deadline.signal,timeoutMs,stage,onMetadata:metadata=>{if(!deadline.signal.aborted)emit('AI 传输信息',{attempt:attempt+1,...metadata});}}),deadline.signal);
      emit('AI 响应完成',{attempt:attempt+1,durationMs:Date.now()-started,response:diagnosticAIOutput(output)});return output;
    }
    catch(error){
      if(signal?.aborted){emit('AI 请求取消',{attempt:attempt+1,durationMs:Date.now()-started,error:diagnosticError(signal.reason)});throw signal.reason;}
      const timedOut=deadline.signal.aborted||/timeout|timed out|aborted due to timeout/i.test([error.code,error.name,error.networkCode,error.cause?.code,error.message].join(' '));
      if(!timedOut){emit('AI 请求失败',{attempt:attempt+1,durationMs:Date.now()-started,error:diagnosticError(error)});throw error;}
      const failure=orderTimeoutError('ORDER_AI_TIMEOUT',stage+'：AI 响应',timeoutMs);
      failure.attempts=attempt+1;failure.elapsedMs=Date.now()-started;
      if(attempt===maxRetries){emit('AI 请求超时',{attempt:attempt+1,timeoutMs,elapsedMs:failure.elapsedMs,error:diagnosticError(error)});throw failure;}
      emit('AI 请求超时，重新请求',{attempt:attempt+1,nextAttempt:attempt+2,timeoutMs,elapsedMs:failure.elapsedMs,retryDelayMs,error:diagnosticError(error)});
      try{await delay(retryDelayMs,undefined,{signal});}catch(error){if(signal?.aborted)throw signal.reason;throw error;}
    }finally{deadline.close();}
  }
}
