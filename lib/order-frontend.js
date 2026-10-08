// Only passive, bounded hints from scripts already fetched by the merchant page.
// No endpoint probing, source execution, request bodies, or token persistence.
export function createFrontendClues(origin,{maxScripts=4,maxBytes=65536,timeoutMs=3000}={}){
  const scripts=[],seen=new Set();let bytes=0,started=Date.now();
  async function observeResponse(response){
    try{
      const url=new URL(response.url()),headers=response.headers(),length=Number(headers['content-length']);
      if(Date.now()-started>timeoutMs||url.origin!==origin||url.search||seen.size>=maxScripts||seen.has(url.href)||response.request().resourceType()!=='script'||!Number.isInteger(length)||length<1||length>maxBytes-bytes)return;
      seen.add(url.href);bytes+=length;
      const body=await response.body();if(body.length>length||Date.now()-started>timeoutMs)return;
      const source=body.toString('utf8');
      const operations=[...new Set(source.match(/\b(?:fetch|XMLHttpRequest|axios|JSON\.stringify|FormData|checkout|addToCart|configure|outOfStock)\b/g)||[])].slice(0,16);
      scripts.push({source:url.pathname.replace(/[^/]{24,}/g,'[hidden]'),bytes:body.length,operations,status:'candidate_only'});
    }catch{/* Optional hints never authorize an operation. */}
  }
  return {observeResponse,snapshot:()=>({untrusted:true,verified:false,scripts:scripts.slice(),limits:{maxScripts,maxBytes,timeoutMs},source:'passive_same_origin_scripts'})};
}
