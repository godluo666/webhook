let orderEditorId=null,orderMonitorId='',orderEditorEpoch=0,orderLoginSession=null,orderLoginQueue=Promise.resolve();
const orderStatuses={stopping:'正在停止',draft:'待生成代码',generating:'正在生成与试跑',ready:'试跑通过，待启用',armed:'已启用',running:'正在执行',prepared:'已停在提交前',ordered:'已提交订单',paid:'已下单并付款',payment_failed:'订单已提交，付款未完成',uncertain:'需核对网站订单',failed:'执行未通过'};
const accountStatuses={saved:'登录状态已保存',expired:'登录已失效，请重新登录',unavailable:'登录状态暂时无法验证',logged_out:'尚未保存登录状态'};
function orderTasks(){return appState.orderTasks||[];}
function orderAccount(){return (appState.orderAccounts||[]).find(a=>a.monitorId===orderMonitorId);}
function orderField(label,id,value='',type='text',extra=''){return '<label for="'+id+'">'+label+'<input id="'+id+'" type="'+type+'" '+extra+' value="'+escapeHtml(value)+'"></label>';}
function renderMonitorOrder(monitor){return monitor.kind!=='reminder'?'<div id="order-addon" data-monitor-id="'+escapeHtml(monitor.id)+'"></div>':'';}
function mountMonitorOrder(monitor){
  resetOrderUI();if(!$('#order-addon'))return;orderMonitorId=monitor.id;
  const task=orderTasks().find(t=>t.monitorId===monitor.id&&t.enabled)||orderTasks().find(t=>t.monitorId===monitor.id);openOrderEditor(task||null);
}
function resetOrderUI(){
  orderEditorEpoch++;const previous=orderLoginSession,monitorId=orderMonitorId;orderLoginSession=null;orderEditorId=null;orderMonitorId='';
  if(previous&&monitorId)void api('/api/monitors/'+encodeURIComponent(monitorId)+'/order-account/cancel','POST',{sessionId:previous.sessionId}).catch(()=>{});
}
function openOrderEditor(task=null){
  const root=$('#order-addon');if(!root)return;orderEditorEpoch++;orderEditorId=task?.id||null;
  const monitor=appState.monitors.find(m=>m.id===orderMonitorId),done=Boolean(task?.result||task?.submissionStartedAt),busy=['generating','running','stopping'].includes(task?.status);
  const account=orderAccount();
  const target='<div class="rule-fields">'+orderField('配置名称','order-label',task?.label||monitor?.label||'')+orderField('商品名称或型号','order-product',task?.product||'','text','required maxlength="200"')+orderField('商品链接','order-url',task?.url||(/^https?:/.test(monitor?.url||'')?monitor.url:''),'url','required')+orderField('数量','order-quantity',task?.quantity||1,'number','min="1" max="10"')+orderField('订单总价上限（含税费）','order-max-total',task?.maxTotal||'','number','min="0.01" step="0.01" required')+orderField('币种','order-currency',task?.currency||'USD','text','maxlength="3"')+'<label class="editor-wide" for="order-instruction">规格与下单要求<textarea id="order-instruction" rows="2" maxlength="2000" placeholder="写明套餐、配置、付费周期和其他要求">'+escapeHtml(task?.instruction||'')+'</textarea></label>'+orderField('AFF 链接（可选）','order-affiliate-url',task?.affiliateUrl||'','url','placeholder="填写希望使用的推广入口"')+'</div>';
  const modes='<div class="field-label">执行范围</div><div class="order-choice-list" role="radiogroup" aria-label="下单执行范围">'+[['prepare','提交前停止'],['submit','提交订单'],['pay','提交并付款']].map(([key,label])=>'<button type="button" role="radio" data-order-mode="'+key+'" aria-checked="'+((task?.executionMode||'prepare')===key)+'">'+label+'</button>').join('')+'</div><label class="order-check"><input id="order-auto-repair" type="checkbox" '+(task?.autoRepair!==false?'checked':'')+'>页面变化时，让 AI 自动修复并重新试跑</label><p class="field-help">由当前监控满足条件时触发，每份配置执行一次。自动修复只在订单提交前进行；付款使用网站已有的付款方式。</p><p class="field-help">填写 AFF 后会核对推广标识，并检查它是否随订单发送。商家最终返佣以其规则和记录为准。</p>';
  let actions;
  if(busy)actions='<button type="button" class="button button-outline" data-order-editor-action="pause">停止执行</button>';
  else if(done)actions='<button type="button" class="button button-primary" data-order-editor-action="new">新建下单配置</button>';
  else if(task?.enabled)actions='<button type="button" class="button button-outline" data-order-editor-action="pause">暂停</button><button type="button" class="button button-primary" data-order-editor-action="run">'+({prepare:'立即执行到提交前',submit:'立即提交一次订单',pay:'立即下单并付款一次'}[task.executionMode])+'</button>';
  else if(task?.trial?.passed)actions='<button type="button" class="button button-outline" data-order-editor-action="generate">重新生成并试跑</button><button type="button" class="button button-primary" data-order-editor-action="enable">启用监控下单</button>';
  else actions='<button type="button" class="button button-outline" data-order-editor-action="save">保存下单配置</button><button type="button" class="button button-primary" data-order-editor-action="generate">生成并试跑</button>';
  const report=task?.result||task?.trial;
  const result=(task?.error?'<p class="order-error" role="status">'+escapeHtml(task.error)+'</p>':'')+(report?'<div class="order-review"><strong>'+escapeHtml(report.passed?'试跑通过 · 未下单或付款':orderStatuses[report.status]||'执行结果')+'</strong>'+(report.review?'<p>'+escapeHtml(report.review.product)+' · '+report.review.quantity+' 件 · '+escapeHtml(report.review.currency)+' '+report.review.total+'</p>':'')+(report.confirmation?'<p>'+escapeHtml(report.confirmation)+'</p>':'')+(report.invoiceId?'<p>账单号：'+escapeHtml(report.invoiceId)+'</p>':'')+(report.affiliate?'<p>AFF：'+escapeHtml(report.affiliate.affiliateId)+' · '+(report.affiliate.status==='sent'?'已随订单发送':'提交前核验通过')+'</p>':'')+(report.timing?.submitMs!=null?'<p>核对并发起下单：'+report.timing.submitMs+' 毫秒</p>':'')+(task?.repairs?.length?'<p>页面变化后，AI 已重新生成代码并完成试跑。</p>':'')+(task?.status==='uncertain'?'<p>请核对网站订单和付款记录，此配置不会自动重试。</p>':'')+'<ol class="order-trace">'+(report.trace||[]).map(step=>'<li>'+escapeHtml(step.action)+' · '+escapeHtml(step.detail)+'</li>').join('')+'</ol></div>':'<p class="field-help">AI 根据实际网页生成脚本，再核对真实商品、数量、币种、总价和 AFF；试跑不提交订单。</p>');
  root.innerHTML='<div id="order-form" data-order-rendered-status="'+escapeHtml(task?.status||'draft')+'" '+(busy?'data-order-remote-busy="true"':'')+'><div class="order-account-area"><h4>下单账户</h4><div class="rule-fields">'+orderField('登录页面地址','order-login-url',account?.loginUrl||task?.url||(/^https?:/.test(monitor?.url||'')?monitor.url:''),'url')+'</div><div class="order-account-actions"><button type="button" class="mini-button" data-order-account-action="start">打开登录页面</button><button type="button" class="mini-button" data-order-account-action="check" '+(!account||account.status==='logged_out'?'disabled':'')+'>验证登录状态</button><button type="button" class="mini-button" data-order-account-action="logout" '+(!account||account.status==='logged_out'?'disabled':'')+'>清除登录状态</button></div><p id="order-account-status" class="field-help" role="status">'+escapeHtml(accountStatuses[account?.status]||accountStatuses.logged_out)+'</p><div id="order-login-window"></div></div><div class="order-config-area"><h4>商品与要求</h4>'+target+modes+'</div><div class="order-result-area"><h4>脚本与结果</h4>'+(task?.program?'<p class="order-code-summary">'+escapeHtml(task.program.summary)+'</p><label for="order-code" class="field-label">AI 生成代码</label><textarea id="order-code" rows="4" readonly spellcheck="false">'+escapeHtml(task.program.code)+'</textarea>':'')+result+'</div><div class="order-action-bar"><span id="order-status" role="status">'+escapeHtml(orderStatuses[task?.status]||'登录后，填写商品并生成代码')+'</span><div class="order-footer-actions">'+actions+'<button type="button" id="order-cancel" class="button button-outline hidden">停止执行</button></div></div></div>';
  if(done||busy||task?.enabled)root.querySelectorAll('.order-config-area input,.order-config-area textarea,[data-order-mode]').forEach(el=>{el.disabled=true;});
  if(busy)root.querySelectorAll('[data-order-account-action],#order-login-url').forEach(el=>{el.disabled=true;});
  if(orderLoginSession)renderLoginView(orderLoginSession);
  const history=orderTasks().filter(t=>t.monitorId===orderMonitorId&&t.id!==orderEditorId&&t.result);
  if(history.length)root.insertAdjacentHTML('beforeend','<div class="order-history"><h4>以前的订单</h4>'+history.map(t=>'<p><button type="button" class="text-button" data-order-history="'+escapeHtml(t.id)+'">'+escapeHtml(t.label)+'</button> · '+escapeHtml(orderStatuses[t.status]||t.status)+'</p>').join('')+'</div>');
}
function renderOrders(){const current=orderTasks().find(t=>t.id===orderEditorId),form=$('#order-form');if(!current||!form||form.querySelector('[data-order-busy]'))return;if(form.dataset.orderRenderedStatus!==current.status)openOrderEditor(current);else $('#order-status').textContent=orderStatuses[current.status]||current.status;}
function collectOrderForm(){const current=orderTasks().find(t=>t.id===orderEditorId);return {label:$('#order-label').value.trim(),product:$('#order-product').value.trim(),url:$('#order-url').value.trim(),quantity:Number($('#order-quantity').value),maxTotal:Number($('#order-max-total').value),currency:$('#order-currency').value.trim(),instruction:$('#order-instruction').value.trim(),monitorId:orderMonitorId,affiliateUrl:$('#order-affiliate-url').value.trim(),autoRepair:$('#order-auto-repair').checked,executionMode:$('#order-form [data-order-mode][aria-checked="true"]').dataset.orderMode,expectedRevision:current?.revision};}
function replaceOrderTask(task){appState.orderTasks=orderTasks().filter(t=>t.id!==task.id);appState.orderTasks.unshift(task);}
function replaceOrderAccount(account){if(!account)return;appState.orderAccounts=(appState.orderAccounts||[]).filter(a=>a.monitorId!==account.monitorId);appState.orderAccounts.push(account);if(account.monitorId===orderMonitorId&&$('#order-account-status')){$('#order-account-status').textContent=(accountStatuses[account.status]||account.status)+(account.error?' · '+account.error:'');document.querySelectorAll('[data-order-account-action="check"],[data-order-account-action="logout"]').forEach(el=>el.disabled=account.status==='logged_out');}}
function renderLoginView(data){
  const target=$('#order-login-window');if(!target)return;orderLoginSession=data;
  const view=data.view,keys=view.fields.map(f=>f.key).join(',');
  if(target.dataset.keys!==keys||!$('#order-login-image')){
    target.dataset.keys=keys;target.innerHTML='<p class="field-help">在下方输入网站登录信息，再点击网页中的登录按钮。验证和二次认证在此完成。</p><div class="rule-fields order-login-fields">'+view.fields.map(f=>f.type==='checkbox'?'<label class="order-check"><input type="checkbox" data-login-field="'+f.key+'" data-login-type="check">'+escapeHtml(f.label)+'</label>':orderField(escapeHtml(f.label),'login-'+f.key,'',f.type,'data-login-field="'+f.key+'" autocomplete="off"')).join('')+'</div><p id="order-login-address" class="field-help"></p><img id="order-login-image" alt="网站登录页面，点击图片中的按钮进行操作" draggable="false"><div class="order-account-actions"><button type="button" class="mini-button" data-login-action="scroll-up">向上滚动</button><button type="button" class="mini-button" data-login-action="scroll-down">向下滚动</button><button type="button" class="mini-button" data-login-action="refresh">刷新网页</button><button type="button" class="mini-button" data-order-account-action="cancel">关闭登录</button><button type="button" class="button button-primary" data-order-account-action="finish">保存登录会话</button></div>';
  }
  $('#order-login-image').src=view.image;$('#order-login-address').textContent=view.url;
}
function queueLoginAction(input){
  const session=orderLoginSession,epoch=orderEditorEpoch,workspace=workspaceEpoch,monitor=orderMonitorId;if(!session)return Promise.resolve();
  orderLoginQueue=orderLoginQueue.catch(()=>{}).then(async()=>{if(epoch!==orderEditorEpoch||workspace!==workspaceEpoch)return;const data=await api('/api/monitors/'+encodeURIComponent(monitor)+'/order-account/action','POST',{sessionId:session.sessionId,...input});if(epoch===orderEditorEpoch&&workspace===workspaceEpoch)renderLoginView(data);});
  return orderLoginQueue.catch(error=>{if(epoch===orderEditorEpoch)$('#order-account-status').textContent=error.message;});
}
document.addEventListener('change',event=>{const field=event.target.closest('[data-login-field]');if(!field)return;void queueLoginAction(field.dataset.loginType==='check'?{type:'check',key:field.dataset.loginField,checked:field.checked}:{type:'fill',key:field.dataset.loginField,value:field.value});});
document.addEventListener('click',async event=>{
  const root=event.target.closest('#order-addon');if(!root)return;
  if(event.target.id==='order-login-image'){const box=event.target.getBoundingClientRect();await queueLoginAction({type:'click',x:(event.clientX-box.x)*1280/box.width,y:(event.clientY-box.y)*900/box.height});return;}
  const button=event.target.closest('button');if(!button||button.disabled)return;
  if(button.dataset.loginAction){const action=button.dataset.loginAction;await queueLoginAction(action==='refresh'?{type:'refresh'}:{type:'scroll',delta:action==='scroll-up'?-700:700});return;}
  if(button.dataset.orderHistory){openOrderEditor(orderTasks().find(t=>t.id===button.dataset.orderHistory));return;}
  if(button.hasAttribute('data-order-mode')){root.querySelectorAll('[data-order-mode]').forEach(b=>b.setAttribute('aria-checked',String(b===button)));return;}
  if(button.dataset.orderAccountAction){
    const action=button.dataset.orderAccountAction,epoch=orderEditorEpoch,workspace=workspaceEpoch,monitor=orderMonitorId,path='/api/monitors/'+encodeURIComponent(monitor)+'/order-account';
    await withButton(button,async()=>{
      await orderLoginQueue.catch(()=>{});if(epoch!==orderEditorEpoch||workspace!==workspaceEpoch)return;$('#order-account-status').textContent=({start:'正在打开登录页面…',check:'正在验证登录状态…',finish:'正在保存登录会话…',cancel:'正在关闭登录…',logout:'正在清除登录状态…'}[action]);let data;
      if(action==='start'){await api(path,'PUT',{loginUrl:$('#order-login-url').value.trim()});data=await api(path+'/start','POST');}
      else data=await api(path+'/'+action,'POST',{sessionId:orderLoginSession?.sessionId});
      if(epoch!==orderEditorEpoch||workspace!==workspaceEpoch){if(action==='start')void api(path+'/cancel','POST',{sessionId:data.sessionId}).catch(()=>{});return;}
      if(action==='start'){renderLoginView(data);$('#order-account-status').textContent='请完成网站登录，再保存会话';}
      else{replaceOrderAccount(data.account);if(['finish','cancel','logout'].includes(action)){orderLoginSession=null;$('#order-login-window').innerHTML='';delete $('#order-login-window').dataset.keys;}}
    });return;
  }
  const action=button.id==='order-cancel'?'pause':button.dataset.orderEditorAction;if(!action)return;
  if(action==='new'){openOrderEditor(null);return;}
  const form=$('#order-form'),task=orderTasks().find(t=>t.id===orderEditorId),epoch=orderEditorEpoch,workspace=workspaceEpoch;
  if(button.id==='order-cancel'){await withButton(button,async()=>{const data=await api('/api/order-tasks/'+encodeURIComponent(task.id)+'/pause','POST');if(workspace===workspaceEpoch)replaceOrderTask(data.task);});return;}
  if(form.querySelector('[data-order-busy]'))return;
  const payload=collectOrderForm(),active=()=>epoch===orderEditorEpoch&&workspace===workspaceEpoch&&form.isConnected;
  if(['enable','run'].includes(action)){
    const normalized={...payload,instruction:payload.instruction||'按配置选择该商品，保留默认配置，在提交前核对订单。'};
    if(['label','product','url','quantity','maxTotal','currency','instruction','monitorId','affiliateUrl','autoRepair','executionMode'].some(k=>String(normalized[k])!==String(task?.[k]))){toast('配置已修改，请先重新生成并试跑',true);return;}
  }
  const inputs=[...form.querySelectorAll('input,textarea,button:not(#order-cancel)')],prior=inputs.map(el=>el.disabled);inputs.forEach(el=>{el.disabled=true;el.dataset.orderBusy='true';});$('#order-status').textContent=action==='generate'?'正在读取网页、生成代码并试跑…':'正在处理…';
  try{
    let id=orderEditorId,data;
    if(['save','generate'].includes(action)){data=await api(id?'/api/order-tasks/'+encodeURIComponent(id):'/api/order-tasks',id?'PUT':'POST',payload);if(workspace!==workspaceEpoch)return;replaceOrderTask(data.task);id=data.task.id;if(active())orderEditorId=id;}
    if(['generate','run'].includes(action)&&active()){$('#order-cancel').classList.remove('hidden');form.querySelectorAll('[data-order-editor-action]').forEach(el=>el.classList.add('order-action-hidden'));}
    if(action==='generate')data=await api('/api/order-tasks/'+encodeURIComponent(id)+'/generate','POST');
    if(action==='enable')data=await api('/api/order-tasks/'+encodeURIComponent(id)+'/enable','POST',{codeHash:task.trial.codeHash});
    if(['pause','run'].includes(action))data=await api('/api/order-tasks/'+encodeURIComponent(id)+'/'+action,'POST');
    if(workspace!==workspaceEpoch)return;replaceOrderTask(data.task);if(active())openOrderEditor(data.task);toast(action==='generate'?'代码生成与试跑完成':action==='enable'?'已启用当前监控的自动下单':'下单配置已更新');
  }catch(error){if(workspace===workspaceEpoch){toast(error.message,true);if(active())$('#order-status').textContent=error.message;}}
  finally{if(active()){inputs.forEach((el,i)=>{el.disabled=prior[i];delete el.dataset.orderBusy;});$('#order-cancel').classList.add('hidden');form.querySelectorAll('.order-action-hidden').forEach(el=>el.classList.remove('order-action-hidden'));}}
});
document.addEventListener('keydown',event=>{const group=event.target.closest('#order-addon [role="radiogroup"]');if(!group||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;const buttons=[...group.querySelectorAll('button:not(:disabled)')];if(!buttons.length)return;event.preventDefault();const index=buttons.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(['ArrowRight','ArrowDown'].includes(event.key)?1:-1)+buttons.length)%buttons.length;buttons[next].focus();buttons[next].click();});
