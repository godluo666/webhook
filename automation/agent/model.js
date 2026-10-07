export const BUSINESS_SOP = Object.freeze([
  {id:'open',goal:'打开目标商品页面'}, {id:'identify',goal:'识别目标商品'},
  {id:'purchase',goal:'进入购买流程'}, {id:'configure',goal:'配置商品参数和数量'},
  {id:'coupon',goal:'应用并验证用户优惠信息'}, {id:'review',goal:'验证商品、配置、数量、总价和币种'},
  {id:'checkout',goal:'进入结账流程'}, {id:'submit',goal:'经用户授权提交一次订单'},
  {id:'verify',goal:'验证新订单及付款结果'}
]);
export const agentError=(code,message)=>Object.assign(new Error(message),{code});
export function validateBusinessWorkflow(value){
  if(value?.version!==2)throw agentError('ORDER_WORKFLOW_INVALID','业务 SOP 需要 version=2');
  const inspect=(item,depth=0)=>{
    if(depth>8)throw agentError('ORDER_WORKFLOW_INVALID','业务 SOP 嵌套过深');
    if(item&&typeof item==='object')for(const [key,child] of Object.entries(item)){
      if(/selector|xpath|prepareCode|paymentCode|locator|\bref\b/i.test(key))throw agentError('ORDER_WORKFLOW_INVALID','业务 SOP 不能保存页面定位或执行代码');
      inspect(child,depth+1);
    }
  };inspect(value);
  const requirements=value.requirements??[];
  if(!Array.isArray(requirements)||requirements.length>20)throw agentError('ORDER_WORKFLOW_INVALID','商品配置要求无效');
  return {version:2,businessSop:BUSINESS_SOP.map(step=>({...step})),requirements:requirements.map(item=>{
    if(typeof item?.name!=='string'||!item.name.trim()||item.name.length>100||typeof item.value!=='string'||!item.value.trim()||item.value.length>200)throw agentError('ORDER_WORKFLOW_INVALID','配置要求必须包含 name 和 value');
    return {name:item.name.trim(),value:item.value.trim()};
  })};
}
export function validateTarget(value){
  if(!value||typeof value.meaning!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(value.meaning)||typeof value.ref!=='string'||!/^e\d+$/.test(value.ref)||!Number.isFinite(value.confidence)||value.confidence<0.8||value.confidence>1)
    throw agentError('AGENT_LOW_CONFIDENCE','需要当前页面中唯一、置信度至少 0.8 的语义元素');
  return {meaning:value.meaning,ref:value.ref,confidence:value.confidence};
}
