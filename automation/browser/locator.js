import {agentError,validateTarget} from '../agent/model.js';
export const LOCATOR_PRIORITY=['aria','text','label','placeholder','name','id','css','xpath'];
export function locatorCandidates(element){
  const candidates=[];
  if(element.role&&element.accessibleName)candidates.push({strategy:'aria',role:element.role,value:element.accessibleName});
  if(element.text)candidates.push({strategy:'text',value:element.text});
  if(element.label)candidates.push({strategy:'label',value:element.label});
  if(element.placeholder)candidates.push({strategy:'placeholder',value:element.placeholder});
  if(element.name)candidates.push({strategy:'name',value:element.name});
  if(element.id)candidates.push({strategy:'id',value:element.id});
  candidates.push({strategy:'css',value:element.runtimeSelector},{strategy:'xpath',value:element.runtimeXPath});
  return candidates.filter(item=>item.value);
}
export async function resolveSemanticTarget(page,observation,target){
  validateTarget(target);
  const element=observation?.elements.find(el=>el.ref===target.ref);
  if(!element)throw agentError('AGENT_ELEMENT_MISSING','语义元素不在当前观察中');
  const marker=observation.observationId+':'+element.ref;
  const runtimeSelector='[data-agent-ref='+JSON.stringify(marker)+']';
  const candidates=locatorCandidates({...element,runtimeSelector,runtimeXPath:'xpath=//*[@data-agent-ref='+JSON.stringify(marker)+']'});
  for(const candidate of candidates){
    const locator=candidate.strategy==='aria'?page.getByRole(candidate.role,{name:candidate.value,exact:true}):candidate.strategy==='text'?page.getByText(candidate.value,{exact:true}):candidate.strategy==='label'?page.getByLabel(candidate.value,{exact:true}):candidate.strategy==='placeholder'?page.getByPlaceholder(candidate.value,{exact:true}):candidate.strategy==='name'?page.locator('[name='+JSON.stringify(candidate.value)+']'):candidate.strategy==='id'?page.locator('[id='+JSON.stringify(candidate.value)+']'):page.locator(candidate.value);
    if(await locator.count()!==1)continue;
    if(await locator.getAttribute('data-agent-ref')!==marker)continue;
    if(element.visible&&!await locator.isVisible())continue;
    return {selector:runtimeSelector,strategy:candidate.strategy,meaning:target.meaning,confidence:target.confidence};
  }
  throw agentError('AGENT_ELEMENT_MISSING','当前页面语义元素已变化或不唯一：'+target.meaning);
}
