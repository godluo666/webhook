async function loadOrderExecutionLog(panel,monitor,epoch){
  const data=await api('/api/monitors/'+encodeURIComponent(monitor)+'/order-execution-logs','GET',undefined,{signal:AbortSignal.timeout(10000)});
  if(!panel.isConnected||orderMonitorId!==monitor||orderEditorEpoch!==epoch)return null;
  const text=JSON.stringify(data.report,null,2);panel.querySelector('[data-order-log-content]').value=text;return text;
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('#order-addon [data-order-log-action]');if(!button||button.disabled)return;
  const root=button.closest('.order-execution-log'),panel=root.querySelector('[data-order-log-panel]'),monitor=orderMonitorId,epoch=orderEditorEpoch,action=button.dataset.orderLogAction;
  if(action==='close'){panel.classList.add('hidden');root.querySelector('[data-order-log-action="view"]').setAttribute('aria-expanded','false');return;}
  if(action==='view'){panel.classList.remove('hidden');button.setAttribute('aria-expanded','true');}
  await withButton(button,async()=>{
    let text;try{text=await loadOrderExecutionLog(panel,monitor,epoch);}catch(error){if(panel.isConnected)panel.querySelector('[data-order-log-content]').value='读取执行日志失败：'+error.message;throw error;}if(text===null)return;
    if(action==='copy'){await copyText(text);toast('执行日志已复制，可以直接发来分析');}
    if(action==='download'){
      const blob=new Blob([text],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
      link.href=url;link.download='order-execution-'+new Date().toISOString().replace(/[:.]/g,'-')+'.txt';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('执行日志已下载');
    }
  });
});