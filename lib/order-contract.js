// Full request values stay in browser-session memory; persistence contains schema only.
const normalized=value=>String(value).replace(/\r\n|\r|\n/g,'\r\n');
function canonicalEntries(entries){
  if(!Array.isArray(entries)||entries.length>512)throw new Error('表单字段过多');
  const values=new Map();let size=0;
  for(const item of entries){
    if(!Array.isArray(item)||item.length!==2||item.some(value=>typeof value!=='string'))throw new Error('表单包含无法绑定的字段');
    const [name,value]=item.map(normalized);size+=name.length+value.length;if(size>65536)throw new Error('表单数据过大');
    if(!values.has(name))values.set(name,[]);values.get(name).push(value);
  }
  return JSON.stringify([...values].sort(([a],[b])=>a.localeCompare(b)));
}
export function nativeRequestPermit(form){
  if(!form?.nativeSubmit||!['GET','POST'].includes(form.method)||!Array.isArray(form.entries))throw new Error('缺少原生表单提交结构');
  canonicalEntries(form.entries);
  const url=new URL(form.url);url.hash='';
  if(form.method==='GET')url.search=new URLSearchParams(form.entries.map(([key,value])=>[normalized(key),normalized(value)])).toString();
  return {url:url.href,method:form.method,contentType:form.method==='POST'?form.encoding:null,entries:form.entries};
}
export function matchesNativeRequest(permit,request){
  try{
    if(request.method()!==permit.method||request.url().split('#')[0]!==permit.url)return false;
    const type=String(request.headers()['content-type']||'').split(';')[0].trim().toLowerCase();
    if(permit.method==='POST'&&(type!=='application/x-www-form-urlencoded'||type!==permit.contentType))return false;
    const data=permit.method==='GET'?new URL(request.url()).search:request.postData()||'';
    if(data.length>65536)return false;
    return canonicalEntries([...new URLSearchParams(data)])===canonicalEntries(permit.entries);
  }catch{return false;}
}
export function nativeRequestContract(form){
  const permit=nativeRequestPermit(form),url=new URL(permit.url);
  for(const name of [...url.searchParams.keys()])if(/token|csrf|nonce|session|secret|password|auth/i.test(name))url.searchParams.set(name,'[dynamic]');
  return {version:1,status:'verified',transport:'native',url:url.href,method:permit.method,contentType:permit.contentType,fields:form.entries.map(([name])=>name).sort()};
}
export function sameNativeRequestContract(a,b){
  const normalize=value=>value?.status==='verified'&&value.version===1&&value.transport==='native'?{version:1,status:'verified',transport:'native',url:value.url,method:value.method,contentType:value.contentType,fields:[...(value.fields||[])].sort()}:null;
  const left=normalize(a),right=normalize(b);return Boolean(left&&right)&&JSON.stringify(left)===JSON.stringify(right);
}
