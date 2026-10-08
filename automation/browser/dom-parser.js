// Runs in the merchant page; strip executable content and private field values.
export function inspectCommercePage(input){
  const {observationId,assignRefs=true}=typeof input==='string'?{observationId:input}:input;
  const readable=el=>(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
  const labelText=el=>{const clone=el.cloneNode(true);clone.querySelectorAll('input,select,textarea,button').forEach(node=>node.remove());return readable(clone);};
  const visible=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden';
  const role=el=>el.getAttribute('role')||({BUTTON:'button',A:'link',SELECT:'combobox',TEXTAREA:'textbox',H1:'heading',H2:'heading',H3:'heading'}[el.tagName])||(el.tagName==='INPUT'?({checkbox:'checkbox',radio:'radio',submit:'button',button:'button',number:'spinbutton'}[el.type]||'textbox'):null);
  const contextText=el=>{
    const own=readable(el);let last='';
    for(let parent=el.parentElement,depth=0;parent&&depth<5&&!['BODY','HTML'].includes(parent.tagName);parent=parent.parentElement,depth++){
      const value=readable(parent);if(value.length>1200)break;if(value&&value!==own)last=value;
      if(value&&value!==own&&(parent.matches('article,li,tr,[role="listitem"]')||parent.querySelector('h1,h2,h3,h4,[role="heading"]')&&parent.querySelectorAll('a,button,input[type="submit"]').length<=3))return value.slice(0,1200);
    }return last.slice(0,1200);
  };
  // Every semantic node can provide a purchase action or a verification field.
  // Bound large text/HTML fields, rather than dropping later controls.
  const nodes=[...document.querySelectorAll('a,button,input,select,textarea,label,form,[role],[aria-label],h1,h2,h3,h4,h5,h6,p,span,td,th,dt,dd,strong,output,div,li,b,em,small')].filter(el=>
    !el.matches('div,li,b,em,small')||el.hasAttribute('role')||el.hasAttribute('aria-label')||
    [...el.childNodes].some(node=>node.nodeType===3&&node.textContent.trim()));
  const refs=new Map(nodes.map((el,index)=>[el,'e'+index]));
  if(assignRefs)for(const el of document.querySelectorAll('[data-agent-ref]'))el.removeAttribute('data-agent-ref');
  const elements=nodes.map(el=>{
    const ref=refs.get(el);if(assignRefs)el.setAttribute('data-agent-ref',observationId+':'+ref);
    const labelled=(el.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)).filter(Boolean).map(readable).join(' ');
    const label=[...(el.labels||[])].map(labelText).join(' ');
    const privateField=el.tagName==='INPUT'&&(el.type==='password'||el.type==='hidden'||/token|secret|csrf|session|email|address|card|cvv|cvc/i.test(el.name+' '+el.id));
    const text=el.tagName==='INPUT'?(el.type==='submit'||el.type==='button'?el.value:''):readable(el).slice(0,300);
    const accessibleName=(el.getAttribute('aria-label')||labelled||label||text||el.getAttribute('alt')||el.getAttribute('title')||'').slice(0,300);
    return {ref,tag:el.tagName.toLowerCase(),role:role(el),accessibleName,text,contextText:contextText(el),label:label.slice(0,300),placeholder:el.getAttribute('placeholder'),name:el.getAttribute('name'),id:el.id||null,
      type:el.getAttribute('type'),visible:visible(el),disabled:!!el.disabled,readOnly:!!el.readOnly,checked:['checkbox','radio'].includes(el.type)?el.checked:undefined,
      value:privateField?undefined:el.tagName==='SELECT'?[...el.selectedOptions].map(o=>o.textContent.trim()).join(' '):['INPUT','TEXTAREA'].includes(el.tagName)?el.value:undefined,
      href:el.tagName==='A'?el.getAttribute('href'):undefined,formRef:refs.get(el.form),parentRef:refs.get(el.parentElement),
      options:el.tagName==='SELECT'?[...el.options].map(o=>({value:o.value,text:o.textContent.trim(),selected:o.selected,disabled:o.disabled})):undefined};
  });
  const clone=document.documentElement.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,iframe').forEach(el=>el.remove());
  clone.querySelectorAll('*').forEach(el=>{for(const attr of [...el.attributes])if(/^on/i.test(attr.name)||/value|token|nonce|secret|password|csrf/i.test(attr.name))el.removeAttribute(attr.name);if(el.tagName==='TEXTAREA')el.textContent='[hidden]';});
  const forms=[...document.forms].map(form=>({ref:refs.get(form),method:form.method,action:form.getAttribute('action'),fields:elements.filter(el=>el.formRef===refs.get(form)).map(el=>el.ref)}));
  const allTreeNodes=[document.documentElement,...document.documentElement.querySelectorAll('*')].filter(el=>!['SCRIPT','STYLE','NOSCRIPT'].includes(el.tagName));
  const includedTreeNodes=new Set(allTreeNodes.slice(0,1200));
  // Preserve the hierarchy of every observed control, even after the outline limit.
  for(const node of nodes)for(let parent=node;parent&&!includedTreeNodes.has(parent);parent=parent.parentElement)includedTreeNodes.add(parent);
  const treeNodes=allTreeNodes.filter(el=>includedTreeNodes.has(el)),treeRefs=new Map(treeNodes.map((el,index)=>[el,'n'+index]));
  const text=document.body.innerText||'',html=clone.outerHTML;
  return {observationId,url:location.href,title:document.title,text:text.slice(0,24000),html:html.slice(0,64000),
    totalElements:nodes.length,totalDomNodes:allTreeNodes.length,
    truncated:{elements:false,forms:false,text:text.length>24000,html:html.length>64000,domTree:treeNodes.length<allTreeNodes.length},
    domTree:treeNodes.map(el=>({node:treeRefs.get(el),parent:treeRefs.get(el.parentElement),elementRef:refs.get(el),tag:el.tagName.toLowerCase(),role:role(el)})),elements,forms};
}
