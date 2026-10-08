let orderEditorId=null,orderMonitorId='',orderEditorEpoch=0,orderLoginSession=null,orderLoginQueue=Promise.resolve(),orderProductSelection=null,orderAccountOperation=null,orderPreview=null,orderLoginRequests=new Set();
const orderStatuses={stopping:'正在停止',draft:'待生成代码',generating:'正在生成与试跑',ready:'提交前验证通过，待启用',waiting_stock:'等待补货后验证',needs_validation:'提交前未完成，可重新验证',armed:'已启用',running:'正在执行',prepared:'已停在提交前',ordered:'已提交订单',awaiting_payment:'已下单，等待付款',paid:'已下单并付款',payment_failed:'订单已提交，付款未完成',uncertain:'需核对网站订单',failed:'执行未通过'};
function orderStatusLabel(value,fallback='执行结果'){return (value?.result||value)?.paymentPending?.reason==='zero_total'?'已下单，待确认免费订单':orderStatuses[value?.status]||fallback;}
const accountStatuses={saved:'登录状态已保存',expired:'登录已失效，请重新登录',unavailable:'登录状态暂时无法验证',logged_out:'尚未保存登录状态'};
function orderExecutionLogSection(){return '<section class="order-execution-log"><button type="button" class="mini-button" data-order-log-action="view" aria-expanded="false">查看执行日志</button><div data-order-log-panel class="hidden"><p class="field-help">包含当前监控近期的登录、代码生成、试跑和实际执行记录，已自动隐藏密码、Cookie 与代理凭据。</p><div class="order-log-actions"><button type="button" class="mini-button" data-order-log-action="refresh">刷新日志</button><button type="button" class="mini-button" data-order-log-action="copy">复制日志</button><button type="button" class="mini-button" data-order-log-action="download">下载日志</button><button type="button" class="mini-button" data-order-log-action="close">收起</button></div><label class="field-label" for="order-execution-log-text">执行日志</label><textarea id="order-execution-log-text" data-order-log-content readonly spellcheck="false" rows="12">正在读取日志…</textarea></div></section>';}
function orderLoginValidationFields(account){
  return '<div class="order-login-validation"><button type="button" class="mini-button" data-order-login-settings aria-expanded="false">登录验证设置（可选）</button><div data-order-login-settings-panel class="hidden"><p class="field-help">默认自动识别登录。若账户页需要后台请求，可填写同网站直接显示账户信息的页面。仅在自动识别失败时设置 CSS 标记，选择仅登录后可见的账户名称；保存时会检查它在未登录窗口中不存在。</p><div class="rule-fields">'+orderField('登录后的账户页面','order-check-url',account?.checkUrl||'','url')+orderField('仅登录后可见的账户标记（CSS 选择器）','order-login-selector',account?.loggedInSelector||'','text','maxlength="500" placeholder="例如 #account-name"')+'</div></div></div>';
}
function orderValidationReport(task){
  if(!task)return '';
  const validation=task.validation,syntax=validation?.syntax==='passed'?'已通过':validation?.syntax==='failed'?'未通过':'待检查';
  const preflight=task.trial?.passed&&task.trial.preflightPasses===2?'连续两次通过':task.status==='waiting_stock'?'等待补货':'待验证';
  const detail=(task.failure?'<p>阶段：'+escapeHtml(task.failure.stage)+' · 分类：'+escapeHtml(task.failure.category)+' · 订单请求：'+(task.failure.orderRequestSent==='no'?'未发出':'可能已发出，请核对原订单')+'</p><p>'+escapeHtml(task.failure.suggestion)+'</p>':'')+(task.preparation?'<p>已核验阶段：'+escapeHtml((task.preparation.verifiedStages||[]).join('、')||'尚无完整核验阶段')+'；待验证：'+escapeHtml((task.preparation.pending||[]).join('、'))+'。页面观察与前端候选不算验证通过。</p>':'')+(task.submissionContract?.status==='unverified'?'<p>AJAX 提交契约待验证，未放行最终交易请求。</p>':'')+(task.stockAuthorization?'<p>已明确授权等待补货；到期：'+escapeHtml(task.stockAuthorization.expiresAt)+'。补货后需两次完整试跑；业务范围变化暂停审批。</p>':'');
  return '<div class="order-validation" role="status">'+detail+'<p>代码语法：'+syntax+' · 提交前核验：'+preflight+'</p>'+(task.executionMode==='pay'?'<p>账单定位与付款结果：'+({paid:'本次实际付款已确认',awaiting_payment:orderStatusLabel(task.result),payment_failed:'已下单，付款未完成',uncertain:'执行结果待核对，请查看原订单'}[task.result?.status]||'尚未实际验证；提交前试跑不创建订单或付款')+'</p>':'')+(task.status==='needs_validation'?'<p>本次停在提交前，没有发送订单。恢复登录或页面后，可在原配置重新生成并验证，再启用。</p>':'')+(task.status==='waiting_stock'?'<p>已保留配置。缺货时无法核验真实结算，补货后请重新生成并验证。</p>':'')+'</div>';
}
async function waitForOrderGeneration(path,data,active){
  const deadline=Date.now()+10*60*1000;
  while(['generating','stopping'].includes(data.task.status)){
    if(!active())return data;
    if(Date.now()>=deadline)throw new Error('生成仍在后台进行，请稍后刷新查看结果');
    await new Promise(resolve=>setTimeout(resolve,1000));
    try{data=await api(path,'GET',undefined,{signal:AbortSignal.timeout(10000)});}
    catch(error){if(!['RADAR_CONNECTION_FAILED','RADAR_INVALID_RESPONSE'].includes(error.code)&&error.name!=='TimeoutError')throw error;}
  }
  return data;
}
function orderTasks(){return appState.orderTasks||[];}
function orderAccount(){return (appState.orderAccounts||[]).find(a=>a.monitorId===orderMonitorId);}
function orderField(label,id,value='',type='text',extra=''){return '<label for="'+id+'">'+label+'<input id="'+id+'" type="'+type+'" '+extra+' value="'+escapeHtml(value)+'"></label>';}
function renderMonitorOrder(monitor){return monitor.kind!=='reminder'?'<div id="order-addon" data-monitor-id="'+escapeHtml(monitor.id)+'"></div>':'';}
function mountMonitorOrder(monitor){
  resetOrderUI();if(!$('#order-addon'))return;orderMonitorId=monitor.id;
  const task=orderTasks().find(t=>t.monitorId===monitor.id&&t.enabled)||orderTasks().find(t=>t.monitorId===monitor.id);openOrderEditor(task||null);
}
function clearOrderPreview(){const current=orderPreview;orderPreview=null;current?.controller.abort();if(current?.id)releaseElementPreview(current.id);$('#order-product-window')?.replaceChildren();}
function releaseOrderWindows(){
  orderEditorEpoch++;orderAccountOperation?.controller.abort();for(const controller of orderLoginRequests)controller.abort();orderLoginRequests.clear();clearOrderPreview();
  const previous=orderLoginSession;orderLoginSession=null;orderLoginQueue=Promise.resolve();$('#order-login-window')?.replaceChildren();
  if(previous&&orderMonitorId)void fetch('/api/monitors/'+encodeURIComponent(orderMonitorId)+'/order-account/cancel',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:previous.sessionId})}).catch(()=>{});
}
function resetOrderUI(){
  orderAccountOperation?.controller.abort();for(const controller of orderLoginRequests)controller.abort();orderLoginRequests.clear();
  clearOrderPreview();
  orderAccountOperation=null;orderLoginQueue=Promise.resolve();orderEditorEpoch++;const previous=orderLoginSession,monitorId=orderMonitorId;orderLoginSession=null;orderEditorId=null;orderMonitorId='';orderProductSelection=null;
  if(previous&&monitorId)void fetch('/api/monitors/'+encodeURIComponent(monitorId)+'/order-account/cancel',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:previous.sessionId})}).catch(()=>{});
}
function orderPaymentFields(task){
  const method=task?.paymentMethod||{kind:'balance',name:'账户余额'},proof=task?.verifiedPaymentMethod;
  const actual=(task?.paymentOptions?.length?task.paymentOptions:proof?.options||[]).filter(option=>option.label&&option.label.length<=150).map(option=>({kind:option.kind||'website',name:option.label,label:option.label}));
  const choices=actual.length?actual:[{kind:'balance',name:'账户余额',label:'账户余额'},{kind:'website',name:'支付宝',label:'支付宝'},{kind:'website',name:'PayPal',label:'PayPal'}];
  let selected=choices.findIndex(choice=>proof?.label===choice.label||method.kind==='balance'&&choice.kind==='balance'||method.kind==='website'&&choice.name===method.name);
  choices.push({kind:'website',name:'',label:'其他网站方式'});if(selected<0)selected=choices.length-1;
  return '<div class="field-label">付款方式（自动付款时使用）</div><div class="order-choice-list" role="radiogroup" aria-label="预选付款方式">'+choices.map((choice,index)=>'<button type="button" role="radio" data-order-payment-kind="'+choice.kind+'" data-order-payment-name="'+escapeHtml(choice.name)+'" aria-checked="'+(index===selected)+'">'+escapeHtml(choice.label)+'</button>').join('')+'</div>'+orderField('网站付款方式名称','order-payment-name',method.kind==='website'?method.name:'','text','maxlength="100" placeholder="也可填写网站上的付款名称，如 Alipay"')+'<p class="field-help">选择你希望使用的方式，生成时核对网站实际选项。余额不足保留待付款账单；扫码或验证在网站收银台完成。</p>';
}
function orderCouponFailureFields(task){const policy=task?.couponFailurePolicy||'stop';return '<div class="editor-wide"><div class="field-label">优惠码无效或无法确认生效时</div><div class="order-choice-list" role="radiogroup" aria-label="优惠码失败处理">'+[['stop','停止下单（默认）'],['continue','继续下单']].map(([key,label])=>'<button type="button" role="radio" data-order-coupon-failure="'+key+'" aria-checked="'+(policy===key)+'">'+label+'</button>').join('')+'</div><p class="field-help">预选继续时，按网站当前实际总价核对上限，可能没有优惠。</p></div>';}
function collectOrderPayment(){const selected=$('#order-form [data-order-payment-kind][aria-checked="true"]');return selected?.dataset.orderPaymentKind==='balance'?{kind:'balance',name:'账户余额'}:{kind:'website',name:$('#order-payment-name').value.trim()};}
function openOrderEditor(task=null){
  const root=$('#order-addon');if(!root)return;clearOrderPreview();orderEditorEpoch++;orderEditorId=task?.id||null;orderProductSelection=task?.productSelection||null;
  const monitor=appState.monitors.find(m=>m.id===orderMonitorId),done=Boolean(task?.result||task?.submissionStartedAt),busy=['generating','running','stopping'].includes(task?.status);
  const account=orderAccount();
  const target='<div class="rule-fields">'+orderField('配置名称','order-label',task?.label||monitor?.label||'')+orderField('商品名称或型号（选填）','order-product',task?.product||'','text','maxlength="200" placeholder="留空可由 AI 识别，也可手动点选"')+orderField('商品链接','order-url',task?.url||(/^https?:/.test(monitor?.url||'')?monitor.url:''),'url','required')+orderField('数量','order-quantity',task?.quantity||1,'number','min="1" max="10"')+orderField('预算币种（等待补货授权必填）','order-currency',task?.currency||'','text','maxlength="3" placeholder="USD / CNY，不从 $ 猜测"')+orderField('优惠码（可选）','order-coupon-code',task?.couponCode||'','text','maxlength="128" placeholder="留空不自动应用优惠码" autocomplete="off"')+orderCouponFailureFields(task)+orderField('订单总价上限（含税费）','order-max-total',task?.maxTotal||'','number','min="0.01" step="0.01" required')+'<label class="editor-wide" for="order-instruction">规格与下单要求<textarea id="order-instruction" rows="2" maxlength="2000" placeholder="写明套餐、配置、付费周期和其他要求">'+escapeHtml(task?.instruction||'')+'</textarea></label>'+orderField('AFF 链接（可选）','order-affiliate-url',task?.affiliateUrl||'','url','placeholder="填写希望使用的推广入口"')+'</div><div class="order-product-actions"><button type="button" class="mini-button" data-order-product-pick>手动点选商品</button><span id="order-product-selection" class="field-help">'+escapeHtml(orderProductSelection?'已点选：'+orderProductSelection.text:'从商品页面点选名称或购买入口')+'</span></div><div id="order-product-window"></div>';
  const modes='<div class="field-label">执行范围</div><div class="order-choice-list" role="radiogroup" aria-label="下单执行范围">'+[['prepare','提交前停止'],['submit','提交订单'],['pay','提交并付款']].map(([key,label])=>'<button type="button" role="radio" data-order-mode="'+key+'" aria-checked="'+((task?.executionMode||'prepare')===key)+'">'+label+'</button>').join('')+'</div>'+orderPaymentFields(task)+'<label class="order-check"><input id="order-auto-repair" type="checkbox" '+(task?.autoRepair!==false?'checked':'')+'>页面变化时，由 AI 修复或辅助付款</label><p class="field-help">由当前监控满足条件时触发，每份配置执行一次。商品页面变化时，AI 修复并重新试跑；付款页面变化时，AI 只处理本次订单的账单。</p><p class="field-help">填写优惠码后先应用并核验优惠；失败时按预选停止或继续。继续仍需核对实际总价上限，执行结果会注明优惠失败。</p><p class="field-help">填写 AFF 后会核对推广标识，并检查它是否随订单发送。商家最终返佣以其规则和记录为准。</p>';
  let actions;
  if(busy)actions='<button type="button" class="button button-outline" data-order-editor-action="pause">停止执行</button>';
  else if(done)actions='<button type="button" class="button button-primary" data-order-editor-action="new">新建下单配置</button>';
  else if(task?.enabled)actions='<button type="button" class="button button-outline" data-order-editor-action="pause">暂停</button><button type="button" class="button button-primary" data-order-editor-action="run">'+({prepare:'立即执行到提交前',submit:'立即提交一次订单',pay:'立即下单并付款一次'}[task.executionMode])+'</button>';
  else if(task?.stockAuthorization)actions='<button type="button" class="button button-outline" data-order-editor-action="pause">取消等待补货授权</button>';
  else if(task?.status==='waiting_stock'&&task?.program?.workflow)actions='<button type="button" class="button button-outline" data-order-editor-action="generate">重新验证</button><button type="button" class="button button-primary" data-order-editor-action="wait-stock">等待补货并自动核验（24 小时）</button>';
  else if(task?.trial?.passed)actions='<button type="button" class="button button-outline" data-order-editor-action="generate">重新生成并试跑</button><button type="button" class="button button-primary" data-order-editor-action="enable">启用监控下单</button>';
  else actions='<button type="button" class="button button-outline" data-order-editor-action="save">保存下单配置</button><button type="button" class="button button-primary" data-order-editor-action="generate">生成并试跑</button>';
  const report=task?.result||task?.trial;
  const result=(task?.error?'<p class="order-error" data-order-task-error role="status">'+escapeHtml(task.error)+'</p>':'')+(report?'<div class="order-review"><strong>'+escapeHtml(report.passed?(report.preflightPasses===2?'连续两次试跑通过 · 未下单或付款':'试跑通过 · 未下单或付款'):orderStatusLabel(report))+'</strong>'+(report.review?'<p>'+escapeHtml(report.review.product)+' · '+report.review.quantity+' 件 · '+escapeHtml(report.review.currency)+' '+report.review.total+'</p>':'')+(report.review?.coupon?'<p>优惠码：'+escapeHtml(report.review.coupon.code)+' · 已核验优惠 '+escapeHtml(report.review.currency)+' '+report.review.coupon.discount+'</p>':'')+(report.review?.couponFailure?'<p>优惠码：'+escapeHtml(report.review.couponFailure.code)+' · '+(report.review.couponFailure.status==='rejected'?'网站未接受或未产生减免':'无法确认优惠生效')+'，按预选继续下单；按网站实际总价核对。'+escapeHtml(report.review.couponFailure.reason)+'</p>':'')+(report.paymentMethod?'<p>付款方式：'+escapeHtml(report.paymentMethod.label)+' · '+(report.passed?'网站选项已核实':'已核对网站实际选项')+'</p>':report.paymentVerification==='invoice_only'?'<p>付款方式：账户余额 · 在实际账单核验余额</p>':'')+(report.confirmation?'<p>'+escapeHtml(report.confirmation)+'</p>':'')+(report.paymentPending?'<p>'+escapeHtml(report.paymentPending.message)+'</p>':'')+(task?.result&&orderResultUrl(task.result.url,task.url)?'<p><a href="'+escapeHtml(orderResultUrl(task.result.url,task.url))+'" target="_blank" rel="noopener noreferrer">打开网站订单 / 付款页面 ↗</a></p>':'')+(orderCashierUrl(report.paymentPending)?'<p><a href="'+escapeHtml(orderCashierUrl(report.paymentPending))+'" target="_blank" rel="noopener noreferrer">打开付款收银台 ↗</a></p>':'')+(report.invoiceId?'<p>账单号：'+escapeHtml(report.invoiceId)+'</p>':'')+(report.affiliate?'<p>AFF：'+escapeHtml(report.affiliate.affiliateId)+' · '+(report.affiliate.status==='sent'?'已随订单发送':'提交前核验通过')+'</p>':'')+(report.timing?.submitMs!=null?'<p>核对并发起下单：'+report.timing.submitMs+' 毫秒</p>':'')+(task?.repairs?.length?'<p>页面变化后，AI 已重新生成代码并完成试跑。</p>':'')+(task?.paymentAssistance?.length?'<p>AI 已根据原订单页面辅助处理付款。</p>':'')+(task?.status==='uncertain'?'<p>请核对网站订单和付款记录，此配置不会自动重试。</p>':'')+'<ol class="order-trace">'+(report.trace||[]).map(step=>'<li>'+escapeHtml(step.action)+' · '+escapeHtml(step.detail)+'</li>').join('')+'</ol></div>':'<p class="field-help">AI 根据实际网页生成脚本，自动识别商品与币种，再核对数量、总价、付款方式和 AFF；试跑不提交订单。</p>');
  root.innerHTML='<div id="order-form" data-order-rendered-status="'+escapeHtml(task?.status||'draft')+'" '+(busy?'data-order-remote-busy="true"':'')+'><div class="order-account-area"><h4>下单账户</h4><div class="rule-fields">'+orderField('登录页面地址','order-login-url',account?.loginUrl||task?.url||(/^https?:/.test(monitor?.url||'')?monitor.url:''),'url')+'</div>'+orderLoginValidationFields(account)+'<div class="order-account-actions"><button type="button" class="mini-button" data-order-account-action="start">打开登录页面</button><button type="button" class="mini-button" data-order-account-action="check" '+(!account||account.status==='logged_out'?'disabled':'')+'>验证登录状态</button><button type="button" class="mini-button" data-order-account-action="logout" '+(!account||account.status==='logged_out'?'disabled':'')+'>清除登录状态</button></div><p id="order-account-status" class="field-help" role="status">'+escapeHtml(accountStatuses[account?.status]||accountStatuses.logged_out)+'</p><div id="order-login-window"></div></div><div class="order-config-area"><h4>商品与要求</h4>'+target+modes+'</div><div class="order-result-area"><h4>脚本与结果</h4>'+(task?.program?'<p class="order-code-summary">'+escapeHtml(task.program.summary)+'</p><label for="order-code" class="field-label">AI 生成代码</label><textarea id="order-code" rows="4" readonly spellcheck="false">'+escapeHtml(task.program.code)+'</textarea>':'')+result+orderExecutionLogSection()+'</div><div class="order-action-bar"><span id="order-status" role="status">'+escapeHtml(orderStatusLabel(task,'登录后，填写商品并生成代码'))+'</span><div class="order-footer-actions">'+actions+'<button type="button" id="order-cancel" class="button button-outline hidden">停止执行</button></div></div></div>';
  if(done||busy||task?.enabled)root.querySelectorAll('.order-config-area input,.order-config-area textarea,.order-config-area button').forEach(el=>{el.disabled=true;});
  if(busy)root.querySelectorAll('[data-order-account-action],.order-account-area input').forEach(el=>{el.disabled=true;});
  if(orderLoginSession)renderLoginView(orderLoginSession);else renderOrderAccountStatus();
  const history=orderTasks().filter(t=>t.monitorId===orderMonitorId&&t.id!==orderEditorId&&t.result);
  if(history.length)root.insertAdjacentHTML('beforeend','<div class="order-history"><h4>以前的订单</h4>'+history.map(t=>'<p><button type="button" class="text-button" data-order-history="'+escapeHtml(t.id)+'">'+escapeHtml(t.label)+'</button> · '+escapeHtml(orderStatusLabel(t,t.status))+'</p>').join('')+'</div>');
}
function renderOrders(){const current=orderTasks().find(t=>t.id===orderEditorId),form=$('#order-form');if(!form||form.querySelector('[data-order-busy]')||orderAccountOperation)return;if(!orderLoginSession)renderOrderAccountStatus();if(!current||orderLoginSession)return;if(form.dataset.orderRenderedStatus!==current.status)openOrderEditor(current);else $('#order-status').textContent=orderStatusLabel(current,current.status);}
function collectOrderForm(){const current=orderTasks().find(t=>t.id===orderEditorId);return {label:$('#order-label').value.trim(),product:$('#order-product').value.trim(),url:$('#order-url').value.trim(),quantity:Number($('#order-quantity').value),maxTotal:Number($('#order-max-total').value),currency:$('#order-currency').value.trim().toUpperCase(),couponCode:$('#order-coupon-code').value.trim(),couponFailurePolicy:$('#order-form [data-order-coupon-failure][aria-checked="true"]').dataset.orderCouponFailure,productSelection:orderProductSelection,instruction:$('#order-instruction').value.trim(),monitorId:orderMonitorId,affiliateUrl:$('#order-affiliate-url').value.trim(),autoRepair:$('#order-auto-repair').checked,executionMode:$('#order-form [data-order-mode][aria-checked="true"]').dataset.orderMode,paymentMethod:collectOrderPayment(),expectedRevision:current?.revision};}
function replaceOrderTask(task){appState.orderTasks=orderTasks().filter(t=>t.id!==task.id);appState.orderTasks.unshift(task);}
function renderOrderAccountStatus(force=false){
  const account=orderAccount(),target=$('#order-account-status');if(!target)return;
  const signature=JSON.stringify(account||null);
  if(force||target.dataset.accountState!==signature){target.dataset.accountState=signature;target.textContent=(accountStatuses[account?.status]||accountStatuses.logged_out)+(account?.error?' · '+account.error:'');}
  if(!orderAccountOperation&&!$('#order-form')?.hasAttribute('data-order-remote-busy'))document.querySelectorAll('[data-order-account-action="check"],[data-order-account-action="logout"]').forEach(el=>el.disabled=!account||account.status==='logged_out');
  const task=orderTasks().find(t=>t.id===orderEditorId),error=$('[data-order-task-error]');
  if(error&&task?.error)error.textContent=!task.result&&!task.submissionStartedAt&&account?.status==='saved'&&/登录|会话/.test(task.error)?'账户已保存，请重新生成并试跑。':task.error;
}
function replaceOrderAccount(account){if(!account)return;appState.orderAccounts=(appState.orderAccounts||[]).filter(a=>a.monitorId!==account.monitorId);appState.orderAccounts.push(account);if(account.monitorId===orderMonitorId)renderOrderAccountStatus(true);}
function lockOrderAccountControls(){const operation=orderAccountOperation;if(!operation)return;document.querySelectorAll('#order-addon button,#order-addon .order-account-area input').forEach(el=>{if(!operation.controls.has(el))operation.controls.set(el,el.disabled);el.disabled=true;});}
function renderLoginView(data){
  const target=$('#order-login-window');if(!target)return;orderLoginSession=data;
  const view=data.view,keys=view.fields.map(f=>f.key).join(',');
  if(target.dataset.keys!==keys||!$('#order-login-image')){
    target.dataset.keys=keys;target.innerHTML='<p class="field-help">在下方输入网站登录信息，再点击网页中的登录按钮。验证和二次认证在此完成。</p><div class="rule-fields order-login-fields">'+view.fields.map(f=>f.type==='checkbox'?'<label class="order-check"><input type="checkbox" data-login-field="'+f.key+'" data-login-type="check">'+escapeHtml(f.label)+'</label>':orderField(escapeHtml(f.label),'login-'+f.key,'',f.type,'data-login-field="'+f.key+'" autocomplete="off"')).join('')+'</div><p id="order-login-address" class="field-help"></p><img id="order-login-image" alt="网站登录页面，点击图片中的按钮进行操作" draggable="false"><div class="order-account-actions"><button type="button" class="mini-button" data-login-action="scroll-up">向上滚动</button><button type="button" class="mini-button" data-login-action="scroll-down">向下滚动</button><button type="button" class="mini-button" data-login-action="refresh">刷新网页</button><button type="button" class="mini-button" data-order-account-action="cancel">关闭登录</button><button type="button" class="button button-primary" data-order-account-action="finish">保存登录会话</button></div>';
  }
  $('#order-login-image').src=view.image;$('#order-login-address').textContent=view.url;
  lockOrderAccountControls();
  if(!orderAccountOperation&&view.loginStatus==='authenticated')$('#order-account-status').textContent='网站已登录，点击保存登录会话';
}
function queueLoginAction(input){
  const session=orderLoginSession,epoch=orderEditorEpoch,workspace=workspaceEpoch,monitor=orderMonitorId;if(!session||orderAccountOperation)return Promise.resolve();
  orderLoginQueue=orderLoginQueue.catch(()=>{}).then(async()=>{if(epoch!==orderEditorEpoch||workspace!==workspaceEpoch)return;const controller=new AbortController();orderLoginRequests.add(controller);try{const data=await api('/api/monitors/'+encodeURIComponent(monitor)+'/order-account/action','POST',{sessionId:session.sessionId,...input},{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});if(epoch===orderEditorEpoch&&workspace===workspaceEpoch)renderLoginView(data);}finally{orderLoginRequests.delete(controller);}});
  return orderLoginQueue.catch(error=>{if(epoch===orderEditorEpoch)$('#order-account-status').textContent=error.message;});
}
document.addEventListener('change',event=>{const field=event.target.closest('[data-login-field]');if(!field)return;void queueLoginAction(field.dataset.loginType==='check'?{type:'check',key:field.dataset.loginField,checked:field.checked}:{type:'fill',key:field.dataset.loginField,value:field.value});});
document.addEventListener('click',async event=>{
  const root=event.target.closest('#order-addon');if(!root)return;
  if(orderAccountOperation)return;
  if(event.target.id==='order-login-image'){const box=event.target.getBoundingClientRect();await queueLoginAction({type:'click',x:(event.clientX-box.x)*1280/box.width,y:(event.clientY-box.y)*900/box.height});return;}
  const button=event.target.closest('button');if(!button||button.disabled)return;
  if(button.hasAttribute('data-order-login-settings')){const panel=root.querySelector('[data-order-login-settings-panel]'),expanded=button.getAttribute('aria-expanded')==='true';button.setAttribute('aria-expanded',String(!expanded));panel.classList.toggle('hidden',expanded);return;}
  if(button.hasAttribute('data-order-product-pick')){await withButton(button,openOrderProductPicker);return;}
  if(button.dataset.loginAction){const action=button.dataset.loginAction;await queueLoginAction(action==='refresh'?{type:'refresh'}:{type:'scroll',delta:action==='scroll-up'?-700:700});return;}
  if(button.dataset.orderHistory){openOrderEditor(orderTasks().find(t=>t.id===button.dataset.orderHistory));return;}
  if(button.hasAttribute('data-order-payment-kind')){root.querySelectorAll('[data-order-payment-kind]').forEach(b=>b.setAttribute('aria-checked',String(b===button)));$('#order-payment-name').value=button.dataset.orderPaymentKind==='balance'?'':button.dataset.orderPaymentName;return;}
  if(button.hasAttribute('data-order-coupon-failure')){root.querySelectorAll('[data-order-coupon-failure]').forEach(b=>b.setAttribute('aria-checked',String(b===button)));return;}
  if(button.hasAttribute('data-order-mode')){root.querySelectorAll('[data-order-mode]').forEach(b=>b.setAttribute('aria-checked',String(b===button)));return;}
  if(button.dataset.orderAccountAction){
    const action=button.dataset.orderAccountAction,epoch=orderEditorEpoch,workspace=workspaceEpoch,monitor=orderMonitorId,path='/api/monitors/'+encodeURIComponent(monitor)+'/order-account';
    const operation={epoch,workspace,controls:new Map(),controller:new AbortController()};
    orderAccountOperation=operation;lockOrderAccountControls();
    const active=()=>epoch===orderEditorEpoch&&workspace===workspaceEpoch;
    const closeWindow=()=>{orderLoginSession=null;$('#order-login-window').innerHTML='';delete $('#order-login-window').dataset.keys;};
    try{await withButton(button,async()=>{
      try{
        // A lost action response is not proof that merchant login failed.
        // Wait for queued input, then let the server verify the live session.
        await orderLoginQueue.catch(()=>{});if(!active())return;
        $('#order-account-status').textContent=({start:'正在打开登录页面…',check:'正在验证登录状态…',finish:'正在保存登录会话…',cancel:'正在关闭登录…',logout:'正在清除登录状态…'}[action]);let data;
        if(action==='start'){
          const saved=await api(path,'PUT',{loginUrl:$('#order-login-url').value.trim(),checkUrl:$('#order-check-url').value.trim(),loggedInSelector:$('#order-login-selector').value.trim()},{signal:operation.controller.signal});if(!active())return;replaceOrderAccount(saved.account);
          $('#order-account-status').textContent='正在打开登录页面…';data=await api(path+'/start','POST',undefined,{signal:AbortSignal.any([operation.controller.signal,AbortSignal.timeout(45000)])});
        }else{
          const input={sessionId:orderLoginSession?.sessionId};
          try{data=await api(path+'/'+action,'POST',input,{signal:AbortSignal.any([operation.controller.signal,AbortSignal.timeout(action==='finish'?75000:30000)])});}
          catch(error){
            if(action!=='finish'||!active()||!['RADAR_CONNECTION_FAILED','RADAR_INVALID_RESPONSE'].includes(error.code))throw error;
            $('#order-account-status').textContent='正在确认保存结果…';
            // Repeating this receipt request is safe: the server saves each login session once.
            data=await api(path+'/finish','POST',input,{signal:AbortSignal.any([operation.controller.signal,AbortSignal.timeout(10000)])});
          }
        }
        if(!active()){if(action==='start')void api(path+'/cancel','POST',{sessionId:data.sessionId}).catch(()=>{});return;}
        if(action==='start'){renderLoginView(data);$('#order-account-status').textContent=data.view.loginStatus==='authenticated'?'网站已登录，点击保存登录会话':'请完成网站登录，再保存会话';}
        else{replaceOrderAccount(data.account);if(['finish','cancel','logout'].includes(action))closeWindow();}
      }catch(error){operation.failed=true;if(active()){try{const current=await api(path,'GET',undefined,{signal:AbortSignal.any([operation.controller.signal,AbortSignal.timeout(5000)])});if(active())replaceOrderAccount(current.account);}catch{}if(active()&&$('#order-account-status'))$('#order-account-status').textContent=error.message;}throw error;}
    });}finally{
      if(orderAccountOperation===operation){orderAccountOperation=null;operation.controls.forEach((disabled,el)=>{if(el.isConnected)el.disabled=disabled;});
        if(active()&&!orderLoginSession&&!operation.failed)renderOrderAccountStatus(true);
      }
    }return;
  }
  const action=button.id==='order-cancel'?'pause':button.dataset.orderEditorAction;if(!action)return;
  if(action==='new'){openOrderEditor(null);return;}
  const form=$('#order-form'),task=orderTasks().find(t=>t.id===orderEditorId),epoch=orderEditorEpoch,workspace=workspaceEpoch;
  if(button.id==='order-cancel'){await withButton(button,async()=>{const data=await api('/api/order-tasks/'+encodeURIComponent(task.id)+'/pause','POST');if(workspace===workspaceEpoch)replaceOrderTask(data.task);});return;}
  if(form.querySelector('[data-order-busy]'))return;
  const payload=collectOrderForm(),active=()=>epoch===orderEditorEpoch&&workspace===workspaceEpoch&&form.isConnected;
  if(['enable','run','wait-stock'].includes(action)){
    const normalized={...payload,instruction:payload.instruction||'按配置选择该商品，保留默认配置，在提交前核对订单。'};
    if(JSON.stringify(normalized.paymentMethod)!==JSON.stringify(task?.paymentMethod||{kind:'balance',name:'账户余额'})){toast('付款方式已修改，请重新生成并试跑',true);return;}
    if(JSON.stringify(normalized.productSelection||null)!==JSON.stringify(task?.productSelection||null)){toast('商品点选已修改，请重新生成并试跑',true);return;}
    if(normalized.couponFailurePolicy!==(task?.couponFailurePolicy||'stop')){toast('优惠码失败处理已修改，请先重新生成并试跑',true);return;}
    if(['label','product','url','quantity','maxTotal','currency','couponCode','instruction','monitorId','affiliateUrl','autoRepair','executionMode'].some(k=>String(normalized[k]??'')!==String(task?.[k]??''))){toast('配置已修改，请先重新生成并试跑',true);return;}
  }
  const inputs=[...form.querySelectorAll('input,textarea:not([data-order-log-content]),button:not(#order-cancel):not([data-order-log-action])')],prior=inputs.map(el=>el.disabled);inputs.forEach(el=>{el.disabled=true;el.dataset.orderBusy='true';});$('#order-status').textContent=action==='generate'?'正在读取网页、生成代码并试跑…':'正在处理…';
  try{
    let id=orderEditorId,data;
    if(['save','generate'].includes(action)){data=await api(id?'/api/order-tasks/'+encodeURIComponent(id):'/api/order-tasks',id?'PUT':'POST',payload);if(workspace!==workspaceEpoch)return;replaceOrderTask(data.task);id=data.task.id;if(active())orderEditorId=id;}
    if(['generate','run'].includes(action)&&active()){$('#order-cancel').classList.remove('hidden');form.querySelectorAll('[data-order-editor-action]').forEach(el=>el.classList.add('order-action-hidden'));}
    if(action==='generate'){
      const path='/api/order-tasks/'+encodeURIComponent(id);
      data=await api(path+'/generate','POST',{background:true});
      data=await waitForOrderGeneration(path,data,active);
      if(data.task.error)throw new Error(data.task.error);
    }
    if(action==='enable')data=await api('/api/order-tasks/'+encodeURIComponent(id)+'/enable','POST',{codeHash:task.trial.codeHash});
    if(['pause','run','wait-stock'].includes(action))data=await api('/api/order-tasks/'+encodeURIComponent(id)+'/'+action,'POST');
    if(workspace!==workspaceEpoch)return;replaceOrderTask(data.task);if(active())openOrderEditor(data.task);toast(action==='generate'?'代码生成与试跑完成':action==='enable'?'已启用当前监控的自动下单':'下单配置已更新');
  }catch(error){if(workspace===workspaceEpoch){
    if(action==='generate'&&orderEditorId){try{const refreshed=await api('/api/order-tasks','GET',undefined,{signal:AbortSignal.timeout(5000)});if(workspace===workspaceEpoch){appState.orderTasks=refreshed.tasks;if(active())openOrderEditor(orderTasks().find(t=>t.id===orderEditorId));}}catch{}}
    toast(error.message,true);if(active())$('#order-status').textContent=error.message;
  }}
  finally{if(active()){inputs.forEach((el,i)=>{el.disabled=prior[i];delete el.dataset.orderBusy;});$('#order-cancel').classList.add('hidden');form.querySelectorAll('.order-action-hidden').forEach(el=>el.classList.remove('order-action-hidden'));}}
});
document.addEventListener('keydown',event=>{const group=event.target.closest('#order-addon [role="radiogroup"]');if(!group||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;const buttons=[...group.querySelectorAll('button:not(:disabled)')];if(!buttons.length)return;event.preventDefault();const index=buttons.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(['ArrowRight','ArrowDown'].includes(event.key)?1:-1)+buttons.length)%buttons.length;buttons[next].focus();buttons[next].click();});

