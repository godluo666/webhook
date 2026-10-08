import {readOrderTimeouts,requestOrderAI,createOrderDeadline,abortable} from './order-timeouts.js';
import {sameOrderReview} from './order-evidence.js';
import {orderFailure} from './order-diagnostics.js';
const ORDER_SAFETY_VERSION=3;
import {validateBusinessWorkflow} from '../automation/agent/model.js';
import {BUSINESS_PROMPT,createPlanner,isFuturePageEvidenceRefusal} from '../automation/agent/planner.js';
import {runCommerceAgent} from '../automation/agent/executor.js';
import {createSiteMemory} from '../automation/agent/memory.js';
import { randomUUID, createHash } from 'node:crypto';
import { launchCommerceBrowser as createOrderBrowser } from '../automation/browser/launcher.js';
import {discoverCommerceSite} from '../automation/browser/crawler.js';
import { createOrderExecutionLogs, diagnosticError, diagnosticPage, diagnosticReceipt } from './order-execution-log.js';
import { savedOrderAccount, orderAccountFingerprint } from './order-account.js';
import { ORDER_PAYMENT_PROMPT, validateOrderWorkflow, validateOrderProgramScripts, compileOrderWorkflow, runOrderWorkflow, runOrderPaymentCode } from './order-workflow.js';
import { executeOrderScript } from './order-script.js';
import { normalizePaymentMethod, samePaymentChoice } from './order-payment.js';

