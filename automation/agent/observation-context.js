const normalize=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
const interactive=new Set(['link','button','textbox','spinbutton','combobox','checkbox','radio']);
const MAX_ELEMENTS=96,MAX_CHARS=24000,MAX_OPTIONS=16;
const nonempty=value=>value!==undefined&&value!==null&&value!=='';
function termsFor({order={},workflow={}}={}){
  const values=[order.product,order.productSelection?.text,typeof order.userClarification==='string'?order.userClarification:order.userClarification?.answer,order.userClarification?.question,order.paymentMethod?.name,order.paymentMethod?.label,...(workflow.requirements||[]).flatMap(item=>[item.name,item.value])].filter(value=>typeof value==='string'&&value.trim());
  return [...new Set(values.flatMap(value=>[normalize(value),...normalize(value).split(/[^\p{L}\p{N}_-]+/u)]).filter(value=>value.length>=2&&!/^\d+$/.test(value)))].sort((a,b)=>b.length-a.length).slice(0,32);
}
function excerpt(value,limit,terms){
  const text=String(value??'').replace(/\s+/g,' ').trim();
  if(text.length<=limit)return text;
  const normalized=normalize(text),match=terms.map(term=>normalized.indexOf(term)).find(index=>index>=0);
  const start=match===undefined?0:Math.max(0,match-Math.floor(limit/3));
  return (start?'…':'')+text.slice(start,start+limit)+(start+limit<text.length?'…':'');
}
const scoreText=(value,terms)=>terms.reduce((score,term)=>score+(normalize(value).includes(term)?Math.min(term.length,12):0),0);
function compactElement(el,terms){
  const result={ref:el.ref};
  for(const key of ['tag','role','type','visible','disabled','readOnly','checked','formRef','parentRef'])if(nonempty(el[key]))result[key]=el[key];
  const seen=new Set();
  for(const key of ['accessibleName','label','text','placeholder']){
    const value=excerpt(el[key],240,terms),identity=normalize(value);
    if(identity&&!seen.has(identity)){result[key]=value;seen.add(identity);}
  }
  // Executable values are preserved exactly or explicitly omitted, never shortened.
  for(const key of ['name','id','href','value'])if(nonempty(el[key])&&!(key==='value'&&el.type==='hidden')){
    if(String(el[key]).length<=600)result[key]=el[key];else result[key+'Omitted']=true;
  }
  if(el.options){
    const ranked=el.options.map((option,index)=>({option,index,score:(option.selected?1000:0)+scoreText(option.text,terms)+(terms.includes(normalize(option.text))?200:0)}));
    const selected=ranked.sort((a,b)=>b.score-a.score||a.index-b.index).filter(({option})=>String(option.value).length<=600&&String(option.text).length<=400).slice(0,MAX_OPTIONS).sort((a,b)=>a.index-b.index);
    result.options=selected.map(({option})=>({value:option.value,text:option.text,selected:!!option.selected,disabled:!!option.disabled}));
    if(selected.length<el.options.length)result.optionsOmitted=el.options.length-selected.length;
  }
  return result;
}

