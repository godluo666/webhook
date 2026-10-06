// Chromium must answer proxy challenges without reusing those credentials at
// an origin website. Callers own Fetch request/response interception and enable it.
export function installProxyAuthentication(session, proxy, {onRejected=()=>{}}={}) {
  const state={proxyRejected:false,websiteRequired:false};
  const answered=new Set();
  session.on('Fetch.authRequired',({requestId,authChallenge,resourceType})=>{
    const isProxy=authChallenge.source==='Proxy';
    const provide=isProxy&&proxy&&!state.proxyRejected&&!answered.has(requestId);
    if(isProxy&&!provide){const first=!state.proxyRejected;state.proxyRejected=true;if(first)void Promise.resolve().then(onRejected).catch(()=>{});}
    if(!isProxy&&resourceType==='Document')state.websiteRequired=true;
    if(provide)answered.add(requestId);
    void session.send('Fetch.continueWithAuth',{requestId,authChallengeResponse:provide
      ? {response:'ProvideCredentials',username:decodeURIComponent(proxy.username),password:decodeURIComponent(proxy.password)}
      : {response:'CancelAuth'}}).catch(()=>{});
  });
  return state;
}
export function browserAuthenticationError(error,state={},hasProxy=false) {
  const invalid=/net::ERR_(?:INVALID_AUTH_CREDENTIALS|PROXY_AUTH_UNSUPPORTED)/.test(String(error?.message||''));
  if(state.proxyRejected||(invalid&&hasProxy&&!state.websiteRequired)){state.proxyRejected=true;return Object.assign(new Error('代理认证失败，请核对这条监控所选代理的用户名和密码；已保存的网页登录会话仍保留'),{code:'PROXY_AUTH_FAILED'});}
  if(state.websiteRequired||(invalid&&!hasProxy))return Object.assign(new Error('网站要求额外的 HTTP 认证（401）；代理凭据不会用于网站登录，请检查目标网站或当前出口'),{code:'SITE_HTTP_AUTH_REQUIRED'});
  return error;
}

export async function browserAuthenticatedNavigation(operation,state,hasProxy){
  try{
    const response=await operation();
    if(response?.status()===407)throw browserAuthenticationError(new Error("HTTP 407"),{...state,proxyRejected:true},hasProxy);
    if(response?.status()===401&&response.headers()["www-authenticate"])throw browserAuthenticationError(new Error("HTTP 401"),{...state,websiteRequired:true},hasProxy);
    return response;
  }catch(error){throw browserAuthenticationError(error,state,hasProxy);}
}
