import {agentError} from './model.js';

// The template defines business obligations and transaction boundaries only.
// Merchant labels, names, selectors and page layouts never appear here.
export const COMMERCE_TEMPLATE=Object.freeze([
  {id:'identify',goal:'确认目标商品及当前购买入口',actions:['click']},
  {id:'configure',goal:'按用户要求设置数量和规格，可跨页面重复',actions:['fill','select','check','uncheck','configure','choosePayment']},
  {id:'cart',goal:'需要购物车时进入并核验商品和数量',actions:['cart','verify_cart']},
  {id:'coupon',goal:'用户提供优惠信息时应用并核验',actions:['apply_coupon','verify_coupon']},
  {id:'review',goal:'核验当前商品、配置、数量、含税总价和币种',actions:['review']},
  {id:'payment',goal:'仅处理本次已确认订单的账单和授权付款',actions:['invoice','pay']},
  {id:'recovery',goal:'等待页面完成，或请用户确认无法确定的分支',actions:['wait','stop']}
]);
const preparation=['click','fill','select','check','uncheck','configure','choosePayment','cart','review','wait','stop'];
export function flowContext({order={},context={}}){
  let phase='prepare',allowedActions=[...preparation];
  if(context.pendingVerification==='cart'){phase='verify_cart';allowedActions=['verify_cart','stop'];}
  else if(context.pendingVerification==='coupon'){phase='verify_coupon';allowedActions=['verify_coupon','stop'];}
  else if(context.submissionStarted){phase='payment';allowedActions=['invoice','stop'];if(order.executionMode==='pay'&&context.receipt?.status==='ordered'&&!context.paymentStarted)allowedActions.push('pay');}
  else if(order.couponCode&&context.couponApplied!==true){allowedActions=allowedActions.filter(action=>action!=='review');allowedActions.push('apply_coupon');}
  return {phase,allowedActions,stages:COMMERCE_TEMPLATE,optional:{cart:true,coupon:!!order.couponCode,payment:order.executionMode==='pay'}};
}
export function stageForAction(action){return COMMERCE_TEMPLATE.find(stage=>stage.actions.includes(action))?.id||'recovery';}
export function assertFlowStep(step,input){
  if(!flowContext(input).allowedActions.includes(step.action))throw agentError('AGENT_STEP_UNVERIFIED','当前流程阶段不能执行 '+step.action+'，必须先完成上一操作的核验');
  return step;
}
export function resolveValueSource(step,input){
  if(!step.valueFrom)return step;
  if(!['fill','select'].includes(step.action))throw agentError('AGENT_PLAN_INVALID','只有输入和选项步骤可绑定任务参数');
  let expected;
  if(step.valueFrom==='quantity')expected=String(input.order.quantity);
  else if(typeof step.valueFrom==='object'&&typeof step.valueFrom.requirement==='string'){
    const required=(input.workflow.requirements||[]).filter(item=>item.name===step.valueFrom.requirement);
    if(required.length!==1)throw agentError('AGENT_PLAN_INVALID','流程引用了未确认的配置要求');
    expected=required[0].value;
  }else throw agentError('AGENT_PLAN_INVALID','流程参数来源无效');
  if(step.action==='select'){
    const el=input.observation.elements.find(item=>item.ref===step.target?.ref);
    const options=(el?.options||[]).filter(option=>!option.disabled&&String(option.text).normalize('NFKC').trim()===String(expected).normalize('NFKC').trim());
    if(options.length!==1)throw agentError('AGENT_ELEMENT_MISSING','当前页面没有唯一匹配用户要求的选项');
    return {...step,value:options[0].value};
  }
  return {...step,value:expected};
}