function orderCashierUrl(pending){try{if(!['payment_redirect','merchant_page'].includes(pending?.cashierSource))return '';const url=new URL(pending.cashierUrl);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}}
function orderResultUrl(value,source){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&url.origin===new URL(source).origin?url.href:'';}catch{return '';}}
async function openOrderProductPicker(){
  const host=$('#order-product-window'),url=$('#order-url').value.trim(),monitor=orderMonitorId,epoch=orderEditorEpoch,workspace=workspaceEpoch;
  if(!url)throw new Error('请先填写商品链接');
  clearOrderPreview();const current={controller:new AbortController(),id:null};orderPreview=current;
  host.innerHTML='<p class="field-help">正在读取已登录的商品页面…</p>';
  const active=()=>host.isConnected&&orderPreview===current&&epoch===orderEditorEpoch&&workspace===workspaceEpoch;
  try{
    const preview=await api('/api/monitors/'+encodeURIComponent(monitor)+'/order-product/preview','POST',{url},{signal:AbortSignal.any([current.controller.signal,AbortSignal.timeout(45000)])});
    current.id=preview.id;if(!active()){releaseElementPreview(preview.id);return;}
    host.innerHTML='<p class="field-help">点击商品名称或购买入口。这里只选择商品，确认后仍由 AI 生成下单代码。</p><p data-order-product-status role="status">尚未选择商品</p><iframe class="element-frame" title="手动选择下单商品" sandbox="allow-same-origin"></iframe><div class="order-product-actions"><button type="button" class="button button-outline" data-order-product-close>关闭选择</button><button type="button" class="button button-primary" data-order-product-confirm disabled>使用选中商品</button></div>';
    const frame=host.querySelector('iframe'),confirm=host.querySelector('[data-order-product-confirm]');let chosen=null;
    frame.onload=()=>{const doc=frame.contentDocument;if(!doc||!active())return;doc.addEventListener('click',event=>{event.preventDefault();const target=event.target.closest('[data-radar-element]');if(!target)return;doc.querySelectorAll('.radar-selected').forEach(el=>el.classList.remove('radar-selected'));target.classList.add('radar-selected');chosen=Number(target.dataset.radarElement);host.querySelector('[data-order-product-status]').textContent='已选择：'+(target.textContent||target.value||'').trim().slice(0,180);confirm.disabled=false;});};
    frame.srcdoc=preview.html;
    host.querySelector('[data-order-product-close]').onclick=clearOrderPreview;
    confirm.onclick=()=>withButton(confirm,async()=>{const data=await api('/api/monitors/'+encodeURIComponent(monitor)+'/order-product/select','POST',{previewId:preview.id,index:chosen,url});if(!active())return;if($('#order-url').value.trim()!==url)throw new Error('商品链接已变化，请重新点选');orderProductSelection=data.selection;$('#order-product-selection').textContent='已点选：'+data.selection.text;clearOrderPreview();});
  }catch(error){if(active()){host.textContent=error.message;throw error;}}
}
document.addEventListener('input',event=>{if(event.target.id==='order-payment-name'){document.querySelectorAll('[data-order-payment-kind]').forEach(button=>button.setAttribute('aria-checked',String(button.dataset.orderPaymentKind==='website'&&button.dataset.orderPaymentName==='')));}if(event.target.id==='order-url'){if(orderProductSelection){orderProductSelection=null;if($('#order-product-selection'))$('#order-product-selection').textContent='链接已变化，请重新点选商品';}clearOrderPreview();}});

window.addEventListener('pagehide',releaseOrderWindows);

window.addEventListener('hashchange',()=>{if(!['#monitors','#orders'].includes(location.hash))releaseOrderWindows();});
