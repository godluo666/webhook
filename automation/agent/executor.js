import {validateStep} from './planner.js';
import {agentError,validateTarget} from './model.js';
import {canRecover,recoveryContext} from './recovery.js';
import {pageType} from '../adapters/generic-commerce.js';
const checkoutKeys={submit:'submitSelector',product:'productSelector',quantity:'quantitySelector',total:'totalSelector',currency:'currencySelector'};
const couponKeys={input:'inputSelector',apply:'applySelector',appliedCode:'appliedCodeSelector',discount:'discountSelector'};
const paymentKeys={pay:'paySelector',invoice:'invoiceSelector',total:'totalSelector',currency:'currencySelector',balance:'balanceSelector',balanceCurrency:'balanceCurrencySelector',pending:'pendingSelector'};
const normalize=value=>String(value).normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
export async function runCommerceAgent(program,order,session,{plan,signal,memory=null,onEvent=()=>{},onLearn=async()=>{},maxSteps=40,timeoutMs=180000,autoRepair=true}={}){
  if(!plan||!session.methods.observe||!session.methods.resolveSemantic)throw agentError('AGENT_UNAVAILABLE',"浏览器缺少语义观察和动态规划能力");
  const methods=session.methods,history=[],deadline=Date.now()+timeoutMs;
  let repairs=0,pendingVerification=null,couponFailed=false,couponApplied=!order.couponCode,feedback=null,image=null;
  const resolve=async target=>{validateTarget(target);const located=await methods.resolveSemantic(target);onEvent('语义定位',{meaning:target.meaning,strategy:located.strategy,confidence:target.confidence});return located.selector;};
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
      if(normalize(observed.value??observed.text)!==normalize(required.value))throw agentError('AGENT_CONFIGURATION_UNVERIFIED',"商品配置与已确认要求不符："+required.name);
      values.push({...required,selector:await resolve(items[0].target)});
    }return values;
  };
  try{
    for(let index=0;index<maxSteps;index++){
      signal?.throwIfAborted();if(Date.now()>deadline)throw agentError('AGENT_BUDGET_EXCEEDED',"动态执行已超时");
      session.keepAlive?.(Math.max(1000,deadline-Date.now()));
      const observation=await methods.observe();
      try{
        const step=validateStep(await plan({order,workflow:program.workflow,observation,history,memory,context:{pendingVerification,couponApplied,receipt:session.receipt,submissionStarted:session.submissionStarted,paymentStarted:session.paymentStarted},feedback,image,signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(Math.max(1,deadline-Date.now()))])}));
        onEvent('动态计划',{action:step.action,reason:step.reason,meanings:[...(step.target?[step.target.meaning]:[]),...Object.values(step.bindings||{}).map(target=>target.meaning)]});
        feedback=null;image=null;signal?.throwIfAborted();
        if(step.action==='stop')throw agentError('AGENT_NEEDS_INPUT',step.reason);
        if(session.submissionStarted&&!['invoice','pay'].includes(step.action))throw agentError('AGENT_PLAN_INVALID',"订单已提交，只能处理原订单账单");
        if(pendingVerification==='cart'&&step.action!=='verify_cart')throw agentError('AGENT_STEP_UNVERIFIED',"购物车操作后必须先核验商品和数量");
        let result;
        if(['fill','select','check','uncheck','click','cart','choosePayment','invoice'].includes(step.action)){
          const target=await resolve(step.target);
          if(step.action==='choosePayment')result=await methods.choosePayment({selector:target,value:step.value});
          else {if(step.action==='cart')pendingVerification='cart';result=await methods[step.action](target,...(['fill','select'].includes(step.action)?[step.value]:[]));}
          if(['fill','select','check','uncheck'].includes(step.action)){
            const actual=await read(step.target);
            const expected=step.action==='select'?observation.elements.find(el=>el.ref===step.target.ref)?.options?.find(option=>option.value===String(step.value))?.text:step.value;
            if(step.action==='check'||step.action==='uncheck'){if(actual.checked!==(step.action==='check'))throw agentError('AGENT_STEP_UNVERIFIED',"网站未接受勾选状态");}
            else if(expected===undefined||String(actual.value)!==String(expected))throw agentError('AGENT_STEP_UNVERIFIED',"实际输入或选项与计划不符");
          }
          if(step.action==='cart')pendingVerification='cart';
        }else if(step.action==='verify_cart'){
          if(!step.bindings?.product||!step.bindings?.quantity)throw agentError('AGENT_STEP_UNVERIFIED',"购物车缺少商品和数量证据");
          const product=await read(step.bindings.product),quantity=await read(step.bindings.quantity);
          if(!normalize(product.text)||order.product&&normalize(product.text)!==normalize(order.product)||Number(quantity.value??quantity.text)!==order.quantity)throw agentError('AGENT_STEP_UNVERIFIED',"购物车商品或数量与任务不符");
          pendingVerification=null;
        }else if(step.action==='apply_coupon'){
          if(!order.couponCode)throw agentError('AGENT_PLAN_INVALID',"未授权应用优惠码");
          const checks=await bind(step.bindings,couponKeys),totals=await bind(step.bindings,checkoutKeys);
          result=await methods.applyCoupon(checks,{...totals,semantic:true,confirmationSelector:'[data-agent-confirmation="order"]'},{
            rebind:async()=>{
              const page=await methods.observe();
              const next=validateStep(await plan({order,workflow:program.workflow,observation:page,history,memory,context:{pendingVerification:'coupon',receipt:session.receipt},signal}));
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
            await onLearn({history,status:result.status});return result;
          }
        }else if(step.action==='pay'){
          if(order.executionMode!=='pay'||session.receipt?.status!=='ordered'||session.paymentStarted)throw agentError('AGENT_PLAN_INVALID',"未授权付款或原订单状态不确定");
          const checks=await bind(step.bindings,paymentKeys,['pay','invoice','total','currency']);
          if(step.paymentMethod)checks.paymentMethod={selector:await resolve(step.paymentMethod.target),value:step.paymentMethod.value};
          result=await methods.pay({...checks,semantic:true,confirmationSelector:'[data-agent-confirmation="payment"]'});
          if(!['paid','awaiting_payment'].includes(result.status)||session.receipt?.status!==result.status)throw agentError('AGENT_STEP_UNVERIFIED',"网站尚未提供已核验的付款结果");
          history.push({action:step.action,pageType:pageType(observation),meanings:Object.values(step.bindings).map(t=>t.meaning),verified:true});
          await onLearn({history,status:result.status});return result;
        }
        const entry={action:step.action,pageType:pageType(observation),meanings:[...(step.target?[step.target.meaning]:[]),...Object.values(step.bindings||{}).map(t=>t.meaning)],verified:true};
        history.push(entry);onEvent('动态步骤完成',{...entry,step:index+1});
      }catch(error){
        onEvent('动态步骤失败',{step:index+1,error:{code:error.code,message:error.message}});
        if(!autoRepair||!canRecover(error,session,{signal,attempts:repairs}))throw error;
        repairs++;const recovered=await recoveryContext(error,session,history);
        await onLearn({history:[...history,{action:'recover',pageType:pageType(observation),meanings:[],verified:false}],status:'recovery',error});
        feedback=recovered.feedback;image=recovered.image;history.push({action:'recover',pageType:pageType(recovered.observation),meanings:[],verified:false});
        onEvent('重新观察并修复',{attempt:repairs,evidenceId:feedback.evidenceId});
      }
    }
    throw agentError('AGENT_BUDGET_EXCEEDED',"动态执行达到最大操作数");
  }catch(error){await onLearn({history,status:'failed',error}).catch(()=>{});throw error;}
}
