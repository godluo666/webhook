import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {installProxyAuthentication,browserAuthenticationError} from '../lib/browser-proxy-auth.js';
class Session extends EventEmitter {calls=[];async send(method,input){this.calls.push({method,input});}}
const proxy=new URL('http://proxy-user:proxy-secret@proxy.example:8080');
const challenge=(requestId,source='Proxy')=>({requestId,resourceType:'Document',authChallenge:{source,origin:'http://proxy.example:8080'}});
test('代理拒绝凭据后停止整个会话，新的请求也不能再次发送凭据',async()=>{
 const session=new Session();let closed=0;const state=installProxyAuthentication(session,proxy,{onRejected:()=>closed++});
 session.emit('Fetch.authRequired',challenge('first'));session.emit('Fetch.authRequired',challenge('first'));session.emit('Fetch.authRequired',challenge('later'));await new Promise(r=>setImmediate(r));
 assert.equal(state.proxyRejected,true);assert.equal(closed,1);assert.deepEqual(session.calls.map(call=>call.input.authChallengeResponse.response),['ProvideCredentials','CancelAuth','CancelAuth']);assert.equal(browserAuthenticationError(new Error('Target closed'),state,true).code,'PROXY_AUTH_FAILED');
});
test('有效代理的独立请求可认证，网站 HTTP 认证不复用代理凭据或误关闭代理',async()=>{
 const session=new Session();let closed=0;const state=installProxyAuthentication(session,proxy,{onRejected:()=>closed++});
 session.emit('Fetch.authRequired',challenge('first'));session.emit('Fetch.authRequired',challenge('other'));session.emit('Fetch.authRequired',challenge('website','Server'));await new Promise(r=>setImmediate(r));
 assert.equal(state.proxyRejected,false);assert.equal(state.websiteRequired,true);assert.equal(closed,0);assert.deepEqual(session.calls.map(call=>call.input.authChallengeResponse.response),['ProvideCredentials','ProvideCredentials','CancelAuth']);assert.deepEqual(session.calls.at(-1).input.authChallengeResponse,{response:'CancelAuth'});
});
test('底层代理认证错误也锁定拒绝状态，关闭期间的新挑战不能再次提供凭据',()=>{
 const session=new Session(),state=installProxyAuthentication(session,proxy);assert.equal(browserAuthenticationError(new Error('net::ERR_INVALID_AUTH_CREDENTIALS'),state,true).code,'PROXY_AUTH_FAILED');assert.equal(state.proxyRejected,true);
 session.emit('Fetch.authRequired',challenge('after-navigation-error'));assert.deepEqual(session.calls[0].input.authChallengeResponse,{response:'CancelAuth'});
});