const required = (value, name, max = 200) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('请填写有效的' + name); return value.trim(); };
export function validateOrderTask(input, current = null) {
  const url = new URL(required(input.url, '商品网址', 2000));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('商品网址必须使用 HTTP 或 HTTPS，且不能包含账号密码');
  const quantity = Number(input.quantity ?? 1), maxTotal = Number(input.maxTotal);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw new Error('购买数量必须是 1 到 10 的整数');
  if (!Number.isFinite(maxTotal) || maxTotal <= 0 || maxTotal > 1_000_000) throw new Error('请设置有效的订单总价上限');
  const currency = String(input.currency || '').trim().toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error('币种需要使用三位代码，例如 USD');
  if (!['prepare', 'submit', 'pay'].includes(input.executionMode || 'prepare')) throw new Error('执行范围无效');
  let affiliateUrl = '';
  if(input.affiliateUrl){const aff=new URL(required(input.affiliateUrl,'AFF 链接',2000));if(!['http:','https:'].includes(aff.protocol)||aff.username||aff.password)throw new Error('AFF 链接必须使用不带凭据的 HTTP 或 HTTPS 地址');affiliateUrl=aff.href;}
  let productSelection = null;
  if(input.productSelection){
    const choice=input.productSelection,choiceUrl=new URL(required(choice.url,'选中商品页面',2000));
    if(choiceUrl.href!==url.href||choiceUrl.username||choiceUrl.password)throw new Error('点选商品的页面已变化，请重新点选');
    productSelection={url:choiceUrl.href,selector:required(choice.selector,'点选商品区域',500),text:required(choice.text,'点选商品内容',300)};
  }
  const couponFailurePolicy=input.couponFailurePolicy??'stop';
  if(!['stop','continue'].includes(couponFailurePolicy))throw new Error('优惠码失败处理需要选择停止或继续下单');
  const couponCode=input.couponCode==null?'':input.couponCode;
  if(typeof couponCode!=='string'||couponCode.length>128||/[\x00-\x1f\x7f]/.test(couponCode))throw new Error('优惠码需要是最多 128 字符的单行文本');
  const product=String(input.product||'').trim();if(product.length>200)throw new Error('商品名称或型号过长');
  const username = String(input.username || '').trim(), password = String(input.password || '');
  if (username.length > 254 || password.length > 512) throw new Error('网站账号信息过长');
  return { id: current?.id || randomUUID(), label: required(input.label || product.slice(0,60) || '自动下单', '任务名称', 60), url: url.href,
    product, productSelection, verifiedProduct:null, verifiedCurrency:null, paymentMethod:normalizePaymentMethod(input.paymentMethod), verifiedPaymentMethod:null, paymentOptions:[], instruction: required(input.instruction || '按配置选择该商品，保留默认配置，在提交前核对订单。', '下单要求', 2000),
    quantity, maxTotal, currency, couponCode:couponCode.trim(), couponFailurePolicy, executionMode: input.executionMode || 'prepare', monitorId: required(input.monitorId,'对应监控',100), affiliateUrl, autoRepair:input.autoRepair!==false, accountFingerprint:null,
    credentials: input.clearCredentials ? {} : { ...(current?.url && new URL(current.url).origin === url.origin ? current.credentials || {} : {}), ...(username ? {username} : {}), ...(password ? {password} : {}) },
    monitorFingerprint: null, enabled: false, status: 'draft', program: null, approvedHash: null, trial: null, result: null, validation:null, stockAuthorization:null,preparation:null,failure:null,submissionContract:null,
    createdAt: current?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), revision: (current?.revision || 0) + 1 };
}
export function validateOrderProgram(value,{requireWorkflow=false}={}) {
  if (!value || typeof value !== 'object') throw new Error('AI 没有生成有效的下单程序');
  if(value.workflow?.version===2)return {workflow:validateBusinessWorkflow(value.workflow),summary:required(value.summary,'业务流程说明',1500),generatedAt:new Date().toISOString()};
  const workflow=validateOrderWorkflow(value.workflow,{required:requireWorkflow});
  const fields = ['submitSelector', 'productSelector', 'quantitySelector', 'totalSelector', 'currencySelector', 'confirmationSelector'];
  const checkout = Object.fromEntries(fields.map(key => [key, required(value.checkout?.[key], '订单核对字段 ' + key, 500)]));
  const coupon=value.coupon?Object.fromEntries(['inputSelector','applySelector','appliedCodeSelector','discountSelector'].map(key=>[key,required(value.coupon[key],'优惠码核对字段 '+key,500)])):null;
  const affiliate = value.affiliate ? Object.fromEntries(['queryKey','cookieName','fieldSelector'].filter(key=>value.affiliate[key]).map(key=>[key,required(value.affiliate[key],'AFF 核对字段 '+key,500)])) : null;
  const code=workflow?compileOrderWorkflow(workflow,checkout,coupon):required(value.code,'AI 下单代码',24000);
  return { code, checkout, affiliate, ...(coupon?{coupon}:{}), ...(workflow?{workflow}:{}), summary: required(value.summary, '下单步骤说明', 1500), generatedAt: new Date().toISOString() };
}
export function orderProgramHash(task) {
  return createHash('sha256').update(JSON.stringify([ORDER_SAFETY_VERSION,task.submissionContract||null,task.program, task.url, task.product, task.productSelection || null, task.verifiedProduct || null, task.verifiedCurrency || null, normalizePaymentMethod(task.paymentMethod), task.verifiedPaymentMethod || null, task.instruction, task.quantity, task.maxTotal, task.currency, task.executionMode, task.monitorId, task.monitorFingerprint, task.accountFingerprint, task.affiliateUrl, task.autoRepair, task.revision,...(task.couponCode?[task.couponCode]:[]),...(task.couponCode&&task.couponFailurePolicy==='continue'?['coupon-failure:continue']:[])])).digest('hex');
}
function monitorFingerprint(user, task) {
  if (!task.monitorId) throw new Error('请将自动下单附加到对应监控');
  const monitor = user.monitors.find(item => item.id === task.monitorId && item.kind !== 'reminder');
  if (!monitor) throw new Error('绑定的监控已删除，请重新选择触发监控');
  const fields = ['id','kind','type','url','keyword','mode','path','expectedValue','threshold','plan','condition','target_element','extraction_rule','endpoint'];
  return createHash('sha256').update(JSON.stringify(fields.map(key => monitor[key]))).digest('hex');
}
export function publicOrderTask(task) {
  const { credentials, ...publicValue } = task;
  return { ...publicValue, hasCredentials: Boolean(credentials?.username && credentials?.password) };
}
export function createOrderService({ persist, withProxy = async (_url, fn) => fn(''), sourceOptions = () => ({}), requestAI, openBrowser = createOrderBrowser, runScript = executeOrderScript, notify = async () => {}, isAccountBusy = () => false, executionLogs = createOrderExecutionLogs({persist,sourceOptions}), siteMemory = createSiteMemory(), saveEvidence = async () => null, timeouts = readOrderTimeouts(), aiRetries = 1, aiRetryDelayMs = 1000 }) {
  const {aiTimeoutMs,agentTimeoutMs,trialTimeoutMs}={...readOrderTimeouts(),...timeouts};
  const busy = new Set(), cancellations = new Map(), activeLogs = new Map();
  const jobKey = (user, task) => user.id + ':' + task.id;
  const operationLog=(user,task)=>activeLogs.get(jobKey(user,task));
  const logEvent=(user,task,action,data={})=>{
    const current=user.orderTasks.find(item=>item.id===task.id)||task;
    if(current.status==='generating'&&['打开执行浏览器','请求 AI 生成代码','动态计划','动态步骤完成','AI 请求超时，重新请求'].includes(action)){
      current.progress={...(current.progress||{}),...(data.stage?{stage:data.stage}:{}),...(data.step?{step:data.step}:{}),action:data.action||action,at:new Date().toISOString()};persist();
    }
    operationLog(user,task)?.event(action,data);
    if(/^(?:AI 请求|AI 响应|动态步骤失败|重新观察并修复)/.test(action))operationLog(user,task)?.checkpoint();
  };
  const askAI=(user,task,messages,options={})=>requestOrderAI(requestAI,user,messages,{timeoutMs:aiTimeoutMs,maxRetries:aiRetries,retryDelayMs:aiRetryDelayMs,...options,onEvent:(action,data)=>logEvent(user,task,action,data)});
  const phase=(user,task,session,value)=>{session.trace.push({action:'SOP',detail:value,at:new Date().toISOString()});logEvent(user,task,'SOP 阶段',{phase:value});};
  const redact = (user, task, value) => { let text=String(value||'');const account=(user.orderAccounts||[]).find(a=>a.monitorId===task.monitorId);for(const secret of [...Object.values(task.credentials||{}),...Object.values(account?.credentials||{}),...(account?.session?.redactions||[]),user.settings?.aiKey,user.settings?.sourceProxy,user.monitors.find(m=>m.id===task.monitorId)?.sourceProxy])if(secret)text=text.split(secret).join('[已隐藏]');return text.slice(0,1000); };
  const available = (user,task) => { if(busy.has(jobKey(user,task))||user.orderTasks.some(t=>t!==task&&t.monitorId===task.monitorId&&busy.has(jobKey(user,t))))throw new Error('此监控的下单任务正在执行');if(isAccountBusy(user,task.monitorId))throw new Error('请先结束当前账户登录操作');if(busy.size>=2)throw new Error('下单服务繁忙，请稍后再试'); };
  const browserFor = (user,task,callback,extra={}) => {
    const account=savedOrderAccount(user,task),monitor=user.monitors.find(m=>m.id===task.monitorId);
    return withProxy(sourceOptions(user,monitor||{}).proxyUrl,async proxyUrl=>{
      if(extra.signal?.aborted)throw new Error('操作已停止');
      let session;
      logEvent(user,task,'打开执行浏览器',{stage:extra.logStage||'实际执行'});
      try{
        session=await openBrowser({...task,credentials:{...account.credentials,...Object.fromEntries((account.session.redactions||[]).map((value,i)=>['login'+i,value]))}},{proxyUrl,storageState:account.session.state,sessionStorageState:account.session.sessionStorage,loginCheck:account.session.check,...extra,onEvidence:async evidence=>{const saved=await saveEvidence(user,task,evidence);logEvent(user,task,'页面证据已保存',{stage:evidence.stage,evidenceId:saved?.id});return saved;},onTrace:step=>logEvent(user,task,step.action,{stage:extra.logStage||'实际执行',...step})});
        account.status='saved';account.error='';account.testedAt=new Date().toISOString();
        const originalMethods=session.methods;
        session.methods=Object.fromEntries(Object.entries(originalMethods).map(([name,method])=>[name,async(...args)=>{
          const started=Date.now(),meta={stage:extra.logStage||'实际执行',operation:name,...(args[0]?.ref?{target:{meaning:args[0].meaning,ref:args[0].ref,confidence:args[0].confidence}}:{}),...(typeof args[1]==='string'?{inputLength:args[1].length}:{}),selector:name==='goto'?undefined:typeof args[0]==='string'?args[0]:args[0]?.selector||args[0]?.submitSelector||args[0]?.paySelector||args[0]?.inputSelector,url:name==='goto'?args[0]:undefined};
          logEvent(user,task,'代码操作开始',meta);
          try{const output=await method.apply(originalMethods,args);logEvent(user,task,'代码操作完成',{...meta,durationMs:Date.now()-started,...(name==='exists'?{exists:output}:name==='text'?{textLength:String(output).length}:name==='observe'||name==='snapshot'?{page:diagnosticPage({...output,controls:[]})}:name==='resolveSemantic'?{location:output}:name==='readSemantic'?{textLength:String(output?.text||'').length,valueType:typeof output?.value,valueLength:String(output?.value||'').length}:['submit','pay','invoice','applyCoupon'].includes(name)?{receipt:diagnosticReceipt(output)}:{})});return output;}
          catch(error){logEvent(user,task,'代码操作失败',{...meta,durationMs:Date.now()-started,error:diagnosticError(error)});throw error;}
        }]));
        return await abortable(()=>callback(session),extra.signal);
      }catch(error){let page=error.orderEvidence;try{if(session?.diagnostics)page=await session.diagnostics();}catch{}logEvent(user,task,'浏览器执行失败',{stage:extra.logStage||'实际执行',error:diagnosticError(error),page:diagnosticPage(page)});if(['ORDER_LOGIN_REQUIRED','ORDER_LOGIN_UNVERIFIED'].includes(error.code)){account.status=error.code==='ORDER_LOGIN_REQUIRED'?'expired':'unavailable';account.error=redact(user,task,error.message);persist();}throw error;}
      finally{if(session){if(account.status==='saved'&&session.accountState){const previous=account.session;try{account.session={...previous,...await session.accountState()};persist();}catch(error){account.session=previous;logEvent(user,task,'会话刷新失败',{error:diagnosticError(error)});}}await session.close();logEvent(user,task,'执行浏览器已关闭',{stage:extra.logStage||'实际执行'});operationLog(user,task)?.checkpoint();}}
    });
  };
  const inputFor=task=>({...Object.fromEntries(['url','product','instruction','quantity','maxTotal','currency','executionMode','affiliateUrl','productSelection','paymentMethod','verifiedPaymentMethod','couponCode','couponFailurePolicy'].map(k=>[k,task[k]])),product:task.product||task.verifiedProduct||'',currency:task.currency||task.verifiedCurrency||''});
  const memoryScope=(user,task)=>user.id+':'+task.monitorId;
  const runProgram=async(user,task,session,signal,{discovery=false}={})=>{
    if(task.program?.workflow?.version!==2)return runOrderWorkflow(task.program,inputFor(task),session.methods,{runScript,onPhase:value=>phase(user,task,session,value)});
    const memory=await siteMemory.read(memoryScope(user,task),task.url);
    return (discovery?discoverCommerceSite:runCommerceAgent)(task.program,inputFor(task),session,{
      signal,memory,autoRepair:task.autoRepair,timeoutMs:agentTimeoutMs,plan:createPlanner((messages,options)=>askAI(user,task,messages,{stage:'页面规划',...options})),
      onEvent:(action,data)=>{session.trace.push({action,detail:JSON.stringify(data),at:new Date().toISOString()});logEvent(user,task,action,data);},
      onLearn:async result=>{try{await siteMemory.record(memoryScope(user,task),task.url,result);}catch(error){logEvent(user,task,'网站记忆保存失败',{error:diagnosticError(error)});}}
    });
  };
  const unchanged=(user,task)=>{
    if(task.monitorFingerprint!==monitorFingerprint(user,task))throw new Error('触发监控条件已变化，请重新生成并试跑');
    if(task.accountFingerprint!==orderAccountFingerprint(savedOrderAccount(user,task)))throw new Error('下单账户已变化，请重新生成并试跑');
  };
  async function buildProgram(user,task,signal,initialFeedback=null){
    const evidence=await browserFor(user,{...task,dryRun:true},session=>session.methods.observe?session.methods.observe():session.snapshot(),{signal,logStage:'读取实际商品页面'});
    let feedback=initialFeedback;
    for(let attempt=0;attempt<3;attempt++){
      unchanged(user,task);
      task.validation={syntax:'pending',preflight:'pending',payment:task.executionMode==='pay'?'unverified':'not_requested'};
      logEvent(user,task,'请求 AI 生成代码',{attempt:attempt+1,stage:'生成业务 SOP',model:user.settings?.aiModel});
      const output=await askAI(user,task,[{role:'system',content:BUSINESS_PROMPT},{role:'user',content:JSON.stringify({phase:'business_sop',discovery:{entryOnly:true,followPagesAtRuntime:true,confirmationByHost:true},order:inputFor(task),page:evidence,siteProfile:await siteMemory.read(memoryScope(user,task),task.url),feedback})}],{signal,stage:'生成业务 SOP'});
      if(signal.aborted)throw new Error('代码生成已停止');
      if(output.status==='out_of_stock'){
        task.preparation={...(task.preparation||{}),candidates:evidence.frontend||null,pending:['configuration','checkout','request_contract','two_preflights'],at:new Date().toISOString()};
        if(!output.workflow){
          if(!task.program?.workflow)throw Object.assign(new Error('商品缺货，已保留前端候选线索；配置及结算仍待核验'),{code:'ORDER_OUT_OF_STOCK'});
          Object.assign(output,task.program);
        }
      }
      try{
        if(output.error){const error=new Error(isFuturePageEvidenceRefusal(output.error)?'业务 SOP 不需要未来页面 DOM；浏览器会逐页探索，请只整理目标与配置要求。':output.error);error.code='ORDER_BUSINESS_PLAN_INVALID';throw error;}
        task.program=validateOrderProgram(output,{requireWorkflow:true});
        operationLog(user,task)?.program(task.program,orderProgramHash(task));
        logEvent(user,task,'AI 代码生成完成',{attempt:attempt+1,codeHash:orderProgramHash(task)});
        if(task.executionMode==='pay'&&task.program.workflow.version===1&&!task.program.workflow.paymentCode)throw new Error('自动付款的 SOP 缺少账单定位代码');
        await validateOrderProgramScripts(task.program);
        task.validation={syntax:'passed',preflight:'pending',payment:task.executionMode==='pay'?'unverified':'not_requested'};
        persist();
        let trial,previous;
        for(let pass=0;pass<2;pass++){
        task.progress={stage:'试跑 '+(pass+1)+' / 2',pass:pass+1,step:0,at:new Date().toISOString()};persist();
        trial=await browserFor(user,{...task,dryRun:true},async session=>{
          try{
            const result=await runProgram(user,task,session,signal,{discovery:true});
            if(result.status!=='prepared'||session.receipt?.status!=='prepared')throw new Error('试跑没有到达真实订单核对页面');
            if(previous && (!sameOrderReview(previous.review,session.receipt.review) || Boolean(previous.paymentMethod)!==Boolean(session.receipt.paymentMethod) || previous.paymentMethod&&!samePaymentChoice(previous.paymentMethod,session.receipt.paymentMethod)))throw new Error('连续试跑的商品、数量、总价、币种或付款方式不一致，请修正购物车复用与数量处理');
            task.verifiedProduct=session.receipt.review?.product||task.product;task.verifiedCurrency=session.receipt.review?.currency||task.currency;task.verifiedPaymentMethod=session.receipt.paymentMethod||null;task.paymentOptions=session.paymentOptions||[];
            return {...session.receipt,trace:session.trace,passed:true,codeHash:orderProgramHash(task),at:new Date().toISOString()};
          }catch(error){task.paymentOptions=session.paymentOptions||[];if(error.orderPreparation)task.preparation=error.orderPreparation;if(error.orderContract)task.submissionContract=error.orderContract;task.failure=error.orderFailure||orderFailure(error,{stage:'preflight'});try{error.orderEvidence=await session.snapshot();}catch{}throw error;}
        },{signal,logStage:'试跑 '+(pass+1)});
        logEvent(user,task,'试跑通过',{attempt:attempt+1,pass:pass+1,review:trial.review});
        previous=trial;
        }
        unchanged(user,task);task.trial={...trial,preflightPasses:2};task.validation.preflight='passed';task.progress={stage:'试跑完成',pass:2,at:new Date().toISOString()};task.failure=null;task.preparation={verifiedStages:['checkout','configuration','two_preflights'],pending:[],candidates:[],at:new Date().toISOString()};persist();return;
      }catch(error){logEvent(user,task,'生成或试跑失败',{attempt:attempt+1,error:diagnosticError(error)});feedback={error:redact(user,task,error.message),page:error.orderEvidence||null,previousCode:task.program?.code||null};if(signal.aborted||['ORDER_PREPARATION_UNCERTAIN','ORDER_CONTRACT_UNVERIFIED','ORDER_PRODUCT_MISMATCH','ORDER_QUANTITY_MISMATCH','ORDER_OUT_OF_STOCK','ORDER_REQUEST_BLOCKED','ORDER_LOGIN_REQUIRED','ORDER_LOGIN_UNVERIFIED','ORDER_BROWSER_BUSY','PROXY_AUTH_FAILED','SITE_HTTP_AUTH_REQUIRED','ORDER_COUPON_REJECTED','ORDER_AI_TIMEOUT','ORDER_TRIAL_TIMEOUT','AGENT_BUDGET_EXCEEDED'].includes(error.code)||attempt===2)throw error;}
    }
  }
  async function generateImpl(user,task){
    available(user,task);if(task.submissionStartedAt||task.result)throw new Error('已有执行记录，请创建新的下单配置');
    task.monitorFingerprint=monitorFingerprint(user,task);task.accountFingerprint=orderAccountFingerprint(savedOrderAccount(user,task));
    const key=jobKey(user,task),controller=new AbortController();cancellations.set(key,controller);busy.add(key);
    delete task.error;delete task.errorCode;delete task.startedAt;delete task.attemptId;task.enabled=false;task.approvedHash=null;task.status='generating';task.trial=null;task.submissionContract=null;task.failure=null;task.validation={syntax:'pending',preflight:'pending',payment:task.executionMode==='pay'?'unverified':'not_requested'};task.verifiedProduct=null;task.verifiedCurrency=null;task.verifiedPaymentMethod=null;task.paymentOptions=[];task.progress={stage:'读取商品页面',at:new Date().toISOString()};persist();
    const deadline=createOrderDeadline({signal:controller.signal,timeoutMs:trialTimeoutMs,code:'ORDER_TRIAL_TIMEOUT',stage:'网站探索与两次试跑'});
    try{await buildProgram(user,task,deadline.signal);deadline.signal.throwIfAborted();task.status='ready';return publicOrderTask(task);}
    catch(error){task.failure=error.orderFailure||orderFailure(error,{stage:task.progress?.stage||'generation'});if(error.orderPreparation)task.preparation=error.orderPreparation;task.status=controller.signal.aborted?'draft':error.code==='ORDER_OUT_OF_STOCK'?'waiting_stock':'needs_validation';if(error.code==='ORDER_OUT_OF_STOCK')task.validation.preflight='waiting_stock';if(error.code==='ORDER_SCRIPT_INVALID')task.validation.syntax='failed';task.error=redact(user,task,error.message);task.errorCode=error.code||null;throw Object.assign(new Error(task.error),{code:error.code});}
    finally{deadline.close();busy.delete(key);cancellations.delete(key);persist();}
  }
  function approve(user,task,hash){
    available(user,task);unchanged(user,task);
    if(!task.trial?.passed||task.trial.preflightPasses!==2||hash!==orderProgramHash(task)||task.trial.codeHash!==hash||Date.now()-Date.parse(task.trial.at)>24*60*60_000)throw new Error('请先重新生成并试跑，再确认这份代码');
    if(task.result||task.submissionStartedAt)throw new Error('此任务已有执行记录，请创建新配置，避免重复下单');
    if(task.submissionContract?.status==='unverified')throw new Error('提交契约未验证，不能启用');
    if(user.orderTasks.some(t=>t!==task&&t.monitorId===task.monitorId&&(t.enabled||t.stockAuthorization)))throw new Error('此监控已有启用或等待补货的下单配置，请先暂停它');
    task.approvedHash=hash;task.enabled=true;task.status='armed';persist();return publicOrderTask(task);
  }
  async function executeImpl(user,task,{manual=false}={}){
    available(user,task);
    if(!task.enabled||task.approvedHash!==orderProgramHash(task)||task.result||task.submissionStartedAt)throw new Error('任务未启用、配置已变更或已经执行，不会再次下单');
    try{unchanged(user,task);}catch(error){task.enabled=false;task.approvedHash=null;task.status='ready';task.error=redact(user,task,error.message);persist();throw error;}
    const key=jobKey(user,task),controller=new AbortController();cancellations.set(key,controller);busy.add(key);
    task.enabled=false;task.status='running';task.attemptId=randomUUID();task.startedAt=new Date().toISOString();task.repairs=[];persist();
    const options={signal:controller.signal,onBeforeSubmit:async checked=>{unchanged(user,task);if(controller.signal.aborted)throw new Error('下单任务已停止');task.submissionStartedAt=new Date().toISOString();task.submissionReview=checked;logEvent(user,task,'订单提交前记录',{review:checked,submissionStartedAt:task.submissionStartedAt});persist();},onBeforePayment:async checked=>{unchanged(user,task);if(controller.signal.aborted)throw new Error('付款操作已停止');if(task.paymentStartedAt)throw new Error('此订单已经尝试付款，不会重复扣款');task.paymentStartedAt=new Date().toISOString();task.paymentReview=checked;logEvent(user,task,'付款前记录',{payment:checked,paymentStartedAt:task.paymentStartedAt});persist();}};
    const structuralError=error=>/网页元素不存在|网页元素定位|Missing .*field|missing .*element|strict mode|waiting for locator|locator\..*Timeout|Unknown .*selector/i.test(error.message);
    const run=()=>browserFor(user,task,async session=>{
      try{
        let output;
        try{output=await runProgram(user,task,session,controller.signal);}
        catch(error){
          // Assist only the confirmed original order, before the first payment attempt.
          if(task.program.workflow?.version===2||!task.autoRepair||!structuralError(error)||controller.signal.aborted||session.receipt?.status!=='ordered'||session.paymentStarted||task.paymentStartedAt||task.executionMode!=='pay')throw error;
          const page=await session.snapshot();unchanged(user,task);
          const assistance={at:new Date().toISOString(),phase:'payment',error:redact(user,task,error.message)};
          (task.paymentAssistance||=[]).push(assistance);logEvent(user,task,'原订单付款定位辅助',{error:diagnosticError(error)});persist();
          const response=await askAI(user,task,[{role:'system',content:ORDER_PAYMENT_PROMPT},{role:'user',content:JSON.stringify({phase:'payment',order:inputFor(task),page,receipt:session.receipt,feedback:{error:assistance.error}})}],{signal:controller.signal,stage:'原订单账单定位',timeoutMs:Math.min(aiTimeoutMs,15000),maxRetries:0});
          if(response.error)throw new Error(response.error);
          assistance.code=required(response.paymentCode,'AI 付款定位代码',6000);assistance.summary=required(response.summary,'AI 付款辅助说明',1500);persist();
          unchanged(user,task);
          output=await runOrderPaymentCode(assistance.code,inputFor(task),{...session.methods,pay:checks=>session.methods.pay({...checks,semantic:true,confirmationSelector:'[data-agent-confirmation="payment"]'})},session.receipt,{runScript,timeoutMs:20000,maxCalls:30});assistance.completedAt=new Date().toISOString();
        }
        const requiredStatus={prepare:'prepared',submit:'ordered',pay:'paid'}[task.executionMode];
        const pending=task.executionMode==='pay'&&output.status==='awaiting_payment'&&session.receipt?.status==='awaiting_payment'&&['insufficient_balance','balance_unverified','method_unverified','external_payment','payment_verification','zero_total'].includes(session.receipt.paymentPending?.reason);
        if(!pending&&(output.status!==requiredStatus||session.receipt?.status!==requiredStatus))throw new Error('程序未取得可验证的执行结果');
        return {...session.receipt,trace:session.trace,manual,at:new Date().toISOString()};
      }catch(error){error.orderReceipt=session.receipt;error.orderTrace=session.trace;try{error.orderEvidence=await session.snapshot();}catch{}throw error;}
    },options);
    try{
      let result;
      try{result=await run();}
      catch(error){
        // Only DOM failures before any financial request permit regeneration.
        const structural=structuralError(error);
        if(task.program.workflow?.version===2||!task.autoRepair||!structural||controller.signal.aborted||task.submissionStartedAt||task.paymentStartedAt)throw error;
        logEvent(user,task,'提交前页面修复',{error:diagnosticError(error)});
        unchanged(user,task);task.repairs.push({at:new Date().toISOString(),error:redact(user,task,error.message),previousHash:task.approvedHash});persist();
        await buildProgram(user,task,controller.signal,{error:redact(user,task,error.message),page:error.orderEvidence||null,previousCode:task.program.code});
        unchanged(user,task);task.approvedHash=orderProgramHash(task);task.repairs.at(-1).repairedHash=task.approvedHash;persist();result=await run();
      }
      result.timing={submitMs:task.submissionStartedAt?Date.parse(task.submissionStartedAt)-Date.parse(task.startedAt):null,totalMs:Date.now()-Date.parse(task.startedAt),aiRepairs:task.repairs.length+(task.paymentAssistance?.length||0)};task.result=result;task.status=result.status;if(task.validation&&task.executionMode==='pay')task.validation.payment=result.status==='paid'?'confirmed':'pending';delete task.error;await notify(user,task).catch(()=>{});
    }catch(error){
      logEvent(user,task,'实际执行失败',{error:diagnosticError(error)});
      task.error=redact(user,task,error.message);
      task.failure=error.orderFailure||orderFailure(error,{stage:'execution',submissionStarted:!!task.submissionStartedAt,paymentStarted:!!task.paymentStartedAt});if(error.orderPreparation)task.preparation=error.orderPreparation;
      task.status=error.orderReceipt?.status==='paid'?'paid':task.paymentStartedAt?'uncertain':error.orderReceipt?.status==='ordered'?'payment_failed':task.submissionStartedAt?'uncertain':'failed';
      const failedAttempt={...(error.orderReceipt||{}),status:task.status,trace:error.orderTrace||[],error:task.error,code:error.code,at:new Date().toISOString(),manual};
      if(!task.submissionStartedAt&&!task.paymentStartedAt){
        // A pre-submit failure is an attempt, not an order. Regeneration is safe,
        // but it must revoke approval and repeat verification before re-arming.
        task.lastAttempt=failedAttempt;task.result=null;task.trial=null;task.approvedHash=null;
        task.status=error.code==='ORDER_OUT_OF_STOCK'?'waiting_stock':'needs_validation';
        if(task.validation)task.validation.preflight=error.code==='ORDER_OUT_OF_STOCK'?'waiting_stock':'pending';
        delete task.startedAt;delete task.attemptId;
      }else {task.result=failedAttempt;if(task.validation&&task.executionMode==='pay')task.validation.payment=task.paymentStartedAt?'uncertain':'unverified';}
      await notify(user,task).catch(()=>{});
    }finally{busy.delete(key);cancellations.delete(key);persist();}
    return publicOrderTask(task);
  }
  const loggedOperation=async(kind,user,task,action)=>{
    available(user,task);
    const log=executionLogs.start(user,task.monitorId,{kind,task});activeLogs.set(jobKey(user,task),log);
    log.event('执行预算与配置',{timeouts:{aiTimeoutMs,agentTimeoutMs,trialTimeoutMs},aiMaxRetries:aiRetries,autoRepair:task.autoRepair,workflowVersion:task.program?.workflow?.version||null,approved:Boolean(task.approvedHash),hasProductSelection:Boolean(task.productSelection)});
    if(task.program&&kind!=='generate')log.program(task.program,orderProgramHash(task));
    try{const result=await action();if(task.program)log.program(task.program,orderProgramHash(task));log.finish(['generate','discover'].includes(kind)?'passed':task.status,{result:task.result||task.trial,error:task.error?new Error(task.error):null,submissionStartedAt:task.submissionStartedAt,paymentStartedAt:task.paymentStartedAt});return result;}
    catch(error){log.finish(task.status==='draft'&&kind==='generate'?'stopped':'failed',{result:task.result,error,submissionStartedAt:task.submissionStartedAt,paymentStartedAt:task.paymentStartedAt});throw error;}
    finally{activeLogs.delete(jobKey(user,task));}
  };
  const generate=(user,task)=>loggedOperation('generate',user,task,()=>generateImpl(user,task));
  const discover=(user,task)=>loggedOperation('discover',user,task,()=>generateImpl(user,task));
  const profile=(user,task)=>siteMemory.read(memoryScope(user,task),task.url);
  const execute=(user,task,options)=>loggedOperation('execute',user,task,()=>executeImpl(user,task,options));
  const stockScope=task=>createHash('sha256').update(JSON.stringify([ORDER_SAFETY_VERSION,...['url','product','instruction','quantity','maxTotal','currency','executionMode','affiliateUrl','productSelection','paymentMethod','couponCode','couponFailurePolicy'].map(key=>task[key]),task.revision,task.monitorFingerprint,task.accountFingerprint,task.program?.workflow||null])).digest('hex');
  function waitStock(user,task){
    available(user,task);unchanged(user,task);
    if(task.status!=='waiting_stock'||task.result||task.submissionStartedAt||!task.program?.workflow)throw new Error('仅可为缺货且已有业务 SOP 的未交易任务授权等待');
    if(!task.currency)throw new Error('等待补货自动执行前，请明确填写预算币种并重新生成；不从符号猜测');
    if(user.orderTasks.some(other=>other!==task&&other.monitorId===task.monitorId&&(other.enabled||other.stockAuthorization)))throw new Error('此监控已有启用或等待的下单配置');
    task.stockAuthorization={scope:stockScope(task),at:new Date().toISOString(),expiresAt:new Date(Date.now()+24*60*60_000).toISOString()};task.enabled=false;task.approvedHash=null;persist();return publicOrderTask(task);
  }
  async function trigger(user,monitor){
    for(const task of user.orderTasks.filter(t=>t.monitorId===monitor.id&&(t.enabled||t.stockAuthorization))){
      if(task.stockAuthorization){
        const authorization=task.stockAuthorization;
        try{
          unchanged(user,task);
          if(Date.now()>=Date.parse(authorization.expiresAt)||authorization.scope!==stockScope(task))throw new Error('等待补货授权已过期或范围变化，请重新确认');
          await generate(user,task);
          if(!task.stockAuthorization||authorization.scope!==stockScope(task)||task.submissionContract?.status==='unverified')throw new Error('业务方案或契约发生变化，需要重新审批');
          approve(user,task,task.trial.codeHash);task.stockAuthorization=null;persist();
        }catch(error){
          if(error.code!=='ORDER_OUT_OF_STOCK'){task.stockAuthorization=null;task.enabled=false;task.approvedHash=null;task.error=redact(user,task,error.message);persist();}
          continue;
        }
      }
      await execute(user,task).catch(()=>{});
    }
  }
  function pause(user,task){task.enabled=false;task.stockAuthorization=null;const controller=cancellations.get(jobKey(user,task));if(controller){task.status='stopping';controller.abort(new Error('下单任务已停止'));}else task.status=task.result?.status||(task.trial?.passed?'ready':'draft');persist();return publicOrderTask(task);}
  function isBusy(user,task){return busy.has(jobKey(user,task));}
  function recover(users){executionLogs.recover(users);for(const user of users)for(const task of user.orderTasks||[]){
    const interrupted=['running','generating','stopping'].includes(task.status);
    if(task.enabled&&(task.approvedHash!==orderProgramHash(task)||task.trial?.preflightPasses!==2)){task.enabled=false;task.approvedHash=null;if(!task.result){task.status='draft';task.error='下单核对规则已更新，请重新生成并试跑';}}
    if(!task.monitorId||!task.accountFingerprint){task.enabled=false;task.approvedHash=null;if(!task.result){task.status='draft';task.error='请在对应监控中预先登录账户，再重新生成并试跑';}}
    if(interrupted){task.stockAuthorization=null;task.enabled=false;task.status=task.startedAt?'uncertain':'draft';task.error='服务重启中断了操作，请核对网站订单记录；不会自动重试。';if(task.startedAt)task.result={status:'uncertain',error:task.error,review:task.submissionReview,payment:task.paymentReview,invoiceId:task.paymentReview?.invoiceId};}
  }persist();}
  return {generate,discover,profile,approve,waitStock,execute,trigger,pause,isBusy,recover};
}
