import {randomUUID} from 'node:crypto';
import {agentError} from './model.js';
import {validateStep} from './planner.js';
import {flowContext,stageForAction,assertFlowStep,resolveValueSource} from './flow-template.js';
import {planningObservation} from './observation-context.js';
export {planningObservation} from './observation-context.js';

const norm=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
const controls=new Set(['link','button','textbox','spinbutton','combobox','checkbox','radio']);
const settings=new Set(['fill','select','check','uncheck','choosePayment']);
const unique=items=>items.length===1?items[0]:null;
const numericShape=value=>norm(value).replace(/\d+(?:[.,]\d+)*/g,'#');
const amountSlots=new Set(['bindings.total','bindings.discount','bindings.balance']);
const visible=el=>!!el&&el.visible!==false&&!el.disabled&&!['hidden','password'].includes(el.type);
function scopeFor(input){
  const url=new URL(input.observation.url),context=input.context||{};
  return {origin:url.origin,path:url.pathname,query:url.search,fragment:url.hash,phase:flowContext(input).phase,couponApplied:context.couponApplied??!input.order?.couponCode,receipt:context.receipt?.status||null};
}
const scopeKey=input=>JSON.stringify(scopeFor(input));
function describe(el,slot,page){
  if(!el)return null;
  const cues=Object.fromEntries(['name','label','accessibleName','text','placeholder','href'].filter(key=>el[key]!=null&&el[key]!=='').map(key=>[key,String(el[key])]));
  // Current amounts are read again by the host. Their numeric value is not a locator.
  const dynamicText=amountSlots.has(slot);
  if(dynamicText)for(const key of ['text','accessibleName'])if(cues[key]&&/\d/.test(cues[key]))cues[key]=numericShape(cues[key]);
  const form=page.forms?.find(form=>form.ref===el.formRef);
  if(!Object.keys(cues).length)return null;
  return {role:el.role||null,tag:el.tag,type:el.type||null,cues,dynamicText,context:dynamicText?numericShape(el.contextText):norm(el.contextText),...(form?{form:{method:form.method,action:form.action}}:{})};
}
function compatible(descriptor,el){
  if(el.type==='password')return false;
  if(controls.has(descriptor.role))return el.role===descriptor.role&&(!descriptor.type||el.type===descriptor.type);
  return !controls.has(el.role);
}
function locate(descriptor,page){
  if(!descriptor?.cues)return null;
  const owned=el=>{
    if(!descriptor.actionTarget)return true;
    if(descriptor.cues.href&&norm(el.href)===norm(descriptor.cues.href))return true;
    if(descriptor.form){const form=page.forms?.find(form=>form.ref===el.formRef);if(form&&form.method===descriptor.form.method&&form.action===descriptor.form.action)return true;}
    if(descriptor.context&&norm(el.contextText)===descriptor.context)return true;
    return !descriptor.context&&!descriptor.form&&!descriptor.cues.href&&page.url===descriptor.route;
  };
  const candidates=(page.elements||[]).filter(el=>compatible(descriptor,el)&&owned(el));
  const compare=(key,el)=>descriptor.dynamicText&&['text','accessibleName'].includes(key)?numericShape(el[key]):norm(el[key]);
  const anchors=[],matches=[];
  for(const [key,value]of Object.entries(descriptor.cues)){
    const found=candidates.filter(el=>el[key]!=null&&compare(key,el)===norm(value));
    if(found.length){matches.push(found);if(found.length===1)anchors.push(found[0]);}
  }
  const distinct=[...new Set(anchors)];
  // Conflicting names/labels are a changed binding, never a reason to pick the first.
  if(distinct.length>1)return null;
  if(distinct.length===1)return distinct[0];
  if(!matches.length)return null;
  let remaining=candidates.filter(el=>matches.every(found=>found.includes(el)));
  if(descriptor.form)remaining=remaining.filter(el=>{
    const form=page.forms?.find(form=>form.ref===el.formRef);
    return form&&form.method===descriptor.form.method&&form.action===descriptor.form.action;
  });
  const contextual=remaining.filter(el=>descriptor.context&&(descriptor.dynamicText?numericShape(el.contextText):norm(el.contextText))===descriptor.context);
  return unique(remaining)||unique(contextual);
}
function transformTargets(step,convert){
  const result=structuredClone(step);
  if(result.target)result.target=convert(result.target,'target');
  if(result.bindings)for(const key of Object.keys(result.bindings))result.bindings[key]=convert(result.bindings[key],'bindings.'+key);
  if(result.configuration)for(const item of result.configuration)item.target=convert(item.target,'configuration.'+item.name);
  if(result.paymentMethod)result.paymentMethod.target=convert(result.paymentMethod.target,'paymentMethod');
  return result;
}
function compile(step,input,{group,transient=false}={}){
  if(!transient&&['stop','wait','pay','invoice'].includes(step.action))return null;
  try{
    const template=transformTargets(step,(value,slot)=>{
      const descriptor=describe(input.observation.elements?.find(el=>el.ref===value.ref),slot,input.observation);
      if(!descriptor)throw new Error('No observed binding');
      if(slot==='target'&&['click','cart','configure','invoice'].includes(step.action)){descriptor.actionTarget=true;descriptor.route=input.observation.url;}
      return {meaning:value.meaning,confidence:value.confidence,descriptor};
    });
    const el=input.observation.elements.find(el=>el.ref===step.target?.ref);
    const option=['select','choosePayment'].includes(step.action)?el?.options?.find(option=>String(option.value)===String(step.value)):null;
    return {version:2,group,scope:scopeFor(input),stage:stageForAction(step.action),template,...(option?{optionText:option.text}:{})};
  }catch{return null;}
}
function restore(recipe,input){
  if(recipe.version!==2||JSON.stringify(recipe.scope)!==scopeKey(input))return null;
  try{
    let step=transformTargets(recipe.template,value=>{
      const el=locate(value.descriptor,input.observation);
      if(!el)throw new Error('Current binding is missing or ambiguous');
      return {meaning:value.meaning,confidence:value.confidence,ref:el.ref};
    });
    if(step.target&&step.action!=='stop'){
      const el=input.observation.elements.find(el=>el.ref===step.target.ref);
      if(!visible(el))return null;
    }
    if(recipe.optionText&&!step.valueFrom){
      const el=input.observation.elements.find(el=>el.ref===step.target?.ref);
      const option=unique((el?.options||[]).filter(option=>!option.disabled&&norm(option.text)===norm(recipe.optionText)));
      if(!option)return null;
      step.value=option.value;
    }
    step=resolveValueSource(step,input);
    return assertFlowStep(validateStep(step),input);
  }catch{return null;}
}
function selected(step,page){
  const el=page.elements?.find(item=>item.ref===step.target?.ref);
  if(!el)return false;
  if(step.action==='fill')return String(el.value)===String(step.value);
  if(step.action==='select'||step.action==='choosePayment'&&el.options)return !!el.options?.some(option=>option.selected&&(step.value===undefined||String(option.value)===String(step.value)));
  if(step.action==='choosePayment'&&el.type==='radio')return el.checked===true&&(step.value===undefined||String(el.value)===String(step.value));
  if(['check','uncheck'].includes(step.action))return el.checked===(step.action==='check');
  return false;
}
function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])]));
  return value;
}
const actionKey=step=>JSON.stringify(stable({...step,reason:undefined}));
function recipeKey(recipe){
  if(recipe?.version!==2||!recipe.template)return null;
  const template=transformTargets(recipe.template,target=>({descriptor:target.descriptor}));
  return JSON.stringify(stable({scope:recipe.scope,template:{...template,reason:undefined},optionText:recipe.optionText}));
}
function satisfied(step,recipe,input,completed){
  if(step.action==='choosePayment'){
    if(!selected(step,input.observation))return false;
    // A selected control does not prove that this host registered the payment intent.
    // A recreated DOM node loses the host marker and must be registered again.
    if(Object.prototype.hasOwnProperty.call(input.observation,'paymentChoice')){
      const proof=input.observation.paymentChoice;
      return !!proof&&proof.ref===step.target.ref&&proof.url===input.observation.url&&(step.value===undefined||String(proof.value)===String(step.value));
    }
    return completed.has(recipeKey(recipe));
  }
  if(settings.has(step.action))return selected(step,input.observation);
  return completed.has(recipeKey(recipe));
}
async function rememberedStep(recipes,input,completed,onSatisfied){
  const groups=new Map();
  for(const recipe of recipes){
    if(recipe.version!==2||JSON.stringify(recipe.scope)!==scopeKey(input))continue;
    const list=groups.get(recipe.group)||[];list.push(recipe);groups.set(recipe.group,list);
  }
  const candidates=[];
  for(const group of groups.values()){
    for(const recipe of group){
      const done=completed.has(recipeKey(recipe));
      if(done&&!settings.has(recipe.template.action))continue;
      const step=restore(recipe,input);
      // Completed nodes can disappear after a same-page transition. Only the next
      // unfinished node must bind; an old hidden control cannot invalidate the tail.
      if(!step){if(done)continue;break;}
      if(satisfied(step,recipe,input,completed)){await onSatisfied(step,recipe,input);continue;}
      candidates.push({recipe,step});break;
    }
  }
  const configurations=candidates.filter(item=>settings.has(item.step.action));
  const pool=configurations.length?configurations:candidates;
  const distinct=[...new Map(pool.map(item=>[actionKey(item.step),item])).values()];
  return distinct.length===1?distinct[0]:null;
}
export function clarificationFor(error,observation){
  const candidates=(observation.elements||[]).filter(el=>visible(el)&&controls.has(el.role)).sort((a,b)=>Number(a.role==='link')-Number(b.role==='link')).map(el=>({label:el.label||el.accessibleName||el.text||el.name,context:String(el.contextText||'').slice(0,300),options:el.options?.map(({text})=>text)})).filter(el=>el.label).slice(0,12);
  return {kind:'page_step',question:'请确认当前步骤应操作哪个商品、配置项或入口。',reason:error.message,url:observation.url,candidates};
}
const needsInput=(message,observation)=>Object.assign(agentError('AGENT_NEEDS_INPUT',message),{orderInput:clarificationFor(new Error(message),observation)});
export function createAssistedPlanner(assist,{recipes=[],onRemember=()=>{},onEvent=()=>{},allowAssistance=true,onSatisfied=async()=>{}}={}){
  let lastInput,lastStep,lastRecipe,pending=[];
  const failedPages=new Map(),metadata=new WeakMap(),completed=new Set(),completedClicks=[];
  const rememberRecipe=recipe=>{const key=recipeKey(recipe);completed.add(key);if(!recipes.some(item=>recipeKey(item)===key)){recipes.push(recipe);onRemember(recipes);}};
  const invalidate=recipe=>{
    if(!recipe)return;
    const index=recipes.indexOf(recipe),key=recipeKey(recipe);let changed=false;
    // Keep the successful prefix but remove the failed node and dependent tail.
    for(let i=recipes.length-1;i>=0;i--)if(recipeKey(recipes[i])===key||index>=0&&i>=index&&recipes[i].group===recipe.group){recipes.splice(i,1);changed=true;}
    completed.delete(key);if(changed)onRemember(recipes);
  };
  const acceptSatisfied=async(step,recipe,input)=>{
    if(settings.has(step.action)&&step.action!=='choosePayment'){
      try{await onSatisfied(step,input);}catch(error){invalidate(recipe);throw error;}
    }
    rememberRecipe(recipe);
  };
  const planner=async input=>{
    lastInput=input;lastStep=null;lastRecipe=null;
    let step,group,recipe,source='learned';
    if(!input.feedback){
      while(pending.length&&!step){
        const next=pending.shift(),restored=restore(next,input);
        if(!restored){if(completed.has(recipeKey(next)))continue;pending=[];break;}
        if(satisfied(restored,next,input,completed)){await acceptSatisfied(restored,next,input);continue;}
        step=restored;recipe=next;group=next.group;source='assisted_flow';
      }
      if(!step){
        const found=await rememberedStep(recipes,input,completed,acceptSatisfied);
        if(found){lastRecipe=found.recipe;recipe=found.recipe;step=found.step;group=found.recipe.group;}
      }
    }
    if(!step){
      if(!allowAssistance)throw needsInput('当前步骤的已学绑定失效，且本任务已关闭自动辅助；请确认页面步骤后重新生成。',input.observation);
      source='ai_assistance';group=randomUUID();
      const key=scopeKey(input);
      if((failedPages.get(key)||0)>=2)throw needsInput('当前步骤的动态绑定仍不确定，需要你确认。',input.observation);
      try{
        const current=recipes.filter(item=>item.version===2&&JSON.stringify(item.scope)===key);
        const knownSteps=[...new Map(current.map(item=>{const state={stage:item.stage,action:item.template.action,completed:completed.has(recipeKey(item)),needsBinding:!completed.has(recipeKey(item))&&!restore(item,input)};return [JSON.stringify(state),state];})).values()];
        const focusRefs=current.flatMap(item=>{const restored=restore(item,input);if(!restored)return [];const refs=[];transformTargets(restored,target=>{refs.push(target.ref);return target;});return refs;});
        const observation=planningObservation(input.observation,{...input,focusRefs});
        const result=await assist({...input,flow:{...flowContext(input),knownSteps},observation});
        const observedRefs=new Set(observation.elements.map(el=>el.ref));
        const steps=(result.steps||[result]).map(value=>{
          const validated=resolveValueSource(validateStep(value),input);
          transformTargets(validated,(target,slot)=>{
            if(!observedRefs.has(target.ref))throw needsInput('当前页面摘要没有这个操作所需的元素，请确认缺少的区域或下一入口。',input.observation);
            const displayed=observation.elements.find(el=>el.ref===target.ref);
            if(displayed.omittedMatchingControls){
              const actual=input.observation.elements.find(el=>el.ref===target.ref),descriptor=describe(actual,slot,input.observation);
              if(!descriptor||locate(descriptor,input.observation)?.ref!==target.ref)throw needsInput('页面还有同名候选，当前区域证据无法唯一确定操作对象，请确认具体商品或控件。',input.observation);
            }
            return target;
          });
          return validated;
        });
        if(steps.length<1||steps.length>20||steps.slice(0,-1).some(value=>!settings.has(value.action)))throw agentError('AGENT_PLAN_INVALID','每页流程须在导航或交易后重新观察');
        for(const value of steps)assertFlowStep(value,input);
        step=steps[0];recipe=compile(step,input,{group,transient:true});
        pending=steps.slice(1).map(next=>{
          const compiled=compile(next,input,{group,transient:true});
          if(!compiled)throw agentError('AGENT_PLAN_INVALID','当前步骤缺少可观察的动态绑定');
          return compiled;
        });
      }catch(error){
        if(['AGENT_LOW_CONFIDENCE','AGENT_PLAN_INVALID','AGENT_STEP_UNVERIFIED'].includes(error.code))failedPages.set(key,(failedPages.get(key)||0)+1);
        if(error.code==='AGENT_LOW_CONFIDENCE')error.orderInput=clarificationFor(error,input.observation);
        throw error;
      }
    }
    if(step.action==='click'&&completedClicks.some(item=>JSON.stringify(item.scope)===scopeKey(input)&&locate({...item.template.target.descriptor,actionTarget:false},input.observation)?.ref===step.target?.ref))throw needsInput('这个入口已成功操作，当前页面仍未显示可继续的步骤，请确认展开后的配置或下一入口。',input.observation);
    if(recipe&&completed.has(recipeKey(recipe))&&!settings.has(step.action))throw needsInput('当前步骤已经完成，页面未出现可确认的下一步；请确认当前状态。',input.observation);
    lastStep=validateStep(step);metadata.set(lastStep,{group,recipe});
    onEvent('步骤来源',{source,stage:stageForAction(step.action),action:step.action});return lastStep;
  };
  planner.remember=verified=>{
    const step=verified?.step||lastStep,input=verified?.input||lastInput;
    if(!step||!input)return;
    const meta=metadata.get(step),group=meta?.group||randomUUID();
    const recipe=meta?.recipe||compile(step,input,{group});
    if(!recipe||['stop','wait','pay','invoice'].includes(step.action))return;
    const key=recipeKey(recipe);completed.add(key);failedPages.delete(scopeKey(input));
    if(step.action==='click'&&recipe.template.target&&!completedClicks.some(item=>recipeKey(item)===key))completedClicks.push(recipe);
    rememberRecipe(recipe);
  };
  planner.reject=details=>{
    const rejected=details&&Object.prototype.hasOwnProperty.call(details,'step')?details.step:lastStep;
    const recipe=rejected&&(metadata.get(rejected)?.recipe||lastRecipe);
    invalidate(recipe);
    pending=[];lastRecipe=null;
  };
  return planner;
}
