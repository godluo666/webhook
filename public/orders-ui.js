let orderEditorId = null;
let orderEditorEpoch = 0;
let orderMonitorId = '';
const orderStatuses = {stopping:'正在停止',draft:'待生成代码',generating:'正在生成与试跑',ready:'试跑通过，待启用',armed:'已启用',running:'正在执行',prepared:'已停在提交前',ordered:'已提交订单',paid:'已下单并付款',payment_failed:'订单已提交，付款未完成',uncertain:'需核对网站订单',failed:'执行未通过'};
function orderTasks() { return appState.orderTasks || []; }
function renderOrders() {
  const tasks=orderTasks();
  const current=tasks.find(t=>t.id===orderEditorId);
  if(current&&$('#order-form')?.dataset.orderRemoteBusy&&!$('#order-workspace').classList.contains('hidden')&&!['generating','running','stopping'].includes(current.status))openOrderEditor(current);
  $('#order-list').innerHTML=tasks.length ? tasks.map(task=>'<article class="order-row"><div class="order-row-title"><h3>'+escapeHtml(task.label)+'</h3><span>'+escapeHtml(orderStatuses[task.status]||task.status)+'</span></div><p>'+escapeHtml(task.product)+' · '+task.quantity+' 件 · 总价上限 '+escapeHtml(task.currency)+' '+task.maxTotal+'</p><p class="field-help">'+escapeHtml(task.monitorId ? '触发监控：'+(appState.monitors.find(m=>m.id===task.monitorId)?.label||'原监控已删除') : '手动执行')+' · '+({prepare:'提交前停止',submit:'提交订单',pay:'提交并付款'}[task.executionMode])+'</p><div class="order-row-actions"><button type="button" class="mini-button" data-order-open="'+escapeHtml(task.id)+'">'+(task.result?'查看结果':'编辑任务')+'</button>'+(task.enabled?'<button type="button" class="mini-button" data-order-command="pause" data-id="'+escapeHtml(task.id)+'">暂停</button>':'')+(!task.enabled&&!task.result&&!['generating','running','stopping'].includes(task.status)?'<button type="button" class="mini-button danger" data-order-command="delete" data-id="'+escapeHtml(task.id)+'">删除</button>':'')+'</div></article>').join('') : '<div class="order-empty"><h3>为一个商品创建下单任务</h3><p>填写商品链接和要求，AI 会读取页面并生成代码。</p></div>';
}
function orderField(label, id, value='', type='text', extra='') {return '<label for="'+id+'">'+label+'<input id="'+id+'" type="'+type+'" '+extra+' value="'+escapeHtml(value)+'"></label>';}
function orderSection(title, content) {return '<section class="rule-section"><h3>'+title+'</h3><div class="rule-section-content">'+content+'</div></section>';}
function openOrderEditor(task=null) {
  orderEditorEpoch++;orderEditorId=task?.id||null;orderMonitorId=task?.monitorId||'';
  const done=Boolean(task?.result || task?.submissionStartedAt), remoteBusy=['generating','running','stopping'].includes(task?.status);
  $('#order-heading').textContent=task?.label||'新建下单任务';
  const target='<div class="rule-fields">'+orderField('任务名称','order-label',task?.label||'')+orderField('商品名称或型号','order-product',task?.product||'','text','required maxlength="200"')+orderField('商品链接','order-url',task?.url||'','url','required')+orderField('数量','order-quantity',task?.quantity||1,'number','min="1" max="10"')+orderField('订单总价上限（含税费）','order-max-total',task?.maxTotal||'','number','min="0.01" step="0.01" required')+orderField('币种','order-currency',task?.currency||'USD','text','maxlength="3"')+'<label class="editor-wide" for="order-instruction">下单要求<textarea id="order-instruction" rows="3" maxlength="2000" placeholder="例如：选择 TRI.Pro，按月付费，保留默认系统">'+escapeHtml(task?.instruction||'')+'</textarea></label></div>';
  const trigger='<div class="field-label">触发方式</div><div id="order-monitor-choices" class="order-choice-list" role="radiogroup" aria-label="触发监控"></div>'+(appState.monitors.filter(m=>m.kind!=='reminder').length>6?'<input type="search" id="order-monitor-search" placeholder="搜索要绑定的监控" aria-label="搜索触发监控">':'')+'<div class="field-label order-mode-label">执行范围</div><div class="order-choice-list" role="radiogroup" aria-label="执行范围">'+[['prepare','提交前停止'],['submit','提交订单'],['pay','提交并付款']].map(([key,label])=>'<button type="button" role="radio" data-order-mode="'+key+'" aria-checked="'+((task?.executionMode||'prepare')===key)+'">'+label+'</button>').join('')+'</div><p class="field-help">每个任务只执行一次。提交并付款会在订单创建后核对账单号、总价和币种，再使用网站已有的付款方式。</p>';
  const credentials='<p class="field-help">网站需要登录时填写。账号密码只交给登录执行器，不发送给 AI。'+(task?.hasCredentials?'已保存网站账号，留空保持。':'')+'</p><div class="rule-fields">'+orderField('网站账号（选填）','order-username','','text','autocomplete="off"')+orderField('网站密码（选填）','order-password','','password','autocomplete="new-password"')+'</div>';
  const code=task?.program ? '<p class="order-code-summary">'+escapeHtml(task.program.summary)+'</p><label for="order-code" class="field-label">AI 生成的专用代码</label><textarea id="order-code" rows="9" readonly spellcheck="false">'+escapeHtml(task.program.code)+'</textarea>' : '<p class="field-help">生成时会读取实际页面，再编写该网站的下单流程。没有内置 VMISS 或其他网站的下单代码。</p>';
  const report=task?.result||task?.trial;
  const result=(task?.error?'<p class="order-error" role="status">'+escapeHtml(task.error)+'</p>':'')+(report?'<div class="order-review"><strong>'+escapeHtml(report.passed?'试跑通过 · 未下单或付款':orderStatuses[report.status]||'执行结果')+'</strong>'+(report.review?'<p>'+escapeHtml(report.review.product)+' · '+report.review.quantity+' 件 · '+escapeHtml(report.review.currency)+' '+report.review.total+'</p>':'')+(report.confirmation?'<p>'+escapeHtml(report.confirmation)+'</p>':'')+(report.invoiceId?'<p>账单号：'+escapeHtml(report.invoiceId)+'</p>':'')+(task?.status==='uncertain'?'<p>订单或付款结果未确认，请核对网站订单记录。此任务不会自动重试。</p>':'')+'<ol class="order-trace">'+(report.trace||[]).map(step=>'<li>'+escapeHtml(step.action)+' · '+escapeHtml(step.detail)+'</li>').join('')+'</ol></div>':'<p class="field-help">试跑会核对实际商品、数量和币种，不创建订单或付款。付款页在订单创建后再次核对。</p>');
  let actions;
  if(remoteBusy) actions='<button type="button" class="button button-outline" data-order-editor-action="pause">停止执行</button>';
  else if(done) actions='<button type="button" class="button button-primary" data-order-editor-action="new">新建下单任务</button>';
  else if(task?.enabled) actions='<button type="button" class="button button-outline" data-order-editor-action="pause">暂停</button><button type="button" class="button button-primary" data-order-editor-action="run">'+({prepare:'立即执行到提交前',submit:'立即提交一次订单',pay:'立即下单并付款一次'}[task.executionMode])+'</button>';
  else if(task?.trial?.passed) actions='<button type="button" class="button button-outline" data-order-editor-action="generate">重新生成并试跑</button><button type="button" class="button button-primary" data-order-editor-action="enable">'+(task.monitorId?'启用监控下单':'允许执行')+'</button>';
  else actions='<button type="button" class="button button-outline" data-order-editor-action="save">保存配置</button><button type="button" class="button button-primary" data-order-editor-action="generate">生成并试跑</button>';
  $('#order-editor').innerHTML='<form id="order-form" novalidate>'+orderSection('商品与要求',target)+orderSection('触发与执行',trigger)+orderSection('网站账号',credentials)+orderSection('下单代码',code)+orderSection('试跑与结果',result)+'<footer class="task-editor-footer"><span id="order-status" role="status">'+escapeHtml(orderStatuses[task?.status]||'填写后生成代码')+'</span><div class="order-footer-actions">'+actions+'<button type="button" id="order-cancel" class="button button-outline hidden">停止执行</button></div></footer></form>';
  if(remoteBusy)$('#order-form').dataset.orderRemoteBusy='true';
  if(done||remoteBusy)$('#order-form').querySelectorAll('input,select,textarea,[data-order-mode]').forEach(el=>{el.disabled=true;});
  renderOrderMonitors('',done||remoteBusy);
  $('#order-list-view').classList.add('hidden');$('#order-workspace').classList.remove('hidden');window.scrollTo(0,0);
}
function renderOrderMonitors(query='', disabled=false) {
  const monitors=appState.monitors.filter(m=>m.kind!=='reminder'&&m.label.toLowerCase().includes(query.toLowerCase()));
  $('#order-monitor-choices').innerHTML=[['','手动执行'],...monitors.map(m=>[m.id,m.label])].map(([id,label])=>'<button type="button" role="radio" data-order-monitor="'+escapeHtml(id)+'" aria-checked="'+(id===orderMonitorId)+'" '+(disabled?'disabled':'')+'>'+escapeHtml(label)+'</button>').join('');
}
function resetOrderUI() {orderEditorEpoch++;orderEditorId=null;orderMonitorId='';$('#order-editor').innerHTML='';$('#order-workspace').classList.add('hidden');$('#order-list-view').classList.remove('hidden');$('#order-list').innerHTML='';}
function closeOrderEditor(){orderEditorEpoch++;orderEditorId=null;$('#order-workspace').classList.add('hidden');$('#order-list-view').classList.remove('hidden');renderOrders();window.scrollTo(0,0);}
function collectOrderForm(){const current=orderTasks().find(t=>t.id===orderEditorId);return {label:$('#order-label').value.trim(),product:$('#order-product').value.trim(),url:$('#order-url').value.trim(),quantity:Number($('#order-quantity').value),maxTotal:Number($('#order-max-total').value),currency:$('#order-currency').value.trim(),instruction:$('#order-instruction').value.trim(),monitorId:orderMonitorId,executionMode:$('#order-form [data-order-mode][aria-checked="true"]').dataset.orderMode,username:$('#order-username').value.trim(),password:$('#order-password').value,expectedRevision:current?.revision};}
function replaceOrderTask(task){appState.orderTasks=(appState.orderTasks||[]).filter(t=>t.id!==task.id);appState.orderTasks.unshift(task);renderOrders();}
$('#order-new').addEventListener('click',()=>openOrderEditor());$('#order-back').addEventListener('click',closeOrderEditor);
$('#orders').addEventListener('input',event=>{if(event.target.id==='order-monitor-search')renderOrderMonitors(event.target.value);});
$('#orders').addEventListener('click', async event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.hasAttribute('data-order-open')){openOrderEditor(orderTasks().find(t=>t.id===button.dataset.orderOpen));return;}
  if(button.hasAttribute('data-order-monitor')){orderMonitorId=button.dataset.orderMonitor;$('#order-monitor-choices').querySelectorAll('button').forEach(b=>b.setAttribute('aria-checked',String(b===button)));return;}
  if(button.hasAttribute('data-order-mode')){$('#order-form').querySelectorAll('[data-order-mode]').forEach(b=>b.setAttribute('aria-checked',String(b===button)));return;}
  if(button.dataset.orderCommand==='delete'){await withButton(button,async()=>{await api('/api/order-tasks/'+encodeURIComponent(button.dataset.id),'DELETE');appState.orderTasks=orderTasks().filter(t=>t.id!==button.dataset.id);renderOrders();});return;}
  if(button.dataset.orderCommand==='pause'){await withButton(button,async()=>{const data=await api('/api/order-tasks/'+encodeURIComponent(button.dataset.id)+'/pause','POST');replaceOrderTask(data.task);});return;}
  if(button.id==='order-cancel'){
    const editorEpoch=orderEditorEpoch,id=orderEditorId;
    await withButton(button,async()=>{const data=await api('/api/order-tasks/'+encodeURIComponent(id)+'/pause','POST');replaceOrderTask(data.task);if(editorEpoch===orderEditorEpoch)$('#order-status').textContent='正在停止…';});return;
  }
  const action=button.dataset.orderEditorAction;if(!action)return;if(action==='new'){openOrderEditor();return;}
  const form=$('#order-form'), inputs=[...form.querySelectorAll('input,textarea,button:not(#order-cancel)')];if(inputs.some(el=>el.dataset.orderBusy))return;
  const payload=collectOrderForm(), task=orderTasks().find(t=>t.id===orderEditorId), epoch=workspaceEpoch, editorEpoch=orderEditorEpoch;
  const isEditorActive=()=>epoch===workspaceEpoch&&editorEpoch===orderEditorEpoch&&form.isConnected&&!$('#order-workspace').classList.contains('hidden');
  // Approval always refers to the saved configuration and its reviewed code.
  if(['enable','run'].includes(action)){
    const keys=['label','product','url','quantity','maxTotal','currency','instruction','monitorId','executionMode'];
    const normalized={...payload,instruction:payload.instruction||'按配置选择该商品，保留默认配置，在提交前核对订单。'};
    if(keys.some(k=>String(normalized[k])!==String(task?.[k]))||payload.username||payload.password){toast('配置已修改，请先重新生成并试跑',true);return;}
  }
  const prior=inputs.map(el=>el.disabled);inputs.forEach(el=>{el.disabled=true;el.dataset.orderBusy='true';});$('#order-status').textContent=action==='generate'?'正在读取网站、生成代码并试跑…':'正在处理…';
  try{
    let id=orderEditorId,data;
    if(['save','generate'].includes(action)){
      data=await api(id?'/api/order-tasks/'+encodeURIComponent(id):'/api/order-tasks',id?'PUT':'POST',payload);
      if(epoch!==workspaceEpoch)return;replaceOrderTask(data.task);id=data.task.id;if(isEditorActive())orderEditorId=id;
    }
    if(['generate','run'].includes(action)&&isEditorActive()){
      const cancel=form.querySelector('#order-cancel');cancel.classList.remove('hidden');cancel.parentElement.classList.add('is-working');
      form.querySelectorAll('[data-order-editor-action]').forEach(el=>{if(el!==button)el.classList.add('order-action-hidden');});
    }
    if(action==='generate')data=await api('/api/order-tasks/'+encodeURIComponent(id)+'/generate','POST');
    if(action==='enable')data=await api('/api/order-tasks/'+encodeURIComponent(id)+'/enable','POST',{codeHash:task.trial.codeHash});
    if(['pause','run'].includes(action))data=await api('/api/order-tasks/'+encodeURIComponent(id)+'/'+action,'POST');
    if(epoch!==workspaceEpoch)return;replaceOrderTask(data.task);if(isEditorActive())openOrderEditor(data.task);
    toast(action==='generate'?'代码生成与试跑完成':action==='enable'?'下单任务已启用':'任务已更新');
  }catch(error){
    if(epoch===workspaceEpoch){toast(error.message,true);if(isEditorActive())$('#order-status').textContent=error.message;
      try{const state=await api('/api/state');if(epoch===workspaceEpoch){appState=state;renderOrders();}}catch{}
    }
  }finally{
    if(isEditorActive()){
      const cancel=form.querySelector('#order-cancel');cancel.classList.add('hidden');cancel.parentElement.classList.remove('is-working');
      form.querySelectorAll('.order-action-hidden').forEach(el=>el.classList.remove('order-action-hidden'));inputs.forEach((el,i)=>{el.disabled=prior[i];delete el.dataset.orderBusy;});
    }
  }
});
renderOrders();

$('#orders').addEventListener('keydown',event=>{const group=event.target.closest('[role="radiogroup"]');if(!group||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;const buttons=[...group.querySelectorAll('button:not(:disabled)')];if(!buttons.length)return;const i=buttons.indexOf(event.target),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)+buttons.length)%buttons.length;event.preventDefault();buttons[next].focus();buttons[next].click();});
