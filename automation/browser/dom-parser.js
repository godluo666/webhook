// Runs in the merchant page; strip executable content and private field values.
export function inspectCommercePage(input){
  const {observationId,assignRefs=true}=typeof input==='string'?{observationId:input}:input;
  const readable=el=>(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
  const labelText=el=>{const clone=el.cloneNode(true);clone.querySelectorAll('input,select,textarea,button').forEach(node=>node.remove());return readable(clone);};
  const visible=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden';
  const role=el=>el.getAttribute('role')||({BUTTON:'button',A:'link',SELECT:'combobox',TEXTAREA:'textbox',H1:'heading',H2:'heading',H3:'heading'}[el.tagName])||(el.tagName==='INPUT'?({checkbox:'checkbox',radio:'radio',submit:'button',button:'button',number:'spinbutton'}[el.type]||'textbox'):null);
  const nodes=[...document.querySelectorAll('a,button,input,select,textarea,label,form,[role],[aria-label],h1,h2,h3,p,span,td,th,dt,dd,strong,output')].slice(0,600);
  const refs=new Map(nodes.map((el,index)=>[el,'e'+index]));
  if(assignRefs)for(const el of document.querySelectorAll('[data-agent-ref]'))el.removeAttribute('data-agent-ref');
  const elements=nodes.map(el=>{
    const ref=refs.get(el);if(assignRefs)el.setAttribute('data-agent-ref',observationId+':'+ref);
    const labelled=(el.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)).filter(Boolean).map(readable).join(' ');
    const label=[...(el.labels||[])].map(labelText).join(' ');
    const privateField=el.tagName==='INPUT'&&(el.type==='password'||el.type==='hidden'||/token|secret|csrf|session|email|address|card|cvv|cvc/i.test(el.name+' '+el.id));
    const text=el.tagName==='INPUT'?(el.type==='submit'||el.type==='button'?el.value:''):readable(el).slice(0,300);
    const accessibleName=(el.getAttribute('aria-label')||labelled||label||text||el.getAttribute('alt')||el.getAttribute('title')||'').slice(0,300);
    return {ref,tag:el.tagName.toLowerCase(),role:role(el),accessibleName,text,label:label.slice(0,300),placeholder:el.getAttribute('placeholder'),name:el.getAttribute('name'),id:el.id||null,
      type:el.getAttribute('type'),visible:visible(el),disabled:!!el.disabled,readOnly:!!el.readOnly,checked:['checkbox','radio'].includes(el.type)?el.checked:undefined,
      value:privateField?undefined:el.tagName==='SELECT'?[...el.selectedOptions].map(o=>o.textContent.trim()).join(' '):['INPUT','TEXTAREA'].includes(el.tagName)?el.value:undefined,
      href:el.tagName==='A'?el.getAttribute('href'):undefined,formRef:refs.get(el.form),parentRef:refs.get(el.parentElement),
      options:el.tagName==='SELECT'?[...el.options].slice(0,80).map(o=>({value:o.value,text:o.textContent.trim(),selected:o.selected,disabled:o.disabled})):undefined};
  });
  const clone=document.documentElement.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,iframe').forEach(el=>el.remove());
  clone.querySelectorAll('*').forEach(el=>{for(const attr of [...el.attributes])if(/^on/i.test(attr.name)||/value|token|nonce|secret|password|csrf/i.test(attr.name))el.removeAttribute(attr.name);if(el.tagName==='TEXTAREA')el.textContent='[hidden]';});
  const forms=[...document.forms].slice(0,40).map(form=>({ref:refs.get(form),method:form.method,action:form.getAttribute('action'),fields:elements.filter(el=>el.formRef===refs.get(form)).map(el=>el.ref)}));
  const treeNodes=[document.body,...document.body.querySelectorAll('*')].filter(el=>!['SCRIPT','STYLE','NOSCRIPT'].includes(el.tagName)).slice(0,1200),treeRefs=new Map(treeNodes.map((el,index)=>[el,'n'+index]));
  return {observationId,url:location.href,title:document.title,text:(document.body.innerText||'').slice(0,24000),html:clone.outerHTML.slice(0,64000),domTree:treeNodes.map(el=>({node:treeRefs.get(el),parent:treeRefs.get(el.parentElement),elementRef:refs.get(el),tag:el.tagName.toLowerCase(),role:role(el)})),elements,forms};
}
