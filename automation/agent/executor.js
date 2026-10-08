import {diagnosticError,diagnosticPage,diagnosticAIOutput,diagnosticReceipt} from '../../lib/order-execution-log.js';
import {parseOrderQuantity,matchesProductSelection} from '../../lib/order-evidence.js';
import {orderFailure} from '../../lib/order-diagnostics.js';
import {DEFAULT_ORDER_TIMEOUTS,createOrderDeadline,abortable} from '../../lib/order-timeouts.js';
import {validateStep} from './planner.js';
import {agentError,validateTarget} from './model.js';
import {canRecover,recoveryContext} from './recovery.js';
import {pageType} from '../adapters/generic-commerce.js';
const checkoutKeys={submit:'submitSelector',product:'productSelector',quantity:'quantitySelector',total:'totalSelector',currency:'currencySelector'};
const couponKeys={input:'inputSelector',apply:'applySelector',appliedCode:'appliedCodeSelector',discount:'discountSelector'};
const paymentKeys={pay:'paySelector',invoice:'invoiceSelector',total:'totalSelector',currency:'currencySelector',balance:'balanceSelector',balanceCurrency:'balanceCurrencySelector',pending:'pendingSelector'};
const normalize=value=>String(value).normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
export async function runCommerceAgent(program,order,session,{plan,signal,memory=null,onEvent=()=>{},onLearn=async()=>{},maxSteps=40,timeoutMs=DEFAULT_ORDER_TIMEOUTS.agentTimeoutMs,autoRepair=true}={}){
  if(!plan||!session.methods.observe||!session.methods.resolveSemantic)throw agentError('AGENT_UNAVAILABLE',"浏览器缺少语义观察和动态规划能力");
  const emit=(action,data)=>{try{onEvent(action,data);}catch{/* Diagnostics must not change an execution result. */}};
  const budget=createOrderDeadline({signal,timeoutMs,code:'AGENT_BUDGET_EXCEEDED',stage:'动态页面探索'});signal=budget.signal;
  const methods=Object.fromEntries(Object.entries(session.methods).map(([name,method])=>[name,(...args)=>abortable(()=>method.apply(session.methods,args),signal)]));
  const planWithinBudget=input=>abortable(()=>plan({...input,signal}),signal),history=[],deadline=Date.now()+timeoutMs;
  let repairs=0,pendingVerification=null,couponFailed=false,couponApplied=!order.couponCode,feedback=null,image=null,stage='observation',currentAction=null,lastState='',stagnant=0;
  const completed=new Set();
  const resolve=async target=>{validateTarget(target);const located=await methods.resolveSemantic(target);emit('语义定位',{meaning:target.meaning,ref:target.ref,strategy:located.strategy,confidence:target.confidence,selector:located.selector,attempts:located.attempts});return located.selector;};
  const bind=async (bindings,map,required=Object.keys(map))=>{
    if(!bindings||required.some(key=>!bindings[key]))throw agentError('AGENT_PLAN_INVALID',"缺少当前页面核验字段："+required.join(','));
    const result={};for(const [key,name]of Object.entries(map))if(bindings[key])result[name]=await resolve(bindings[key]);return result;
  };
  const read=async target=>{validateTarget(target);return methods.readSemantic(target);};
  const configuration=async step=>{
    const values=[];
    for(const required of program.workflow.requirements){
      const items=(step.configuration||[]).filter(item=>item.name===required.name);
      if(items.length!==1)throw agentError('AGENT_CONFIGURATION_UNVERIFIED',"缺少商品配置核验："+required.name);
      const observed=await read(items[0].target);
      const matched=normalize(observed.value??observed.text)===normalize(required.value);
      emit('配置核验',{name:required.name,expected:required.value,observed:observed.value??observed.text,matched,target:items[0].target});
      if(!matched)throw agentError('AGENT_CONFIGURATION_UNVERIFIED',"商品配置与已确认要求不符："+required.name);
      values.push({...required,selector:await resolve(items[0].target)});
    }return values;
  };
  try{
    for(let index=0;index<maxSteps;index++){
      signal?.throwIfAborted();if(Date.now()>deadline)throw agentError('AGENT_BUDGET_EXCEEDED',"动态执行已超时");
      session.keepAlive?.(Math.max(1000,deadline-Date.now())+15000);
      const stepStarted=Date.now();let observation={elements:[],url:order.url};
      try{
      stage='observation';currentAction=null;
      observation=await methods.observe();
      const state=JSON.stringify([observation.url,observation.text,(observation.elements||[]).map(({text,value,checked,disabled})=>({text,value,checked,disabled}))]);
      stagnant=state===lastState?stagnant+1:0;lastState=state;
      if(stagnant>=4)throw agentError('AGENT_NO_PROGRESS','同页连续无进展，请重新识别流程分支');
      stage='planning';
      emit('页面观察',{step:index+1,durationMs:Date.now()-stepStarted,pageType:pageType(observation),page:diagnosticPage({...observation,controls:(observation.elements||[]).filter(el=>el.role&&['link','button','textbox','spinbutton','combobox','checkbox','radio'].includes(el.role)).slice(0,48)},{semantics:true}),pendingVerification,submissionStarted:!!session.submissionStarted,paymentStarted:!!session.paymentStarted});
        const step=validateStep(await planWithinBudget({order,workflow:program.workflow,observation,history,memory,context:{pendingVerification,couponApplied,receipt:session.receipt,submissionStarted:session.submissionStarted,paymentStarted:session.paymentStarted},feedback,image,signal}));
        emit('动态计划',{step:index+1,observationId:observation.observationId,url:observation.url,plan:diagnosticAIOutput(step),remainingMs:Math.max(0,deadline-Date.now()),action:step.action,reason:step.reason,meanings:[...(step.target?[step.target.meaning]:[]),...Object.values(step.bindings||{}).map(target=>target.meaning)]});
        feedback=null;image=null;signal?.throwIfAborted();currentAction=step.action;stage=step.action==='review'?'checkout':step.action==='cart'||step.action==='verify_cart'?'cart':'configuration';
        if(step.action==='stop'){
          const stock=/out\s+of\s+stock|sold\s+out|缺货|无货|售罄/i.test(step.reason+' '+(observation.text||''));
          throw agentError(stock?'ORDER_OUT_OF_STOCK':'AGENT_NEEDS_INPUT',step.reason);
        }
        if(session.submissionStarted&&!['invoice','pay'].includes(step.action))throw agentError('AGENT_PLAN_INVALID',"订单已提交，只能处理原订单账单");
        if(pendingVerification==='cart'&&step.action!=='verify_cart')throw agentError('AGENT_STEP_UNVERIFIED',"购物车操作后必须先核验商品和数量");
        let result;
        if(step.action==='wait'){
          const milliseconds=Number(step.value);if(!Number.isInteger(milliseconds)||milliseconds<100||milliseconds>2000)throw agentError('AGENT_PLAN_INVALID','等待必须在 100 到 2000 毫秒之间');
          result=await methods.pause(milliseconds);
        }else if(['fill','select','check','uncheck','click','configure','cart','choosePayment','invoice'].includes(step.action)){
          const target=await resolve(step.target);
          if(step.action==='choosePayment')result=await methods.choosePayment({selector:target,value:step.value});
          else {if(step.action==='cart')pendingVerification='cart';result=await methods[step.action](target,...(['fill','select'].includes(step.action)?[step.value]:[]));}
          if(['fill','select','check','uncheck'].includes(step.action)){
            const actual=await read(step.target);
            const expected=step.action==='select'&&actual.selectedValue===undefined?observation.elements.find(el=>el.ref===step.target.ref)?.options?.find(option=>option.value===String(step.value))?.text:step.value;
            const observedValue=step.action==='select'?(actual.selectedValue??actual.value):actual.value;
            const matched=['check','uncheck'].includes(step.action)?actual.checked===(step.action==='check'):expected!==undefined&&String(observedValue)===String(expected);
            emit('输入核验',{action:step.action,target:step.target,matched,...(['check','uncheck'].includes(step.action)?{expectedChecked:step.action==='check',observedChecked:actual.checked}:{expectedLength:String(expected??'').length,observedLength:String(observedValue??'').length})});
            if(step.action==='check'||step.action==='uncheck'){if(actual.checked!==(step.action==='check'))throw agentError('AGENT_STEP_UNVERIFIED',"网站未接受勾选状态");}
            else if(!matched)throw agentError('AGENT_STEP_UNVERIFIED',"实际输入或选项与计划不符");
          }
          if(step.action==='cart'||result?.cartMutation)pendingVerification='cart';
        }else if(step.action==='verify_cart'){
          if(!step.bindings?.product||!step.bindings?.quantity)throw agentError('AGENT_STEP_UNVERIFIED',"购物车缺少商品和数量证据");
          const product=await read(step.bindings.product),quantity=await read(step.bindings.quantity);
          const identity=order.product||order.productSelection?.text;
          const matched=!!normalize(product.text)&&(!identity||matchesProductSelection(identity,product.text))&&parseOrderQuantity(quantity.value??quantity.text)===order.quantity;
          emit('购物车核验',{expected:{product:order.product,quantity:order.quantity},observed:{product:product.text,quantity:quantity.value??quantity.text},matched});
          if(!matched)throw agentError('AGENT_STEP_UNVERIFIED',"购物车商品或数量与任务不符");
          pendingVerification=null;
        }else if(step.action==='apply_coupon'){
          if(!order.couponCode)throw agentError('AGENT_PLAN_INVALID',"未授权应用优惠码");
          const checks=await bind(step.bindings,couponKeys),totals=await bind(step.bindings,checkoutKeys);
          result=await methods.applyCoupon(checks,{...totals,semantic:true,confirmationSelector:'[data-agent-confirmation="order"]'},{
            rebind:async()=>{
              const page=await methods.observe();
              const next=validateStep(await planWithinBudget({order,workflow:program.workflow,observation:page,history,memory,context:{pendingVerification:'coupon',receipt:session.receipt},signal}));
              if(next.action!=='verify_coupon')throw agentError('AGENT_STEP_UNVERIFIED','优惠请求后只能重新定位核验字段');
              if(next.paymentMethod)await methods.choosePayment({selector:await resolve(next.paymentMethod.target),value:next.paymentMethod.value});
              return {coupon:await bind(next.bindings,couponKeys),checkout:await bind(next.bindings,checkoutKeys)};
            }
          });couponApplied=true;couponFailed=!!result.couponFailure;
        }else if(step.action==='review'){
          if(!couponApplied)throw agentError('AGENT_STEP_UNVERIFIED',"优惠码尚未由宿主验证");
          const checks=await bind(step.bindings,checkoutKeys),verifiedConfiguration=await configuration(step);
          if(order.couponCode&&!couponFailed){
            const proof=await bind(step.bindings,{appliedCode:'appliedCodeSelector',discount:'discountSelector'});
            await methods.rebindCoupon(proof);
          }
          result=await methods.submit({...checks,semantic:true,configuration:verifiedConfiguration,confirmationSelector:'[data-agent-confirmation="order"]'});
          if(result.status==='prepared'||order.executionMode!=='pay'||result.status==='awaiting_payment'){
            if(session.receipt?.status!==result.status)throw agentError('AGENT_STEP_UNVERIFIED',"缺少宿主核验的订单结果");
            history.push({action:step.action,pageType:pageType(observation),meanings:Object.values(step.bindings).map(t=>t.meaning),verified:true});
            emit('动态步骤完成',{...history.at(-1),step:index+1,durationMs:Date.now()-stepStarted,receipt:diagnosticReceipt(result)});
            await onLearn({history,status:result.status});return result;
          }
        }else if(step.action==='pay'){
          if(order.executionMode!=='pay'||session.receipt?.status!=='ordered'||session.paymentStarted)throw agentError('AGENT_PLAN_INVALID',"未授权付款或原订单状态不确定");
          const checks=await bind(step.bindings,paymentKeys,['pay','invoice','total','currency']);
          if(step.paymentMethod)checks.paymentMethod={selector:await resolve(step.paymentMethod.target),value:step.paymentMethod.value};
          result=await methods.pay({...checks,semantic:true,confirmationSelector:'[data-agent-confirmation="payment"]'});
          if(!['paid','awaiting_payment'].includes(result.status)||session.receipt?.status!==result.status)throw agentError('AGENT_STEP_UNVERIFIED',"网站尚未提供已核验的付款结果");
          history.push({action:step.action,pageType:pageType(observation),meanings:Object.values(step.bindings).map(t=>t.meaning),verified:true});
          emit('动态步骤完成',{...history.at(-1),step:index+1,durationMs:Date.now()-stepStarted,receipt:diagnosticReceipt(result)});
          await onLearn({history,status:result.status});return result;
        }
        const entry={action:step.action,pageType:pageType(observation),meanings:[...(step.target?[step.target.meaning]:[]),...Object.values(step.bindings||{}).map(t=>t.meaning)],verified:true};
        history.push(entry);if(['verify_cart'].includes(step.action))completed.add(step.action);emit('动态步骤完成',{...entry,step:index+1,durationMs:Date.now()-stepStarted,pendingVerification,receipt:diagnosticReceipt(result)});
      }catch(error){
        const recoveryAllowed=autoRepair&&canRecover(error,session,{signal,attempts:repairs});
        emit('动态步骤失败',{step:index+1,observationId:observation.observationId,url:observation.url,durationMs:Date.now()-stepStarted,error:diagnosticError(error),pendingVerification,recovery:{enabled:autoRepair,allowed:recoveryAllowed,attempts:repairs,maxAttempts:2},transaction:{submissionStarted:!!session.submissionStarted,paymentStarted:!!session.paymentStarted,receiptStatus:session.receipt?.status}});
        if(!recoveryAllowed)throw error;
        repairs++;const recovered=await recoveryContext(error,session,history,{signal,run:fn=>abortable(fn,signal)});stagnant=0;
        await onLearn({history:[...history,{action:'recover',pageType:pageType(observation),meanings:[],verified:false}],status:'recovery',error});
        feedback=recovered.feedback;image=recovered.image;history.push({action:'recover',pageType:pageType(recovered.observation),meanings:[],verified:false});
        emit('重新观察并修复',{attempt:repairs,maxAttempts:2,evidenceId:feedback.evidenceId,url:feedback.url,observationId:recovered.observation.observationId,error:feedback.error,historySteps:history.length,pendingVerification});
      }
    }
    throw agentError('AGENT_BUDGET_EXCEEDED',"动态执行达到最大操作数");
  }catch(error){error.orderFailure=orderFailure(error,{stage,action:currentAction,submissionStarted:session.submissionStarted,paymentStarted:session.paymentStarted});error.orderPreparation={verifiedStages:[...completed],observedSteps:history.filter(item=>item.verified).map(({action,pageType})=>({action,pageType})),pending:['checkout','request_contract','two_preflights'],candidates:[],at:new Date().toISOString()};await onLearn({history,status:'failed',error}).catch(()=>{});throw error;}
  finally{budget.close();}
}
