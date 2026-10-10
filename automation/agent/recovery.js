const recoverable=new Set(['ORDER_NAVIGATION_UNSTABLE','AGENT_NO_PROGRESS','AGENT_ELEMENT_MISSING','AGENT_LOW_CONFIDENCE','AGENT_PLAN_INVALID','AGENT_STEP_UNVERIFIED','AGENT_CONFIGURATION_UNVERIFIED','AGENT_DISCOVERY_REQUIRED']);
export function isPlanningUncertainty(error){
  return recoverable.has(error.code)||/网页元素不存在|网页元素定位|strict mode|waiting for locator|locator.*Timeout|Execution context was destroyed|Cannot find context with specified id|Element is not attached to the DOM|element was detached/i.test(error.message||'');
}
export function canRecover(error,session,{signal,attempts,maxAttempts=2}){
  if(signal?.aborted||attempts>=maxAttempts||session.paymentStarted)return false;
  if(session.submissionStarted&&session.receipt?.status!=='ordered')return false;
  return recoverable.has(error.code)||(!session.submissionStarted&&isPlanningUncertainty(error));
}
export async function recoveryContext(error,session,history,{signal,run=fn=>fn(),includeImage=false}={}){
  let evidence,observation;
  // A screenshot is optional evidence for persistent ambiguity, not the default retry payload.
  if(includeImage)try{evidence=await run(()=>session.captureEvidence?.('recovery'));}catch{signal?.throwIfAborted();}
  for(let attempt=0;attempt<2;attempt++){
    signal?.throwIfAborted();
    try{observation=await run(()=>session.methods.observe());break;}catch(readError){if(attempt===1)throw readError;}
  }
  return {observation,image:evidence?.image,feedback:{error:{code:error.code||null,message:String(error.message).slice(0,600)},...(error.orderAmbiguity?{ambiguity:error.orderAmbiguity}:{}),url:observation.url,evidenceId:evidence?.id||null}};
}
