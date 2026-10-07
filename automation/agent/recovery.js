const recoverable=new Set(['AGENT_ELEMENT_MISSING','AGENT_LOW_CONFIDENCE','AGENT_PLAN_INVALID','AGENT_STEP_UNVERIFIED','AGENT_CONFIGURATION_UNVERIFIED']);
export function canRecover(error,session,{signal,attempts,maxAttempts=2}){
  if(signal?.aborted||attempts>=maxAttempts||session.paymentStarted)return false;
  if(session.submissionStarted&&session.receipt?.status!=='ordered')return false;
  return recoverable.has(error.code)||(!session.submissionStarted&&/网页元素不存在|网页元素定位|strict mode|waiting for locator|locator.*Timeout/i.test(error.message));
}
export async function recoveryContext(error,session,history){
  let evidence;try{evidence=await session.captureEvidence?.('recovery');}catch{}
  const observation=await session.methods.observe();
  return {observation,image:evidence?.image,feedback:{error:{code:error.code||null,message:String(error.message).slice(0,1000)},url:observation.url,history:history.slice(-30),evidenceId:evidence?.id||null}};
}
