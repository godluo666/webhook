const inputCodes=new Set(['ORDER_LOGIN_REQUIRED','ORDER_LOGIN_UNVERIFIED','AGENT_NEEDS_INPUT','ORDER_CHALLENGE_REQUIRED','ORDER_CONTRACT_UNVERIFIED','ORDER_CURRENCY_UNVERIFIED']);
const recoverableCodes=new Set(['ORDER_NAVIGATION_UNSTABLE','AGENT_ELEMENT_MISSING','AGENT_LOW_CONFIDENCE','AGENT_PLAN_INVALID','AGENT_STEP_UNVERIFIED','AGENT_CONFIGURATION_UNVERIFIED','AGENT_DISCOVERY_REQUIRED','AGENT_NO_PROGRESS']);
export function orderFailure(error,{stage='observation',action=null,submissionStarted=false,paymentStarted=false}={}){
  const code=error.code||'ORDER_STAGE_FAILED',sent=submissionStarted||paymentStarted;
  const category=sent?'hard_stop':code==='ORDER_OUT_OF_STOCK'?'waiting_stock':(error.orderInput||inputCodes.has(code))?'needs_input':recoverableCodes.has(code)?'recoverable':'hard_stop';
  return {stage,action,code,category,orderRequestSent:submissionStarted?'possible':'no',paymentRequestSent:paymentStarted?'possible':'no',retryAllowed:!sent&&category==='recoverable',suggestion:sent?'核对商家原订单与付款记录；禁止自动重试交易':category==='waiting_stock'?'保留已验证阶段；明确授权等待补货后自动核验':code==='ORDER_CONTRACT_UNVERIFIED'?'提交契约仍待验证；需要可靠的商城请求字段映射，前端推断不能作为许可':category==='needs_input'?(error.orderInput?'请回答当前步骤的具体问题，再按原任务继续；已确认配置不会自动放宽':'补充缺失证据或恢复登录后重新核验'):'重新观察当前页面并核对失败阶段，不放宽商品、预算或请求许可',...(error.orderInput?{input:error.orderInput}:{}),at:new Date().toISOString()};
}