// The complete observation stays in the host for binding and transaction checks.
// Assistance receives a bounded view selected by task evidence and DOM relationships.
export function planningObservation(page,input={}){
  const terms=termsFor(input),all=(page.elements||[]).filter(el=>el.type!=='password'),focusRefs=new Set(input.focusRefs||[]);
  const ownScore=el=>scoreText([el.accessibleName,el.label,el.text,el.name].filter(Boolean).join(' '),terms);
  const relatedForms=new Set(all.filter(el=>focusRefs.has(el.ref)||ownScore(el)>0).map(el=>el.formRef).filter(Boolean));
  const relatedContexts=new Set(all.filter(el=>ownScore(el)>0).map(el=>normalize(el.contextText)).filter(Boolean));
  const paymentPhase=!!input.context?.submissionStarted;
  const candidates=all.filter(el=>el.visible!==false||focusRefs.has(el.ref)||el.formRef&&(relatedForms.has(el.formRef)||paymentPhase)).map((el,index)=>{
    const control=interactive.has(el.role),own=ownScore(el),context=scoreText(el.contextText,terms);
    const score=(focusRefs.has(el.ref)?10000:0)+own*8+context+(relatedForms.has(el.formRef)?32:0)+(relatedContexts.has(normalize(el.contextText))?24:0)+(control?(el.role==='link'?12:36):el.role==='heading'?18:4)+(el.visible===false?-30:0);
    return {el,index,score,related:focusRefs.has(el.ref)||own>0||relatedForms.has(el.formRef)};
  }).sort((a,b)=>b.score-a.score||a.index-b.index);
  const contexts={},contextIds=new Map(),elements=[];
  const result={observationId:page.observationId,url:page.url,title:excerpt(page.title,300,terms),text:excerpt(page.text,1400,terms),elements,contexts,forms:[],totalElements:page.totalElements??all.length,coverage:{selected:0,omitted:0,omittedRelevant:0,complete:false}};
  if(String(result.url||'').length>1400){result.url=String(result.url).slice(0,1400);result.urlOmitted=true;}
  if(page.frontend)result.frontend={untrusted:true,verified:false,source:page.frontend.source,scripts:(page.frontend.scripts||[]).slice(0,4).map(script=>({source:String(script.source||'').slice(0,300),operations:(script.operations||[]).slice(0,16),status:'candidate_only'}))};
  let used=JSON.stringify(result).length;
  for(const {el}of candidates){
    if(elements.length>=MAX_ELEMENTS)break;
    const compact=compactElement(el,terms),context=excerpt(el.contextText,460,terms),identity=normalize(context);
    let contextRef=contextIds.get(identity),newContext=false;
    if(identity){if(!contextRef){contextRef='c'+(contextIds.size+1);newContext=true;}compact.contextRef=contextRef;}
    const cost=JSON.stringify(compact).length+(newContext?JSON.stringify({[contextRef]:context}).length:0);
    // Reserve space for the exact relationship between retained fields and forms.
    if(used+cost>MAX_CHARS-2800)continue;
    if(newContext){contextIds.set(identity,contextRef);contexts[contextRef]=context;}
    elements.push(compact);used+=cost;
  }
  const relationships=()=>{
    const refs=new Set(elements.map(el=>el.ref)),selectedForms=new Set(elements.map(el=>el.formRef).filter(Boolean)),usedContexts=new Set(elements.map(el=>el.contextRef).filter(Boolean));
    for(const key of Object.keys(contexts))if(!usedContexts.has(key))delete contexts[key];
    result.forms=(page.forms||[]).filter(form=>selectedForms.has(form.ref)||refs.has(form.ref)).map(form=>({ref:form.ref,method:form.method,action:String(form.action??'').slice(0,600),fields:(form.fields||[]).filter(ref=>refs.has(ref)),omittedFields:(form.fields||[]).filter(ref=>!refs.has(ref)).length}));
    result.coverage={selected:elements.length,omitted:all.length-elements.length,omittedRelevant:candidates.filter(item=>item.related&&!refs.has(item.el.ref)).length,complete:elements.length===all.length&&!elements.some(el=>el.optionsOmitted),selection:'current_task_and_form_relationships',limits:{elements:MAX_ELEMENTS,characters:MAX_CHARS,optionsPerControl:MAX_OPTIONS}};
    // Disclose omitted competing controls; a short view cannot turn them into
    // evidence that the retained button is the only matching action on the page.
    for(const element of elements){
      const source=all.find(el=>el.ref===element.ref);if(!source||!interactive.has(source.role))continue;
      const cues=['accessibleName','label','text','name'].filter(key=>normalize(source[key]));
      const omitted=all.filter(el=>!refs.has(el.ref)&&el.visible!==false&&el.role===source.role&&cues.some(key=>normalize(el[key])===normalize(source[key]))).length;
      if(omitted)element.omittedMatchingControls=omitted;else delete element.omittedMatchingControls;
    }
  };
  relationships();
  // Keep the final envelope within the budget, including form metadata and the
  // ambiguity disclosure. Lowest priority elements leave the view first.
  while(elements.length&&JSON.stringify(result).length>MAX_CHARS){elements.pop();relationships();}
  return result;
}
