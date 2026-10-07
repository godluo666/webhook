import test from 'node:test';
import assert from 'node:assert/strict';
import {BUSINESS_PROMPT,createPlanner,isFuturePageEvidenceRefusal} from '../automation/agent/planner.js';
import {ORDER_WORKFLOW_PROMPT,ORDER_PAYMENT_PROMPT} from '../lib/order-workflow.js';
const refusal='Insufficient evidence: The provided page is the store category listing. It identifies the target product but does not include the cart, checkout, or order confirmation pages. Without the actual DOM of those pages, the required checkout selectors cannot be determined. Please provide snapshots of the product configuration page, cart page, and order confirmation page.';
const observation={title:'Store category',url:'https://shop.example/catalog',elements:[{ref:'e0',role:'link',text:'Order Now',visible:true,contextText:'Product A 64G RAM 4 Available'}]};
const input=(page=observation,context={})=>({order:{product:'Product A'},workflow:{version:2,requirements:[]},observation:page,history:[],context});
test('业务 SOP 和旧提示词入口统一为 v2，付款辅助不请求整体 checkout',()=>{
  assert.equal(ORDER_WORKFLOW_PROMPT,BUSINESS_PROMPT);assert.match(BUSINESS_PROMPT,/分类页、商品列表页/);assert.match(BUSINESS_PROMPT,/由浏览器运行时逐页访问/);assert.doesNotMatch(ORDER_WORKFLOW_PROMPT,/prepareCode|submitSelector|confirmationSelector/);
  assert.doesNotMatch(ORDER_PAYMENT_PROMPT,/submitSelector|productSelector|quantitySelector/);assert.match(ORDER_PAYMENT_PROMPT,/付款成功确认由宿主/);
});
test('模型索要未来页面时进入浏览器探索修复，而不交给用户补快照',async()=>{
  assert.equal(isFuturePageEvidenceRefusal(refusal),true);
  const planner=createPlanner(async()=>({action:'stop',reason:refusal}));
  await assert.rejects(planner(input()),{code:'AGENT_DISCOVERY_REQUIRED'});
  const errorPlanner=createPlanner(async()=>({error:refusal}));
  await assert.rejects(errorPlanner(input()),{code:'AGENT_DISCOVERY_REQUIRED'});
});
test('实际结算证据缺失、购物车待核验或已提交订单仍停止，不放宽验证',async()=>{
  const planner=createPlanner(async()=>({action:'stop',reason:refusal}));
  for(const current of [input({...observation,title:'Checkout'}),input(observation,{pendingVerification:'cart'}),input(observation,{submissionStarted:true}),input({...observation,elements:[]})]){
    const result=await planner(current);assert.equal(result.action,'stop');
  }
  assert.equal(isFuturePageEvidenceRefusal('Multiple products match, cannot identify the target'),false);
});
