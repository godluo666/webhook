import { randomUUID, createHash } from 'node:crypto';
import { createOrderBrowser } from './order-browser.js';
import { savedOrderAccount, orderAccountFingerprint } from './order-account.js';
import { ORDER_WORKFLOW_PROMPT, validateOrderWorkflow, compileOrderWorkflow, runOrderWorkflow, runOrderPaymentCode } from './order-workflow.js';
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
  const product=String(input.product||'').trim();if(product.length>200)throw new Error('商品名称或型号过长');
  const username = String(input.username || '').trim(), password = String(input.password || '');
  if (username.length > 254 || password.length > 512) throw new Error('网站账号信息过长');
  return { id: current?.id || randomUUID(), label: required(input.label || product.slice(0,60) || '自动下单', '任务名称', 60), url: url.href,
    product, productSelection, verifiedProduct:null, verifiedCurrency:null, paymentMethod:normalizePaymentMethod(input.paymentMethod), verifiedPaymentMethod:null, paymentOptions:[], instruction: required(input.instruction || '按配置选择该商品，保留默认配置，在提交前核对订单。', '下单要求', 2000),
    quantity, maxTotal, currency, executionMode: input.executionMode || 'prepare', monitorId: required(input.monitorId,'对应监控',100), affiliateUrl, autoRepair:input.autoRepair!==false, accountFingerprint:null,
    credentials: input.clearCredentials ? {} : { ...(current?.url && new URL(current.url).origin === url.origin ? current.credentials || {} : {}), ...(username ? {username} : {}), ...(password ? {password} : {}) },
    monitorFingerprint: null, enabled: false, status: 'draft', program: null, approvedHash: null, trial: null, result: null,
    createdAt: current?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), revision: (current?.revision || 0) + 1 };
}
export function validateOrderProgram(value,{requireWorkflow=false}={}) {
  if (!value || typeof value !== 'object') throw new Error('AI 没有生成有效的下单程序');
  const workflow=validateOrderWorkflow(value.workflow,{required:requireWorkflow});
  const fields = ['submitSelector', 'productSelector', 'quantitySelector', 'totalSelector', 'currencySelector', 'confirmationSelector'];
  const checkout = Object.fromEntries(fields.map(key => [key, required(value.checkout?.[key], '订单核对字段 ' + key, 500)]));
  const affiliate = value.affiliate ? Object.fromEntries(['queryKey','cookieName','fieldSelector'].filter(key=>value.affiliate[key]).map(key=>[key,required(value.affiliate[key],'AFF 核对字段 '+key,500)])) : null;
  const code=workflow?compileOrderWorkflow(workflow,checkout):required(value.code,'AI 下单代码',24000);
  return { code, checkout, affiliate, ...(workflow?{workflow}:{}), summary: required(value.summary, '下单步骤说明', 1500), generatedAt: new Date().toISOString() };
}
export function orderProgramHash(task) {
  return createHash('sha256').update(JSON.stringify([task.program, task.url, task.product, task.productSelection || null, task.verifiedProduct || null, task.verifiedCurrency || null, normalizePaymentMethod(task.paymentMethod), task.verifiedPaymentMethod || null, task.instruction, task.quantity, task.maxTotal, task.currency, task.executionMode, task.monitorId, task.monitorFingerprint, task.accountFingerprint, task.affiliateUrl, task.autoRepair, task.revision])).digest('hex');
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
const adaptivePrompt = ORDER_WORKFLOW_PROMPT;
export function createOrderService({ persist, withProxy = async (_url, fn) => fn(''), sourceOptions = () => ({}), requestAI, openBrowser = createOrderBrowser, runScript = executeOrderScript, notify = async () => {}, isAccountBusy = () => false }) {
  const busy = new Set(), cancellations = new Map();
  const jobKey = (user, task) => user.id + ':' + task.id;
  const redact = (user, task, value) => { let text=String(value||'');const account=(user.orderAccounts||[]).find(a=>a.monitorId===task.monitorId);for(const secret of [...Object.values(task.credentials||{}),...Object.values(account?.credentials||{}),...(account?.session?.redactions||[]),user.settings?.aiKey,user.settings?.sourceProxy,user.monitors.find(m=>m.id===task.monitorId)?.sourceProxy])if(secret)text=text.split(secret).join('[已隐藏]');return text.slice(0,1000); };
  const available = (user,task) => { if(busy.has(jobKey(user,task))||user.orderTasks.some(t=>t!==task&&t.monitorId===task.monitorId&&busy.has(jobKey(user,t))))throw new Error('此监控的下单任务正在执行');if(isAccountBusy(user,task.monitorId))throw new Error('请先结束当前账户登录操作');if(busy.size>=2)throw new Error('下单服务繁忙，请稍后再试'); };
  const browserFor = (user,task,callback,extra={}) => {
    const account=savedOrderAccount(user,task),monitor=user.monitors.find(m=>m.id===task.monitorId);
    return withProxy(sourceOptions(user,monitor||{}).proxyUrl,async proxyUrl=>{
      if(extra.signal?.aborted)throw new Error('操作已停止');
      let session;
      try{
        session=await openBrowser({...task,credentials:{...account.credentials,...Object.fromEntries((account.session.redactions||[]).map((value,i)=>['login'+i,value]))}},{proxyUrl,storageState:account.session.state,sessionStorageState:account.session.sessionStorage,loginCheck:account.session.check,...extra});
        account.status='saved';account.error='';account.testedAt=new Date().toISOString();
        return await callback(session);
      }catch(error){if(['ORDER_LOGIN_REQUIRED','ORDER_LOGIN_UNVERIFIED'].includes(error.code)){account.status=error.code==='ORDER_LOGIN_REQUIRED'?'expired':'unavailable';account.error=redact(user,task,error.message);persist();}throw error;}
      finally{if(session){if(account.status==='saved'&&session.accountState){try{Object.assign(account.session,await session.accountState());persist();}catch{}}await session.close();}}
    });
  };
  const inputFor=task=>({...Object.fromEntries(['url','product','instruction','quantity','maxTotal','currency','executionMode','affiliateUrl','productSelection','paymentMethod','verifiedPaymentMethod'].map(k=>[k,task[k]])),product:task.product||task.verifiedProduct||'',currency:task.currency||task.verifiedCurrency||''});
  const unchanged=(user,task)=>{
    if(task.monitorFingerprint!==monitorFingerprint(user,task))throw new Error('触发监控条件已变化，请重新生成并试跑');
    if(task.accountFingerprint!==orderAccountFingerprint(savedOrderAccount(user,task)))throw new Error('下单账户已变化，请重新生成并试跑');
  };
  async function buildProgram(user,task,signal,initialFeedback=null){
    const evidence=await browserFor(user,{...task,dryRun:true},session=>session.snapshot(),{signal});
    let feedback=initialFeedback;
    for(let attempt=0;attempt<3;attempt++){
      unchanged(user,task);
      const output=await requestAI(user,[{role:'system',content:adaptivePrompt},{role:'user',content:JSON.stringify({order:inputFor(task),page:evidence,feedback})}],{signal});
      if(signal.aborted)throw new Error('代码生成已停止');
      if(output.error)throw new Error(output.error);
      try{
        task.program=validateOrderProgram(output,{requireWorkflow:true});
        if(task.executionMode==='pay'&&!task.program.workflow.paymentCode)throw new Error('自动付款的 SOP 缺少账单定位代码');
        persist();
        let trial,previous;
        for(let pass=0;pass<2;pass++){
        trial=await browserFor(user,{...task,dryRun:true},async session=>{
          try{
            const result=await runOrderWorkflow(task.program,inputFor(task),session.methods,{runScript,onPhase:phase=>session.trace.push({action:'SOP',detail:phase,at:new Date().toISOString()})});
            if(result.status!=='prepared'||session.receipt?.status!=='prepared')throw new Error('试跑没有到达真实订单核对页面');
            if(previous && (JSON.stringify(previous.review)!==JSON.stringify(session.receipt.review) || Boolean(previous.paymentMethod)!==Boolean(session.receipt.paymentMethod) || previous.paymentMethod&&!samePaymentChoice(previous.paymentMethod,session.receipt.paymentMethod)))throw new Error('连续试跑的商品、数量、总价、币种或付款方式不一致，请修正购物车复用与数量处理');
            task.verifiedProduct=session.receipt.review?.product||task.product;task.verifiedCurrency=session.receipt.review?.currency||task.currency;task.verifiedPaymentMethod=session.receipt.paymentMethod||null;task.paymentOptions=session.paymentOptions||[];
            return {...session.receipt,trace:session.trace,passed:true,codeHash:orderProgramHash(task),at:new Date().toISOString()};
          }catch(error){task.paymentOptions=session.paymentOptions||[];try{error.orderEvidence=await session.snapshot();}catch{}throw error;}
        },{signal});
        previous=trial;
        }
        unchanged(user,task);task.trial={...trial,preflightPasses:2};persist();return;
      }catch(error){feedback={error:redact(user,task,error.message),page:error.orderEvidence||null,previousCode:task.program?.code||null};if(signal.aborted||['ORDER_LOGIN_REQUIRED','ORDER_LOGIN_UNVERIFIED','ORDER_BROWSER_BUSY'].includes(error.code)||attempt===2)throw error;}
    }
  }
  async function generate(user,task){
    available(user,task);if(task.submissionStartedAt||task.result)throw new Error('已有执行记录，请创建新的下单配置');
    task.monitorFingerprint=monitorFingerprint(user,task);task.accountFingerprint=orderAccountFingerprint(savedOrderAccount(user,task));
    const key=jobKey(user,task),controller=new AbortController();cancellations.set(key,controller);busy.add(key);
    delete task.error;task.enabled=false;task.approvedHash=null;task.status='generating';task.trial=null;task.program=null;task.verifiedProduct=null;task.verifiedCurrency=null;task.verifiedPaymentMethod=null;task.paymentOptions=[];persist();
    try{await buildProgram(user,task,controller.signal);task.status='ready';return publicOrderTask(task);}
    catch(error){task.status=controller.signal.aborted?'draft':'failed';task.error=redact(user,task,error.message);throw new Error(task.error);}
    finally{busy.delete(key);cancellations.delete(key);persist();}
  }
  function approve(user,task,hash){
    available(user,task);unchanged(user,task);
    if(!task.trial?.passed||task.trial.preflightPasses!==2||hash!==orderProgramHash(task)||task.trial.codeHash!==hash||Date.now()-Date.parse(task.trial.at)>24*60*60_000)throw new Error('请先重新生成并试跑，再确认这份代码');
    if(task.result||task.submissionStartedAt)throw new Error('此任务已有执行记录，请创建新配置，避免重复下单');
    if(user.orderTasks.some(t=>t!==task&&t.monitorId===task.monitorId&&t.enabled))throw new Error('此监控已有启用的下单配置，请先暂停它');
    task.approvedHash=hash;task.enabled=true;task.status='armed';persist();return publicOrderTask(task);
  }
  async function execute(user,task,{manual=false}={}){
    available(user,task);
    if(!task.enabled||task.approvedHash!==orderProgramHash(task)||task.result||task.submissionStartedAt)throw new Error('任务未启用、配置已变更或已经执行，不会再次下单');
    try{unchanged(user,task);}catch(error){task.enabled=false;task.approvedHash=null;task.status='ready';task.error=redact(user,task,error.message);persist();throw error;}
    const key=jobKey(user,task),controller=new AbortController();cancellations.set(key,controller);busy.add(key);
    task.enabled=false;task.status='running';task.attemptId=randomUUID();task.startedAt=new Date().toISOString();task.repairs=[];persist();
    const options={signal:controller.signal,onBeforeSubmit:async checked=>{unchanged(user,task);if(controller.signal.aborted)throw new Error('下单任务已停止');task.submissionStartedAt=new Date().toISOString();task.submissionReview=checked;persist();},onBeforePayment:async checked=>{unchanged(user,task);if(controller.signal.aborted)throw new Error('付款操作已停止');if(task.paymentStartedAt)throw new Error('此订单已经尝试付款，不会重复扣款');task.paymentStartedAt=new Date().toISOString();task.paymentReview=checked;persist();}};
    const structuralError=error=>/网页元素不存在|网页元素定位|Missing .*field|missing .*element|strict mode|waiting for locator|locator\..*Timeout|Unknown .*selector/i.test(error.message);
    const run=()=>browserFor(user,task,async session=>{
      try{
        let output;
        try{output=await runOrderWorkflow(task.program,inputFor(task),session.methods,{runScript,onPhase:phase=>session.trace.push({action:'SOP',detail:phase,at:new Date().toISOString()})});}
        catch(error){
          // Assist only the confirmed original order, before the first payment attempt.
          if(!task.autoRepair||!structuralError(error)||controller.signal.aborted||session.receipt?.status!=='ordered'||session.paymentStarted||task.paymentStartedAt||task.executionMode!=='pay')throw error;
          const page=await session.snapshot();unchanged(user,task);
          const assistance={at:new Date().toISOString(),phase:'payment',error:redact(user,task,error.message)};
          (task.paymentAssistance||=[]).push(assistance);persist();
          const response=await requestAI(user,[{role:'system',content:adaptivePrompt+'\n这次只协助已经创建并确认的原订单付款。只返回 {summary,paymentCode}。paymentCode 仅定位账单字段，接口只有 snapshot,exists,text,wait；返回 {invoiceLinkSelector} 或 {checks}，宿主按固定 SOP 打开原账单并支付一次；不能创建订单、改变用户付款方式、预算、币种或 AFF。需要扫码或验证时保留待付款，不得宣称已付款。'},{role:'user',content:JSON.stringify({phase:'payment',order:inputFor(task),page,receipt:session.receipt,feedback:{error:assistance.error}})}],{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
          if(response.error)throw new Error(response.error);
          assistance.code=required(response.paymentCode,'AI 付款定位代码',6000);assistance.summary=required(response.summary,'AI 付款辅助说明',1500);persist();
          unchanged(user,task);
          output=await runOrderPaymentCode(assistance.code,inputFor(task),session.methods,session.receipt,{runScript,timeoutMs:20000,maxCalls:30});assistance.completedAt=new Date().toISOString();
        }
        const requiredStatus={prepare:'prepared',submit:'ordered',pay:'paid'}[task.executionMode];
        const pending=task.executionMode==='pay'&&output.status==='awaiting_payment'&&session.receipt?.status==='awaiting_payment'&&['insufficient_balance','balance_unverified','method_unverified','external_payment','payment_verification'].includes(session.receipt.paymentPending?.reason);
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
        if(!task.autoRepair||!structural||controller.signal.aborted||task.submissionStartedAt||task.paymentStartedAt)throw error;
        unchanged(user,task);task.repairs.push({at:new Date().toISOString(),error:redact(user,task,error.message),previousHash:task.approvedHash});persist();
        await buildProgram(user,task,controller.signal,{error:redact(user,task,error.message),page:error.orderEvidence||null,previousCode:task.program.code});
        unchanged(user,task);task.approvedHash=orderProgramHash(task);task.repairs.at(-1).repairedHash=task.approvedHash;persist();result=await run();
      }
      result.timing={submitMs:task.submissionStartedAt?Date.parse(task.submissionStartedAt)-Date.parse(task.startedAt):null,totalMs:Date.now()-Date.parse(task.startedAt),aiRepairs:task.repairs.length+(task.paymentAssistance?.length||0)};task.result=result;task.status=result.status;delete task.error;await notify(user,task).catch(()=>{});
    }catch(error){
      task.error=redact(user,task,error.message);
      task.status=error.orderReceipt?.status==='paid'?'paid':task.paymentStartedAt?'uncertain':error.orderReceipt?.status==='ordered'?'payment_failed':task.submissionStartedAt?'uncertain':'failed';
      task.result={...(error.orderReceipt||{}),status:task.status,trace:error.orderTrace||[],error:task.error,at:new Date().toISOString(),manual};await notify(user,task).catch(()=>{});
    }finally{busy.delete(key);cancellations.delete(key);persist();}
    return publicOrderTask(task);
  }
  async function trigger(user,monitor){for(const task of user.orderTasks.filter(t=>t.enabled&&t.monitorId===monitor.id))await execute(user,task).catch(()=>{});}
  function pause(user,task){task.enabled=false;const controller=cancellations.get(jobKey(user,task));if(controller){task.status='stopping';controller.abort();}else task.status=task.result?.status||(task.trial?.passed?'ready':'draft');persist();return publicOrderTask(task);}
  function isBusy(user,task){return busy.has(jobKey(user,task));}
  function recover(users){for(const user of users)for(const task of user.orderTasks||[]){
    const interrupted=['running','generating','stopping'].includes(task.status);
    if(task.enabled&&(task.approvedHash!==orderProgramHash(task)||task.trial?.preflightPasses!==2)){task.enabled=false;task.approvedHash=null;if(!task.result){task.status='draft';task.error='下单核对规则已更新，请重新生成并试跑';}}
    if(!task.monitorId||!task.accountFingerprint){task.enabled=false;task.approvedHash=null;if(!task.result){task.status='draft';task.error='请在对应监控中预先登录账户，再重新生成并试跑';}}
    if(interrupted){task.enabled=false;task.status=task.startedAt?'uncertain':'draft';task.error='服务重启中断了操作，请核对网站订单记录；不会自动重试。';if(task.startedAt)task.result={status:'uncertain',error:task.error,review:task.submissionReview,payment:task.paymentReview,invoiceId:task.paymentReview?.invoiceId};}
  }persist();}
  return {generate,approve,execute,trigger,pause,isBusy,recover};
}
