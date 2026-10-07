import {inspectCommercePage} from '../automation/browser/dom-parser.js';
import {resolveSemanticTarget} from '../automation/browser/locator.js';
import {confirmationEvidence} from '../automation/adapters/generic-commerce.js';
import {diagnosticUrl} from './order-execution-log.js';
import { browserOperation, isBrowserClosedError, settledBrowserRead } from './browser-operation.js';
import { orderRequestKind, describeOrderRequest, isOrderAccountAction } from './order-request.js';
import { diagnosticPage } from './order-execution-log.js';
import { installProxyAuthentication, browserAuthenticationError, browserAuthenticatedNavigation } from './browser-proxy-auth.js';
import { createBrowserSlots } from './browser-slots.js';
import { matchesProductSelection } from './order-evidence.js';
const browserSlots = createBrowserSlots();
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { isChallengePage } from './source-fetch.js';
import { normalizePaymentMethod, paymentBrand, paymentMatchesIntent, samePaymentChoice } from './order-payment.js';

const selector = input => { if (typeof input !== 'string' || !input.trim() || input.length > 500) throw new Error('网页元素定位无效'); return input; };
const paymentWords = /pay(?:\s+now|\s+invoice|ment)?|支付|付款|扣款|complete\s+(?:order|purchase)|place\s+order|submit\s+order|确认订单|提交订单|确认购买|立即购买/i;
export function parseOrderTotal(text) {
  const values = String(text).replace(/,(?=\d{3}(?:\D|$))/g, '').match(/-?\d+(?:\.\d{1,2})?/g);
  if (!values || values.length !== 1) throw new Error('无法唯一确认订单总价，请重新生成');
  const value = Number(values[0]);
  if (!Number.isFinite(value) || value < 0) throw new Error('订单总价无效');
  return value;
}
// Native submit buttons can override the enclosing form's target and method.
// Every cart, order and payment phase uses this same effective form inspection.
function inspectOrderForm(el,{kind,selector}={}){
  const form=el.form;if(!form)return null;
  const target={url:el.hasAttribute('formaction')?el.formAction:form.action,method:(el.hasAttribute('formmethod')?el.formMethod:form.method).toUpperCase(),encoding:el.hasAttribute('formenctype')?el.formEnctype:form.enctype};
  const fields=[...form.elements],payment=fields.some(field=>/(?:cardnumber|card_number|ccnumber|cvv|cvc|usecredit|applycredit|autopay|savedpayment)/i.test(field.name||field.id)&&(field.type==='checkbox'||field.type==='radio'?field.checked:!!field.value));
  if(kind==='cart')return {...target,text:el.innerText||el.value||'',fields:fields.map(field=>({name:field.name||field.id,type:field.type})),content:form.innerText};
  if(kind==='coupon'){
    const input=document.querySelector(selector),bound=input?.form===form&&input.name&&!input.disabled&&!input.readOnly;
    return {...target,text:el.innerText||el.value||'',payment:payment||fields.some(field=>field.type==='password'),coupon:bound?{name:input.name,value:String(input.value),type:input.type}:null};
  }
  if(kind==='submit'){
    const quantity=document.querySelector(selector),bound=quantity?.form===form&&quantity.name&&!quantity.disabled;
    return {...target,payment,quantity:bound?{name:quantity.name,value:String(quantity.value)}:null};
  }
  const label=field=>field.tagName==='SELECT'?[...field.selectedOptions].map(option=>option.textContent.trim()).join(' '):(field.labels?.[0]?.innerText||field.getAttribute('aria-label')||'').trim();
  return {...target,invoiceMatches:document.querySelector(selector)?.form===form,
    controls:fields.filter(field=>field.tagName==='SELECT'||field.type==='radio'&&field.checked).map(field=>({name:field.name,value:field.value,label:label(field)})),
    hiddenMethods:fields.filter(field=>field.type==='hidden'&&/paymentmethod|payment_method|gateway|savedpayment|autopay/i.test(field.name||field.id)).map(field=>({name:field.name,value:field.value})),
    cardData:fields.some(field=>field.type==='password'||/(?:cardnumber|card_number|ccnumber|cvv|cvc)/i.test(field.name||field.id)&&!!field.value)};
}
async function closeOrderBrowser(browser){
  let timer;try{await Promise.race([browser.close().catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,250);})]);}finally{clearTimeout(timer);}
}
// Runs in the merchant page; never treats an unrelated change-password form as logout.
function inspectOrderLogin(proof) {
  const visible=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden';
  const loginWords=/\blog[\s-]?in\b|\bsign[\s-]?in\b|登录|登入/i;
  const explicitLoginForms=new Set();
  const loginForms=[...document.forms].filter(form=>{
    const fields=[...form.elements].filter(visible);
    const password=fields.some(el=>el.type==='password'&&el.autocomplete!=='new-password');
    const otp=fields.some(el=>/otp|one.?time|two.?factor|verification|验证码/i.test(el.name+' '+el.autocomplete+' '+el.getAttribute('aria-label')));
    const buttons=fields.filter(el=>el.tagName==='BUTTON'||['submit','button'].includes(el.type));
    const action=new URL(form.getAttribute('action')||location.href,location.href);
    const loginAction=/login|signin|sign-in|authenticate|verify-login|dologin/i.test(action.pathname);
    const username=fields.some(el=>el.type==='email'||/username|email|login/i.test(el.name+' '+el.autocomplete));
    const changingPassword=fields.some(el=>el.autocomplete==='new-password')||/change.?password|reset.?password|修改密码|重置密码/i.test(action.pathname+' '+form.innerText);
    const explicit=(password||otp)&&(loginAction||buttons.some(el=>loginWords.test(el.innerText||el.value||el.textContent||''))||password&&username&&!changingPassword);
    if(explicit)explicitLoginForms.add(form);return explicit||otp;
  });
  document.querySelectorAll('[data-order-login-form]').forEach(el=>el.removeAttribute('data-order-login-form'));
  loginForms.forEach(el=>el.setAttribute('data-order-login-form','true'));
  const nodes=[...document.querySelectorAll('a,button,input[type="submit"]')].filter(el=>{
    const href=el.getAttribute('href')||'',text=el.innerText||el.value||el.textContent||'';
    if(!/log.?out|sign.?out|退出|注销/i.test(href+' '+text))return false;
    if(href){try{const url=new URL(href,location.href);if(url.origin!==location.origin||!['http:','https:'].includes(url.protocol))return false;}catch{return false;}}
    return visible(el)||el.tagName==='A'&&/log.?out|sign.?out/i.test(href);
  });
  document.querySelectorAll('[data-order-account-marker]').forEach(el=>el.removeAttribute('data-order-account-marker'));
  if(loginForms.length)return {status:explicitLoginForms.size?'logged_out':'unverified',url:location.href};
  let explicitMarker=null;
  if(proof?.selector){
    const matches=document.querySelectorAll(proof.selector);
    if(matches.length===1&&visible(matches[0])&&matches[0].textContent.trim()&&(!proof.text||matches[0].textContent.replace(/\s+/g,' ').trim()===proof.text))explicitMarker=matches[0];
  }
  const node=proof?.selector?explicitMarker:nodes.find(visible)||nodes[0];
  if(!node)return {status:'unverified',url:location.href};
  node.setAttribute('data-order-account-marker','true');
  return {status:'authenticated',url:location.href,ready:document.readyState!=='loading',check:{loggedInSelector:'[data-order-account-marker="true"]',...(explicitMarker?{proof:{selector:proof.selector,text:node.textContent.replace(/\s+/g,' ').trim()}}:{}),href:node.getAttribute('href')?new URL(node.getAttribute('href'),location.href).href:null}};
}
export async function createOrderBrowser(task, { proxyUrl = '', launch = chromium.launch.bind(chromium), timeoutMs = 60_000, signal, storageState, sessionStorageState, loginCheck, loginProof, loginOnly = false, restoringSession = false, accountReadOnly = false, loginVerificationTimeoutMs = 8000, onBeforeSubmit = async () => {}, onBeforePayment = async () => {}, onTrace = () => {}, stateTimeoutMs = 10000, couponVerificationTimeoutMs = 5000, onEvidence = async () => null } = {}) {
  if (signal?.aborted) throw new Error('下单操作已停止');
  const origin = new URL(task.url).origin;
  const readOnlyAccount = restoringSession || accountReadOnly;
  let verifiedLoginCheck=null,blockedAccountBackground = false,verifyingAccount=Boolean(loginCheck)||restoringSession||accountReadOnly;
  const expectedProduct=task.product||task.verifiedProduct||'',expectedCurrency=task.currency||task.verifiedCurrency||'';
  const paymentIntent=normalizePaymentMethod(task.paymentMethod);
  let paymentChoice=null,approvedPaymentRequest=null,approvedSubmissionRequest=null,approvedCouponRequest=null,gatewayHandoff=null,paymentOptions=[],financialRedirects=new Map();
  const affiliateUrl = task.affiliateUrl ? new URL(task.affiliateUrl) : null;
  let checkout = task.program?.checkout, remoteFieldCounter = 0;
  let affiliatePhase = false, affiliateEvidence = null, affiliateProof = null, affiliateCookie = null, affiliateField = null, accountBeforeAffiliate = null;
  const proxy = proxyUrl ? new URL(proxyUrl) : null;
  const releaseSlot = await browserSlots.acquireWhenClosing(!loginOnly && !task.dryRun && Boolean(task.program) && ['submit','pay'].includes(task.executionMode),{signal,verification:restoringSession});
  let browser;
  try { browser = await launch({ executablePath: process.env.MONITOR_BROWSER_EXECUTABLE || undefined, timeout:15000, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(proxy ? { proxy: { server: proxy.origin, bypass: '' } } : {}) }); } catch(error) { releaseSlot();signal?.throwIfAborted();if(isBrowserClosedError(error))throw Object.assign(new Error('浏览器启动时意外关闭，请稍后重试'),{code:'ORDER_BROWSER_CLOSED'});if(error.name==='TimeoutError')throw Object.assign(new Error('浏览器启动超时，请检查运行资源'),{code:'ORDER_BROWSER_TIMEOUT'});throw error; }
  let context, watchdog, storageSeed, seedMarker, timedOut=false, mutationPermit = false, committed = false, submissionStarted = false, paymentStarted = false, blockedRequest = '', receipt = null, submissionPermit = null, paymentPermit = null, couponPermit=null,couponChecks=null,couponProof=null,couponFailure=null,couponAttempted=false, orderPage = '', freshProductNavigation = false;
  const trace = [],loginValues=[];let authentication={},blockedRequestCode='',blockedRequestNotes=0,orderInteraction=0;
  const blockedError=()=>Object.assign(new Error(blockedRequest),{code:blockedRequestCode||undefined});
  const clean = input => {
    let value = String(input || '');
    for (const secret of [...Object.values(task.credentials || {}), ...loginValues, proxy ? decodeURIComponent(proxy.username) : '', proxy ? decodeURIComponent(proxy.password) : '']) if (secret) value = value.split(String(secret)).join('[已隐藏]');
    return value.replace(/([?&](?:token|key|password|secret)=)[^&\s]*/gi, '$1[已隐藏]').slice(0, 800);
  };
  const appendTrace=step=>{const safe={...step,detail:clean(step.detail)};trace.push(safe);if(trace.length>400)trace.shift();try{onTrace(safe);}catch{};};
  const sameOrigin = value => { const url = new URL(value, task.url); if (url.origin !== origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('下单程序只能访问配置的商品网站'); return url.href; };
  let browserClosing;
  const stop=()=>{releaseSlot.closing();clearTimeout(watchdog);signal?.removeEventListener('abort',stop);return browserClosing||=browser.close().catch(()=>{}).finally(releaseSlot);};
  const armWatchdog=milliseconds=>{clearTimeout(watchdog);watchdog=setTimeout(()=>{timedOut=true;void stop();},milliseconds);watchdog.unref();};
  try {
    appendTrace({action:'浏览器版本',detail:browser.version?.()||'unknown',at:new Date().toISOString()});
    context = await browserOperation(()=>browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: false, serviceWorkers: 'block', ...(storageState ? {storageState} : {}) }),{signal,timeoutMs:15000,code:'ORDER_BROWSER_TIMEOUT',message:'浏览器恢复登录数据超时，请稍后重试',onTimeout:stop});
    if(sessionStorageState){
      seedMarker='__radar_session_seed_'+randomUUID();
      storageSeed=await context.addInitScript(({origin,values,marker})=>{if(location.origin===origin&&!sessionStorage.getItem(marker)){for(const [key,value]of Object.entries(values))sessionStorage.setItem(key,value);sessionStorage.setItem(marker,'1');}},{origin,values:sessionStorageState,marker:seedMarker});
    }
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) { await closeOrderBrowser({close:stop}); throw new Error('下单操作已停止'); }
    armWatchdog(timeoutMs);
    await context.route('**/*', async route => {
      const request = route.request();
      let same = false;
      try { same = new URL(request.url()).origin === origin; } catch {}
      const kind=orderRequestKind(request.url()),isTransaction=kind==='submission',isPayment=kind==='payment';
      let allowedMutation = !readOnlyAccount && (mutationPermit || loginOnly) && !submissionStarted, allowedPayment = false;
      for (const permit of [couponPermit,submissionPermit, paymentPermit]) {
        if (!readOnlyAccount && permit && request.method() === 'POST' && request.url().split('#')[0] === permit.url && !permit.used) {
          const body=new URLSearchParams(request.postData() || '');
          if(permit.coupon){
            let values=body.getAll(permit.coupon.name);
            if(permit===couponPermit&&/application\/json/i.test(request.headers()['content-type']||'')){try{const json=JSON.parse(request.postData()||'');values=typeof json?.[permit.coupon.name]==='string'?[json[permit.coupon.name]]:[];}catch{values=[];}}
            if(JSON.stringify(values)!==JSON.stringify([permit.coupon.value])){blockedRequest='实际优惠码与配置不符，已停止';blockedRequestCode='ORDER_COUPON_UNVERIFIED';note('拦截请求','优惠码发生变化');await route.abort();return;}
          }
          if(permit.quantity && JSON.stringify(body.getAll(permit.quantity.name))!==JSON.stringify([permit.quantity.value])){blockedRequest='实际订单数量与已核对的数量不符，已停止';blockedRequestCode='ORDER_REQUEST_BLOCKED';note('拦截请求','订单数量发生变化');await route.abort();return;}
          if(permit.methodField && JSON.stringify(body.getAll(permit.methodField))!==JSON.stringify([permit.methodValue])){blockedRequest='实际付款方式与已核对的选择不符，已停止';await route.abort();return;}
          // Payment approval also binds the actual HTTP body to this invoice.
          if (permit === paymentPermit && JSON.stringify(new URLSearchParams(request.postData() || '').getAll(permit.invoiceField)) !== JSON.stringify([permit.invoiceId])) continue;
          if (permit === submissionPermit && committed && task.affiliateUrl) {
            const cookieHeader = (await request.allHeaders()).cookie || '';
            const affiliateHeaders=affiliateCookie?cookieHeader.split(';').map(item=>item.trim()).filter(item=>item.startsWith(affiliateCookie.name+'=')):[];
            const cookieOK=!affiliateCookie||affiliateHeaders.length===1&&affiliateHeaders[0]===affiliateCookie.name+'='+affiliateCookie.value;
            const fieldOK = !affiliateField || JSON.stringify(new URLSearchParams(request.postData() || '').getAll(affiliateField.name)) === JSON.stringify([affiliateField.value]);
            if (!affiliateProof || !cookieOK || !fieldOK) { blockedRequest = 'AFF 归因未随订单请求提交，已停止'; await route.abort(); return; }
            affiliateProof = {...affiliateProof,status:'sent',sentAt:new Date().toISOString()};
          }
          permit.used = true; permit.request=request; permit.onUsed?.(); allowedMutation = true; allowedPayment = permit === paymentPermit;
          appendTrace({action:'许可请求已发出',detail:describeOrderRequest(request.method(),request.url()),transaction:allowedPayment?'payment':submissionStarted?'submission':permit===couponPermit?'coupon':'cart',at:new Date().toISOString()});if(permit===couponPermit)approvedCouponRequest=request;else if(allowedPayment)approvedPaymentRequest=request;else if(submissionStarted&&permit===submissionPermit)approvedSubmissionRequest=request;
        }
      }
      const externalAsset = !request.isNavigationRequest() && ['GET','HEAD'].includes(request.method());
      const affiliateRead = affiliatePhase && new URL(request.url()).origin === affiliateUrl.origin && ['GET','HEAD'].includes(request.method());
      if ((!same && !externalAsset && !affiliateRead) || isPayment && !allowedPayment || isTransaction && (!allowedMutation || loginOnly) || !['GET', 'HEAD'].includes(request.method()) && !allowedMutation) {
        if (same) {
          // Account pages can issue background requests to any endpoint. Aborting
          // one cannot invalidate separate, genuine evidence of authentication.
          const preparingBackground=!submissionStarted&&!paymentStarted&&!orderInteraction&&!mutationPermit&&!couponPermit&&!submissionPermit&&!paymentPermit;
          const background = (loginOnly||readOnlyAccount||verifyingAccount||preparingBackground) && !request.isNavigationRequest();
          const phase=loginOnly?'登录':readOnlyAccount||verifyingAccount?'会话验证':task.dryRun?'试跑':paymentStarted?'付款':submissionStarted?'提交订单':'商品准备';
          const detail=clean(phase+'；'+describeOrderRequest(request.method(),request.url()));
          if(blockedRequestNotes++<20)appendTrace({action:background?'拦截后台请求':'拦截请求',detail,reason:isPayment&&!allowedPayment?'付款请求没有对应的单次许可':isTransaction?'订单请求没有对应的单次许可':'未核对的写入请求',permits:[couponPermit,submissionPermit,paymentPermit].filter(Boolean).map(permit=>({target:describeOrderRequest('POST',permit.url),used:permit.used,urlMatches:request.url().split('#')[0]===permit.url})),at:new Date().toISOString()});
          if (background) blockedAccountBackground = true;
          else {blockedRequest=(isTransaction||isPayment?'程序尝试了未授权的提交或付款请求':'网页尝试发送未核实的写入请求，已拦截')+'（'+detail+'）';blockedRequestCode='ORDER_REQUEST_BLOCKED';}
        }
        await route.abort(); return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    let currentObservation=null;
    const networkStatus=[];
    page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(15000);
    const financialResponses=['submit','pay'].includes(task.executionMode)||Boolean(task.couponCode);
    const proxyCredentials=proxy&&(proxy.username||proxy.password);
    if(financialResponses||proxyCredentials){
      // Playwright route handles only the first URL of an HTTP redirect chain.
      // Pause the actual response before any external navigation or POST replay.
      // Response-only Fetch interception cancels authenticated HTTPS proxy
      // challenges. Handle request-stage authentication on this same session.
      const responses=await context.newCDPSession(page);
      if(proxyCredentials)authentication=installProxyAuthentication(responses,proxy,{onRejected:stop});
      responses.on('Fetch.requestPaused',event=>{void (async()=>{
        const headers=event.responseHeaders||[],location=headers.find(header=>header.name.toLowerCase()==='location')?.value;
        const phase=event.request.method==='POST'?(event.request.url===approvedPaymentRequest?.url()?'payment':event.request.url===approvedSubmissionRequest?.url()?'submission':event.request.url===approvedCouponRequest?.url()?'coupon':null):['GET','HEAD'].includes(event.request.method)?financialRedirects.get(event.request.url):null;
        const financial=Boolean(phase);
        if(financial&&event.responseStatusCode>=400){
          blockedRequest='商家请求返回 HTTP '+event.responseStatusCode+'，请核对原订单记录；不会重新提交或付款';
          blockedRequestCode='ORDER_REQUEST_HTTP_ERROR';
        }
        if(financial&&[301,302,303,307,308].includes(event.responseStatusCode)&&location){
          const target=new URL(location,event.request.url),payment=phase==='payment';
          let intercepted=false;
          if(event.request.method==='POST'&&[307,308].includes(event.responseStatusCode)){blockedRequest=phase==='coupon'?'网站要求重发优惠码请求，已停止':'网站要求重发订单或付款请求，已停止；请核对原订单记录';intercepted=true;}
          else if(target.origin!==origin){
            intercepted=true;
            if(payment&&['http:','https:'].includes(target.protocol)&&!target.username&&!target.password&&target.href.length<=4000)gatewayHandoff={url:target.href,source:'payment_redirect'};
            else blockedRequest='订单提交跳转到其他网站，已停止；请核对原订单记录';
          }
          if(!intercepted){if(financialRedirects.size>=10){blockedRequest='商家跳转次数过多，请核对原订单';intercepted=true;}else financialRedirects.set(target.href,phase);}
          if(intercepted){
            await responses.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,responseHeaders:[...headers.filter(header=>!['location','content-length','content-encoding','content-type'].includes(header.name.toLowerCase())),{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from('<main><p>请在工作台查看本次订单或付款结果。</p></main>').toString('base64')});return;
          }
        }
        await responses.send('Fetch.continueRequest',{requestId:event.requestId});
      })().catch(async()=>{if(browser.isConnected()&&financialResponses&&event.responseStatusCode&&!authentication.proxyRejected&&!authentication.websiteRequired){blockedRequest||='无法核对商家跳转响应，已停止';await responses.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'}).catch(()=>{});}});});
      await responses.send('Fetch.enable',{...(proxyCredentials?{handleAuthRequests:true}:{}),patterns:[...(proxyCredentials?[{urlPattern:'*',requestStage:'Request'}]:[]),...(financialResponses?['Document','XHR','Fetch'].map(resourceType=>({resourceType,requestStage:'Response'})):[])]});
    }

    context.on('page', extra => { if (extra !== page) extra.close().catch(() => {}); });
    const navigate=(url,options)=>browserAuthenticatedNavigation(()=>page.goto(url,options),authentication,Boolean(proxy));
    const readPage=operation=>settledBrowserRead(operation,{signal,timeoutMs:5000,code:'ORDER_NAVIGATION_UNSTABLE',message:'网页跳转尚未稳定，请核对网站订单记录'});
    const ensure = async (allowChallenge = loginOnly) => {
      if (signal?.aborted) throw new Error('下单操作已停止');
      sameOrigin(page.url());
      if (blockedRequest) throw blockedError();
      if(authentication.proxyRejected||authentication.websiteRequired)throw browserAuthenticationError(new Error('浏览器认证未完成'),authentication,Boolean(proxy));
      if (!allowChallenge && isChallengePage(await readPage(()=>page.content()), {})) throw new Error('目标网站正在要求验证，请更换可用出口或稍后重试');
    };
    const one = async key => { await ensure(); const field = page.locator(selector(key)); if (await field.count() !== 1) throw new Error('网页元素不存在或不唯一：' + key); return field; };
    const note = (action, detail) => { appendTrace({ action, detail, at: new Date().toISOString() }); };
    page.on('response',response=>{const request=response.request();if(request.isNavigationRequest()||!['GET','HEAD'].includes(request.method()))appendTrace({action:'网页响应',detail:describeOrderRequest(request.method(),request.url())+'；HTTP '+response.status(),httpStatus:response.status(),at:new Date().toISOString()});});
    page.on('requestfailed',request=>appendTrace({action:'请求失败',detail:describeOrderRequest(request.method(),request.url())+'；'+(request.failure()?.errorText||''),at:new Date().toISOString()}));
    const sendPermittedRequest=async(button,permit)=>{
      let used,rejected;const sent=new Promise((resolve,reject)=>{used=resolve;rejected=reject;});sent.catch(()=>{});permit.onUsed=used;
      const failed=request=>{if(!permit.used&&request.method()==='POST'&&request.url().split('#')[0]===permit.url)rejected(blockedRequest?blockedError():new Error('已核对的网站请求发送失败，请核对网站订单记录'));};page.on('requestfailed',failed);
      let navigated;const navigation=new Promise(resolve=>{navigated=frame=>{if(frame===page.mainFrame())resolve();};page.on('framenavigated',navigated);});
      try{await button.click();if(!permit.used)await browserOperation(()=>sent,{signal,timeoutMs:8000,code:'ORDER_REQUEST_NOT_SENT',message:'网站没有发出已核对的请求，请核对网站订单记录'});
        const response=await browserOperation(()=>permit.request.response(),{signal,timeoutMs:15000,code:'ORDER_REQUEST_RESPONSE_TIMEOUT',message:'网站尚未返回已核对请求的响应，请核对网站订单记录'});
        if(!response)throw Object.assign(new Error('网站请求未取得响应，请核对网站订单记录'),{code:'ORDER_REQUEST_RESPONSE_MISSING'});
        if(response.status()>=400)throw Object.assign(new Error('商家请求返回 HTTP '+response.status()+'，请核对原订单记录；不会重新提交或付款'),{code:'ORDER_REQUEST_HTTP_ERROR'});
        // A POST response can precede the remaining redirects. Wait for the
        // committed main document before examining payment or order evidence.
        if(permit.request.isNavigationRequest()){
          await browserOperation(()=>navigation,{signal,timeoutMs:15000,code:'ORDER_REDIRECT_TIMEOUT',message:'网站跳转尚未完成，请核对网站订单记录'});
          await browserOperation(()=>page.waitForLoadState('domcontentloaded'),{signal,timeoutMs:15000,code:'ORDER_REDIRECT_TIMEOUT',message:'网站跳转尚未完成，请核对网站订单记录'});
        }
      }
      finally{delete permit.onUsed;page.removeListener('requestfailed',failed);page.removeListener('framenavigated',navigated);}
    };
    const actionText = field => field.evaluate(el=>el.innerText||el.value||'');
    const fieldValue = field => field.evaluate(el => el.tagName==='SELECT'?[...el.selectedOptions].map(option=>option.textContent).join(' '):'value' in el ? String(el.value) : el.innerText);
    const verifyCurrency = async key => {
      const currencies = String(await fieldValue(await one(key))).toUpperCase().match(/\b[A-Z]{3}\b/g);
      if (currencies?.length !== 1 || currencies[0] !== (expectedCurrency || receipt?.review?.currency)) throw new Error('无法确认订单币种，已停止');
    };
    const beforeOrder = () => { freshProductNavigation=false; if (submissionStarted) throw new Error('订单已提交，不能再修改商品或跳转到其他订单'); };
    const snapshot = async scope => {
      await ensure();
      if(scope)await one(scope);
      const evidence = await readPage(()=>page.evaluate(scope => {
        const root=scope?document.querySelector(scope):document.body;
        const candidates=[root,...root.querySelectorAll('a,button,input,select,textarea,form,[id],label,h1,h2,h3')].filter(el=>el.getClientRects().length||el.tagName==='INPUT'&&el.type==='hidden');
        const priority=el=>el.closest('nav,header,footer,[role="navigation"]')?0:el.matches('form,input,select,textarea,button,label')?4:el.closest('form,main,[role="main"]')?3:el.matches('h1,h2,h3')?2:1;
        candidates.sort((a,b)=>priority(b)-priority(a));
        const textRoot=scope?root:document.querySelector('main,[role="main"]')||root;
        const text=textRoot.innerText||'';
        return {url:location.origin+location.pathname+location.search.replace(/([?&](?:token|key|password|secret)=)[^&]*/gi,'$1[hidden]'),title:document.title,text:text.slice(0,12000),scope:scope||null,
          truncated:{elements:candidates.length>160,text:text.length>12000},totalElements:candidates.length,
          elements:candidates.slice(0,160).map(el=>({tag:el.tagName.toLowerCase(),id:el.id,class:el.getAttribute('class'),name:el.getAttribute('name'),type:el.getAttribute('type'),text:(el.tagName==='INPUT'?'':el.textContent||'').trim().slice(0,120),href:el.tagName==='A'?el.getAttribute('href'):undefined,action:el.tagName==='FORM'?el.getAttribute('action'):undefined,method:el.tagName==='FORM'?el.method:undefined,disabled:Boolean(el.disabled),form:el.form?.id||undefined,label:(el.labels?.[0]?.innerText||el.getAttribute('aria-label')||'').trim().slice(0,120),value:el.tagName==='INPUT'&&el.type==='radio'?el.value:undefined,checked:el.tagName==='INPUT'&&el.type==='radio'?el.checked:undefined,options:el.tagName==='SELECT'?[...el.options].slice(0,30).map(o=>({value:o.value,text:o.textContent})):undefined}))};
      },scope||null));
      const scrub = value => {
        if (typeof value === 'string') {
          for (const secret of Object.values(task.credentials || {})) if(secret)value=value.split(String(secret)).join('[已隐藏]');
          return value.replace(/([?&](?:token|key|password|secret)=)[^&\s]*/gi,'$1[已隐藏]');
        }
        if (Array.isArray(value)) return value.map(scrub);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scrub(item)]));
        return value;
      };
      return {...scrub(evidence), ...(affiliateEvidence ? {affiliate:{...affiliateEvidence,proof:affiliateProof}} : {})};
    };
    const scrubObservation=value=>{
      if(typeof value==='string'){
        for(const secret of [...Object.values(task.credentials||{}),...loginValues])if(secret)value=value.split(String(secret)).join('[已隐藏]');
        return value.replace(/\bhttps?:\/\/[^\s"'<>]+/g,diagnosticUrl).replace(/([?&](?:token|key|password|secret|csrf|session)[^=]*)=[^&\s"'<>]*/gi,'$1=[已隐藏]');
      }
      if(Array.isArray(value))return value.map(scrubObservation);
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scrubObservation(item)]));
      return value;
    };
    const observe=async()=>{
      await ensure();const evidence=await readPage(()=>page.evaluate(inspectCommercePage,randomUUID()));
      currentObservation={...scrubObservation(evidence),network:networkStatus.slice(-50),...(affiliateEvidence?{affiliate:{...affiliateEvidence,proof:affiliateProof}}:{})};
      return currentObservation;
    };
    page.on('response',response=>{networkStatus.push({url:diagnosticUrl(response.url()),status:response.status(),method:response.request().method()});if(networkStatus.length>50)networkStatus.shift();});
    page.on('requestfailed',request=>{networkStatus.push({url:diagnosticUrl(request.url()),method:request.method(),error:clean(request.failure()?.errorText)});if(networkStatus.length>50)networkStatus.shift();});
    const resolveSemantic=target=>resolveSemanticTarget(page,currentObservation,target);
    const readSemantic=async target=>{
      const located=await resolveSemantic(target),field=await one(located.selector);
      return scrubObservation(await field.evaluate(el=>{
        if(el.type==='password'||/token|secret|csrf|session|card|cvv|cvc/i.test(el.name+' '+el.id))throw new Error('私密字段不能用于 AI 配置核验');
        return {tag:el.tagName.toLowerCase(),type:el.type,checked:el.checked,value:el.tagName==='SELECT'?[...el.selectedOptions].map(o=>o.textContent.trim()).join(' '):['INPUT','TEXTAREA'].includes(el.tagName)?String(el.value):undefined,text:(el.innerText||'').trim()};
      }));
    };
    const captureEvidence=async stage=>{
      await ensure();
      const observation={...scrubObservation(await readPage(()=>page.evaluate(inspectCommercePage,{observationId:randomUUID(),assignRefs:false}))),network:networkStatus.slice(-50)};
      const image='data:image/png;base64,'+(await page.screenshot({mask:[page.locator('input,textarea,[contenteditable="true"],[data-private]')],timeout:5000})).toString('base64');
      const stored=await onEvidence({stage,observation,image});
      note('页面证据',stage+(stored?.id?' · '+stored.id:''));
      return {...stored,image};
    };
    const waitSemanticConfirmation=async(kind,before)=>{
      const until=Date.now()+8000;
      do{
        const observed=confirmationEvidence(await observe(),kind);
        if(observed&&(kind==='order'?observed.orderId!==before?.orderId:observed.text!==before?.text))return observed;
        await page.waitForTimeout(150);
      }while(Date.now()<until);
      throw Object.assign(new Error('缺少本次'+(kind==='order'?'订单编号及成功提示':'付款成功提示')+'，请核对网站记录；不会重复操作'),{code:'ORDER_CONFIRMATION_UNVERIFIED'});
    };
    const verifyLogin = async saved => {
      const deadline=Date.now()+loginVerificationTimeoutMs;let observed,stableUrl='';
      do {
        await ensure(true);
        try{observed=await page.evaluate(inspectOrderLogin,saved?.proof||loginProof);}
        catch(error){if(!/Execution context was destroyed|Cannot find context/i.test(error.message))throw error;observed=null;}
        if(observed?.status==='authenticated'&&observed.ready){
          if(stableUrl===observed.url){verifiedLoginCheck={...observed.check,url:sameOrigin(observed.url)};return verifiedLoginCheck;}
          stableUrl=observed.url;
        }else stableUrl='';
        if(Date.now()>=deadline)break;
        await page.waitForTimeout(100);
      }while(Date.now()<deadline);
      await ensure(false);
      const expired=saved&&observed?.status==='logged_out'&&!blockedAccountBackground;
      const detail=blockedAccountBackground?'；验证期间已拦截网页后台写入请求；若账户信息依赖这些请求，请设置同网站可直接读取的登录后账户页面；原会话仍保留':'';
      throw Object.assign(new Error((expired?'网站已返回登录或二次认证页面，请重新登录并保存会话':saved?'当前网页暂时无法确认登录状态；已保存的会话仍保留，请稍后验证':'尚未确认网站登录，请完成登录或二次认证后再保存；当前窗口会保留')+detail),{code:expired?'ORDER_LOGIN_REQUIRED':'ORDER_LOGIN_UNVERIFIED'});
    };
    const visitAffiliate = async () => {
      if(!affiliateUrl)return;
      const before = await context.cookies(task.url);accountBeforeAffiliate=await context.storageState({indexedDB:true});
      affiliatePhase=true;
      try {
        const response=await navigate(affiliateUrl.href,{waitUntil:'domcontentloaded'});
        if(!response || response.status()>=400)throw new Error('AFF 入口不可用，已停止');
        if(new URL(page.url()).origin!==origin)throw new Error('AFF 入口没有返回下单网站，请使用可到达商家网站的推广链接');
        const queryKey=task.program?.affiliate?.queryKey||[...affiliateUrl.searchParams.keys()].find(key=>/^(?:aff|affid|affiliate|affiliate_id|ref|refid|referral|partner)$/i.test(key));
        const expected=queryKey&&affiliateUrl.searchParams.get(queryKey),cookieName=task.program?.affiliate?.cookieName;
        const tracked=(await context.cookies(task.url)).some(cookie=>(cookieName?cookie.name===cookieName:/aff|referral|referrer|partner/i.test(cookie.name))&&expected&&(cookie.value===expected||(()=>{try{return decodeURIComponent(cookie.value)===expected;}catch{return false;}})()));
        if(!tracked)await page.waitForTimeout(250);await ensure();
      } finally { affiliatePhase=false; }
      const after=await context.cookies(task.url);
      affiliateEvidence={url:affiliateUrl.href,visitedAt:new Date().toISOString(),landingUrl:clean(page.url()),cookieNames:after.map(c=>c.name),changedCookieNames:after.filter(c=>!before.some(old=>old.name===c.name&&old.domain===c.domain&&old.path===c.path&&old.value===c.value)).map(c=>c.name)};
      note('AFF 入口', '已访问指定入口，等待实际归因核对');
    };
    const verifyAffiliate = async (form, checks) => {
      if(!affiliateUrl)return;
      const proposed=checks || task.program?.affiliate || {};
      const queryKey=proposed.queryKey || [...affiliateUrl.searchParams.keys()].find(key=>/^(?:aff|affid|affiliate|affiliate_id|ref|refid|referral|partner)$/i.test(key));
      const expected=queryKey ? affiliateUrl.searchParams.get(queryKey) : '';
      if(!expected)throw new Error('无法确认 AFF 标识，请重新生成脚本核对推广参数');
      const cookies=await context.cookies(sameOrigin(form.url));
      const candidate=cookies.find(c=>(proposed.cookieName ? c.name===proposed.cookieName : /aff|referral|referrer|partner/i.test(c.name)) && (c.value===expected || (()=>{try{return decodeURIComponent(c.value)===expected;}catch{return false;}})()));
      if(candidate){if(cookies.filter(cookie=>cookie.name===candidate.name).length!==1)throw new Error('AFF Cookie 存在冲突，无法确定归因，已停止');affiliateCookie=candidate;affiliateField=null;affiliateProof={status:'verified',via:'cookie',name:candidate.name,affiliateId:expected,visitedAt:affiliateEvidence.visitedAt};}
      else if(proposed.fieldSelector){
        const field=await one(proposed.fieldSelector);
        const value=await field.evaluate((el,submit)=>({name:el.name,value:el.value,belongs:!!el.form&&el.form===document.querySelector(submit)?.form}),checkout.submitSelector);
        if(!value.belongs||!value.name||String(value.value)!==expected)throw new Error('订单中的 AFF 标识与指定推广链接不符，已停止');
        affiliateCookie=null;affiliateField={name:value.name,value:expected};affiliateProof={status:'verified',via:'field',name:value.name,affiliateId:expected,visitedAt:affiliateEvidence.visitedAt};
      }else throw new Error('无法验证指定 AFF 的归因 Cookie 或订单字段，已停止在提交前');
      note('AFF 核对','已确认 '+affiliateProof.name+' 对应指定推广标识');
    };
    const couponError=(message,code='ORDER_COUPON_UNVERIFIED')=>Object.assign(new Error(message),{code});
    // Only failed discount evidence can use the configured fallback. Request
    // binding, authentication and transaction errors always retain their guard.
    const couponOutcomeError=(message,code)=>Object.assign(couponError(message,code),{couponOutcome:true});
    const readCouponProof=async(checks,configured=true)=>{
      await ensure();
      const code=page.locator(selector(checks.appliedCodeSelector)),discount=page.locator(selector(checks.discountSelector));
      if(await code.count()!==1||await discount.count()!==1||!await code.isVisible()||!await discount.isVisible())throw couponOutcomeError('无法确认优惠码已生效及实际减免金额，已停止在下单前');
      const evidence=await code.evaluate((el,total)=>({value:'value' in el?String(el.value):el.innerText,editable:el.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(el.tagName)&&!el.disabled&&!el.readOnly,sameTotal:el===document.querySelector(total)}),checkout.totalSelector);
      if(evidence.editable||evidence.sameTotal)throw couponOutcomeError('优惠码生效证据不能使用可编辑输入或订单总价');
      const label=String(evidence.value||'').trim(),escaped=Array.from(task.couponCode,c=>'.*+?^$(){}|[]'.includes(c)||c.charCodeAt(0)===92?String.fromCharCode(92)+c:c).join('');
      if(/invalid|expired|reject|not.{0,12}(?:valid|applied)|fail|无效|过期|失败|未.{0,5}生效|不.{0,5}适用/i.test(label.split(task.couponCode).join('')))throw couponOutcomeError('网站未接受优惠码，已停止在下单前','ORDER_COUPON_REJECTED');
      if(configured&&!new RegExp('(^|[^\\p{L}\\p{N}_-])'+escaped+'($|[^\\p{L}\\p{N}_-])','iu').test(label))throw couponOutcomeError('网站已应用的优惠码与配置不符，已停止在下单前');
      const amount=await discount.evaluate((el,total)=>({text:el.innerText,sameTotal:el===document.querySelector(total)}),checkout.totalSelector);
      if(amount.sameTotal)throw couponOutcomeError('优惠金额必须是实际减免金额，不能使用百分比或订单总价');
      let value;try{value=parseOrderTotal(String(amount.text).replace(/\d+(?:[.,]\d+)?\s*(?:%|percent\b|个百分点)/gi,'').replace(/[−-]/g,''));}catch{throw couponOutcomeError('无法唯一确认优惠减免金额');}
      if(value<=0)throw couponOutcomeError('优惠码没有产生可确认的减免金额，已停止在下单前','ORDER_COUPON_REJECTED');
      return {code:configured?task.couponCode:label,discount:value};
    };
    const preserveCouponPayment=async()=>{
      if(!paymentChoice||task.executionMode!=='pay'||parseOrderTotal(await (await one(checkout.totalSelector)).innerText())===0)return;
      const {info}=await readPaymentChoice(paymentChoice.selector,paymentChoice.value);
      if(info.value!==paymentChoice.value||info.type==='radio'&&!info.checked)await choosePayment({selector:paymentChoice.selector,value:paymentChoice.value});
      else paymentChoice={...paymentChoice,url:page.url(),field:info.name,control:info.type,label:info.label};
    };
    const continueWithoutCoupon=async error=>{
      if(task.couponFailurePolicy!=='continue'||!error.couponOutcome)throw error;
      await ensure();
      couponProof=null;
      couponFailure={code:task.couponCode,status:error.code==='ORDER_COUPON_REJECTED'?'rejected':'unverified',failurePolicy:'continue',errorCode:error.code,reason:clean(error.message).replace(/，已停止(?:在下单前)?$/, '')};
      note('优惠码失败继续',couponFailure.reason+'；按用户预选继续，仍核对网站实际总价和预算上限');
      await preserveCouponPayment();
      return {couponFailure:{...couponFailure}};
    };
    const applyCoupon=async(checks,liveChecks,{rebind}={})=>{
      beforeOrder();
      if(!task.couponCode||loginOnly||readOnlyAccount||verifyingAccount)throw couponError('当前阶段没有配置可应用的优惠码');
      if(couponAttempted)throw couponError('同一次流程不重复应用优惠码');couponAttempted=true;
      if(liveChecks){for(const key of ['submitSelector','productSelector','quantitySelector','totalSelector','currencySelector','confirmationSelector'])selector(liveChecks[key]);checkout={...liveChecks};}
      try{
      if(!checks||typeof checks!=='object'||Array.isArray(checks))throw couponOutcomeError('缺少优惠码实际控件，无法确认生效');
      for(const key of ['inputSelector','applySelector','appliedCodeSelector','discountSelector'])selector(checks[key]);
      couponChecks={...checks};
      try{couponProof=await readCouponProof(couponChecks);note('优惠码','已核验同一优惠码和减免金额，复用已应用优惠');await preserveCouponPayment();return couponProof;}catch(error){if(!['ORDER_COUPON_UNVERIFIED','ORDER_COUPON_REJECTED'].includes(error.code))throw error;}
      let previousDiscount=0;try{previousDiscount=(await readCouponProof(couponChecks,false)).discount;}catch(error){if(!['ORDER_COUPON_UNVERIFIED','ORDER_COUPON_REJECTED'].includes(error.code))throw error;}
      const beforeTotal=parseOrderTotal(await (await one(checkout.totalSelector)).innerText())+previousDiscount;
      await ensure();
      const input=page.locator(checks.inputSelector),button=page.locator(checks.applySelector);
      if(await input.count()!==1||await button.count()!==1||!await input.isVisible()||!await button.isVisible())throw couponOutcomeError('优惠码控件不存在、不唯一或不可见，无法确认生效');
      const form=await button.evaluate(inspectOrderForm,{kind:'coupon',selector:checks.inputSelector});
      if(!form?.coupon||form.payment||!['text','search'].includes(form.coupon.type)||form.method!=='POST'||form.encoding!=='application/x-www-form-urlencoded'||paymentWords.test(form.text)||!/(?:apply|redeem|validat|coupon|promo|discount|应用|使用|兑换|优惠|折扣)/i.test(form.text)||checks.applySelector===checkout.submitSelector)throw couponError('无法核对优惠码输入和独立应用按钮，已停止在下单前');
      const target=sameOrigin(form.url).split('#')[0],orderButton=await one(checkout.submitSelector),orderForm=await orderButton.evaluate(inspectOrderForm,{kind:'submit',selector:checkout.quantitySelector});
      if(orderRequestKind(target)||orderForm&&target===sameOrigin(orderForm.url).split('#')[0])throw couponError('优惠码操作指向订单提交或付款地址，已停止在下单前');
      await input.fill(task.couponCode);
      const bound=await button.evaluate(inspectOrderForm,{kind:'coupon',selector:checks.inputSelector});
      if(!bound?.coupon||bound.coupon.value!==task.couponCode||sameOrigin(bound.url).split('#')[0]!==target||bound.method!=='POST')throw couponError('优惠码表单在填写后发生变化，已停止');
      const permit={url:target,used:false,coupon:{name:bound.coupon.name,value:task.couponCode}};couponPermit=permit;
      note('优惠码','正在应用配置中的优惠码');
      try{await sendPermittedRequest(button,permit);}finally{couponPermit=null;}
      await ensure();
      if(!permit.used)throw couponError('网站没有发送已核对的优惠码请求');
      if(rebind){const fresh=await rebind();couponChecks={...fresh.coupon};checkout={...checkout,...fresh.checkout};}
      const deadline=Date.now()+couponVerificationTimeoutMs;let lastError;
      do{
        await ensure();
        try{const proof=await readCouponProof(couponChecks),afterTotal=parseOrderTotal(await (await one(checkout.totalSelector)).innerText());
          if(Math.round(afterTotal*100)<Math.round(beforeTotal*100)){couponProof=proof;break;}
          lastError=couponOutcomeError('优惠码应用后总价没有降低，已停止在下单前','ORDER_COUPON_REJECTED');
        }catch(error){if(!['ORDER_COUPON_UNVERIFIED','ORDER_COUPON_REJECTED'].includes(error.code))throw error;lastError=error;}
        if(Date.now()>=deadline)break;await page.waitForTimeout(100);
      }while(Date.now()<deadline);
      if(!couponProof)throw lastError||couponOutcomeError('网站未确认优惠码生效，已停止在下单前');
      note('优惠码','已核验实际优惠 '+couponProof.discount+'，按优惠后总价核对');await preserveCouponPayment();return couponProof;
      }catch(error){return await continueWithoutCoupon(error);}
    };
    const review = async () => {
      await ensure();
      const checks=checkout;
      const read=async(key,input=false)=>{const field=page.locator(selector(key));if(await field.count()!==1)throw new Error('网页元素不存在或不唯一：'+key);return input?fieldValue(field):field.innerText();};
      for(const item of checkout.configuration||[]){const field=await one(item.selector),actual=await fieldValue(field);if(String(actual).normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase()!==item.value.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase())throw Object.assign(new Error('提交前商品配置发生变化：'+item.name),{code:'AGENT_CONFIGURATION_UNVERIFIED'});}
      const [productText,totalText,quantityText,currencyText]=await Promise.all([read(checks.productSelector),read(checks.totalSelector),read(checks.quantitySelector,true),read(checks.currencySelector,true)]);
      const productName=value=>value.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
      if(!productText.trim()||productText.trim().length>200||!expectedProduct&&!task.dryRun)throw new Error('商品尚未通过试跑核对，请重新生成');
      if(expectedProduct&&productName(productText)!==productName(expectedProduct))throw new Error('订单中的商品与配置不符，已停止');
      const total=parseOrderTotal(totalText),currencies=String(currencyText).toUpperCase().match(/\b[A-Z]{3}\b/g);
      if(currencies?.length!==1||expectedCurrency&&currencies[0]!==expectedCurrency||!expectedCurrency&&!task.dryRun)throw new Error('无法确认订单币种，已停止');
      if(!/^\s*\d+\s*$/.test(quantityText)||Number(quantityText)!==task.quantity)throw new Error('订单数量与配置不符，已停止');
      if(task.couponCode&&!couponFailure&&(!couponAttempted||!couponChecks||!couponProof))throw couponError('配置了优惠码但尚未核验生效，已停止');
      if(total>task.maxTotal)throw new Error('订单总价超过上限，已停止');
      let coupon=null;
      if(task.couponCode&&!couponFailure){
        if(!couponAttempted||!couponChecks||!couponProof)throw couponError('配置了优惠码但尚未核验生效，已停止');
        try{coupon=await readCouponProof(couponChecks);if(coupon.discount!==couponProof.discount)throw couponOutcomeError('优惠减免金额发生变化，已停止');}
        catch(error){await continueWithoutCoupon(error);return review();}
      }
      if(total===0&&!coupon)throw new Error('零金额订单缺少已核验的优惠依据，已停止');
      return {product:expectedProduct||productText.trim(),quantity:task.quantity,total,currency:expectedCurrency||currencies[0],...(checkout.semantic?{configuration:(checkout.configuration||[]).map(({name,value})=>({name,value}))}:{}),...(coupon?{coupon}:{}),...(couponFailure?{couponFailure:{...couponFailure}}:{})};
    };
    const readPaymentChoice=async (key,value)=>{
      const field=await one(key);
      const info=await field.evaluate((el,wanted)=>{
        const readable=node=>(node?.innerText||node?.textContent||'').replace(/\s+/g,' ').trim();
        if(el.tagName==='SELECT'){
          const options=[...el.options].filter(option=>!option.disabled).map(option=>({value:option.value,label:readable(option)}));
          const chosen=options.filter(option=>option.value===(wanted ?? el.value));
          return {type:'select',name:el.name,value:el.value,label:chosen.length===1?chosen[0].label:'',options,valid:chosen.length===1&&!el.disabled,form:!!el.form};
        }
        if(el.tagName==='INPUT'&&el.type==='radio'){
          const radios=[...document.querySelectorAll('input[type=radio]')].filter(radio=>radio.form===el.form&&radio.name===el.name&&!radio.disabled);
          const options=radios.map(radio=>({value:radio.value,label:readable(radio.labels?.[0])||radio.getAttribute('aria-label')||''}));
          return {type:'radio',name:el.name,value:el.value,label:readable(el.labels?.[0])||el.getAttribute('aria-label')||'',options,valid:!el.disabled&&(!wanted||el.value===wanted)&&options.filter(option=>option.value===el.value).length===1,form:!!el.form,checked:el.checked};
        }
        return {valid:false};
      },value==null?null:String(value));
      if(info.form&&info.options?.some(option=>paymentBrand(option.label)||paymentMatchesIntent(option.label,paymentIntent)))paymentOptions=info.options.slice(0,30).map(option=>({...option,label:String(option.label).slice(0,150),kind:paymentBrand(option.label)==='balance'?'balance':'website'}));
      if(!info.valid||!info.form||!info.name||info.name.length>200||String(info.value).length>300||!info.label||info.label.length>150||!paymentMatchesIntent(info.label,paymentIntent))throw Object.assign(new Error('网页付款选项与预选方式不符，无法确认 '+paymentIntent.name),{code:'ORDER_PAYMENT_UNVERIFIED'});
      return {field,info};
    };
    const choosePayment=async checks=>{
      if(task.executionMode!=='pay')throw new Error('该任务没有允许自动付款');
      if(paymentStarted||submissionStarted&&(receipt?.status!=='ordered'||page.url()!==orderPage))throw new Error('只能为本次订单选择预先指定的付款方式');
      if(!checks||typeof checks!=='object')throw new Error('缺少付款方式定位');
      const key=selector(checks.selector),{field,info}=await readPaymentChoice(key,checks.value);
      if(info.type==='select')await field.selectOption(String(checks.value ?? info.value));else await field.check();
      const observed=await readPaymentChoice(key);
      if(observed.info.type==='radio'&&!observed.info.checked)throw new Error('网站没有接受预选的付款方式');
      paymentChoice={kind:paymentIntent.kind,name:paymentIntent.name,label:observed.info.label,value:observed.info.value,field:observed.info.name,control:observed.info.type,selector:key,url:page.url(),options:observed.info.options.slice(0,30).map(option=>({...option,kind:paymentBrand(option.label)==='balance'?'balance':'website'}))};
      if(key.startsWith('[data-agent-ref=')){const identity=randomUUID();await field.evaluate((el,id)=>el.setAttribute('data-agent-payment',id),identity);paymentChoice.selector='[data-agent-payment="'+identity+'"]';}
      if(task.verifiedPaymentMethod&&!samePaymentChoice(task.verifiedPaymentMethod,paymentChoice))throw new Error('网站付款方式已变化，请重新试跑');
      note('付款方式',paymentChoice.label+' · 已按实际网页选中');return {...paymentChoice,url:undefined};
    };
    const bindPaymentChoice=async(button)=>{
      if(!paymentChoice||paymentChoice.url!==page.url())return null;
      const {info}=await readPaymentChoice(paymentChoice.selector);
      const belongs=await button.evaluate((el,key)=>el.form===document.querySelector(key)?.form,paymentChoice.selector);
      if(!belongs||info.value!==paymentChoice.value||info.name!==paymentChoice.field||info.type==='radio'&&!info.checked)throw new Error('实际付款方式已变化，已停止');
      return paymentChoice;
    };
    const methods = {
      choosePayment,applyCoupon,observe,resolveSemantic,readSemantic,
      rebindCoupon:async checks=>{if(!couponProof&&!couponFailure)throw couponError('尚未验证优惠');for(const key of ['appliedCodeSelector','discountSelector'])selector(checks[key]);couponChecks={...couponChecks,...checks};return true;},
      screenshot:async()=>{await ensure();return 'data:image/png;base64,'+(await page.screenshot({mask:[page.locator('input,textarea,[contenteditable="true"],[data-private]')],timeout:5000})).toString('base64');},
      goto: async url => { const fresh=freshProductNavigation,target=sameOrigin(url);beforeOrder();if(!fresh||target!==task.url||page.url()!==target)await navigate(target, { waitUntil: 'domcontentloaded' }); await ensure(); note('访问', page.url()); return true; },
      snapshot, exists: async key => { await ensure(); return await page.locator(selector(key)).count() === 1; },
      text: async key => clean(await (await one(key)).innerText()),
      fill: async (key, value) => {
        beforeOrder();
        if (typeof value !== 'string' && typeof value !== 'number' || String(value).length > 2000) throw new Error('填写内容无效');
        const field = await one(key);
        if (await field.evaluate(el => el.type === 'password' || /(?:cardnumber|card_number|ccnumber|cvv|cvc)/i.test(el.name || el.id))) throw new Error('账号凭据只能使用 login，银行卡信息不能交给 AI 填写');
        await field.fill(String(value)); note('填写', key); return true;
      },
      select: async (key, value) => { beforeOrder(); await (await one(key)).selectOption(String(value)); note('选择', key); return true; },
      check: async key => { beforeOrder(); await (await one(key)).check(); note('勾选', key); return true; },
      uncheck: async key => { beforeOrder(); await (await one(key)).uncheck(); note('取消勾选', key); return true; },
      click: async key => {
        beforeOrder();
        const field = await one(key);
        const description = await field.evaluate(el => ({ text: el.innerText || el.value || '', submit: !!el.form && (el.tagName === 'BUTTON' && (!el.type || el.type === 'submit') || el.tagName === 'INPUT' && ['submit','image'].includes(el.type)) }));
        if (key === task.program?.checkout?.submitSelector || paymentWords.test(description.text) || description.submit) throw new Error('提交表单只能通过受控的 login、cart、submit 或 pay 操作');
        const previousUrl=page.url();await field.click();if(page.url()===previousUrl)await page.waitForTimeout(200);else await page.waitForLoadState('domcontentloaded'); await ensure(); note('点击', key); return true;
      },
      cart: async key => {
        beforeOrder();
        const button = await one(key);
        const form=await button.evaluate(inspectOrderForm,{kind:'cart'});
        if (!form || key === task.program?.checkout?.submitSelector || paymentWords.test(form.text) || !/(?:add.*cart|update.*cart|continue|加入购物车|添加|继续|更新购物车)/i.test(form.text) || /terms|条件|条款|billing\s+address|payment\s+method/i.test(form.content) || form.fields.some(field=>field.type==='password'||/(?:email|address|payment|credit|card|cvv|cvc|firstname|lastname|terms)/i.test(field.name))) throw new Error('无法确认这是商品配置或购物车表单，已停在提交前');
        const target = sameOrigin(form.url).split('#')[0];
        if(orderRequestKind(target))throw Object.assign(new Error('购物车操作指向订单提交或付款地址，已停止在提交前'),{code:'ORDER_REQUEST_BLOCKED'});
        if (!['GET','POST'].includes(form.method)) throw new Error('购物车表单方式无效');
        if (form.method === 'POST') submissionPermit = { url: target, used: false };
        const previousUrl=page.url();
        try { if(submissionPermit)await sendPermittedRequest(button,submissionPermit);else await button.click();if(page.url()===previousUrl)await page.waitForTimeout(300);else await page.waitForLoadState('domcontentloaded'); await ensure(); }
        finally { submissionPermit = null; }
        note('购物车', key); return true;
      },
      login: async (usernameSelector, passwordSelector, buttonSelector) => {
        beforeOrder();
        if(loginCheck)throw new Error('请在监控的下单账户区重新登录，不在下单时切换账户');
        if (!task.credentials?.username || !task.credentials?.password) throw new Error('网站需要登录，请在任务中保存该网站账号');
        const userField = await one(usernameSelector), passwordField = await one(passwordSelector), button = await one(buttonSelector);
        if (await passwordField.getAttribute('type') !== 'password' || buttonSelector === task.program?.checkout?.submitSelector) throw new Error('登录表单无效');
        if (!await passwordField.evaluate((el, key) => !!el.form && !!el.form.querySelector(key), selector(buttonSelector))) throw new Error('登录按钮必须属于密码表单');
        await userField.fill(task.credentials.username); await passwordField.fill(task.credentials.password);
        mutationPermit = true;
        try { await button.click(); await page.waitForTimeout(400); await ensure(); }
        finally { mutationPermit = false; }
        note('登录', '使用已保存的网站账号'); return true;
      },
      wait: async key => { await page.locator(selector(key)).waitFor({ state: 'visible' }); await ensure(); return true; },
      submit: async liveChecks => {
        if(liveChecks){for(const key of ['submitSelector','productSelector','quantitySelector','totalSelector','currencySelector','confirmationSelector'])selector(liveChecks[key]);checkout={...liveChecks};}
        if (committed) throw new Error('同一任务不得重复提交');
        const checked = await review();
        committed = true;
        const button = await one(checkout.submitSelector);
        if (/pay\s*(?:now|invoice)|支付|付款|扣款/i.test(await actionText(button))) throw new Error('下单和付款需要分步核对，已停在提交前');
        const form=await button.evaluate(inspectOrderForm,{kind:'submit',selector:checkout.quantitySelector});
        if (!form || form.method !== 'POST' || form.encoding!=='application/x-www-form-urlencoded' || form.payment) throw new Error('订单表单无法验证或包含自动付款设置，已停止');
        const target=sameOrigin(form.url).split('#')[0];
        if(orderRequestKind(target)==='payment')throw new Error('订单表单指向付款地址，已停止在提交前');
        if(form.quantity&&form.quantity.value!==String(task.quantity))throw new Error('订单表单的数量与已核对的数量不符，已停止');
        const beforeConfirmation=checkout.semantic?confirmationEvidence(currentObservation,'order'):null;
        if(!checkout.semantic&&await page.locator(selector(checkout.confirmationSelector)).isVisible())throw Object.assign(new Error('订单确认元素在提交前已经存在，无法验证新订单成功状态'),{code:'ORDER_CONFIRMATION_UNVERIFIED'});
        await verifyAffiliate(form);
        const choice=task.executionMode==='pay'&&checked.total>0?await bindPaymentChoice(button):null;
        if(task.executionMode==='pay'&&checked.total>0&&paymentIntent.kind==='website'&&!choice)throw Object.assign(new Error('请先在真实结算页面选择并试跑网站付款方式：'+paymentIntent.name),{code:'ORDER_PAYMENT_UNVERIFIED'});
        if (task.executionMode === 'prepare' || task.dryRun) { if(checkout.semantic)await captureEvidence('review');note('核对', '已到提交前，未创建订单'); receipt = {status:'prepared',review:checked,url:clean(page.url()),affiliate:affiliateProof,paymentMethod:choice?{...choice,url:undefined}:null,paymentVerification:task.executionMode==='pay'?(checked.total===0?'not_required_zero_total':choice?'verified':'invoice_only'):null}; return receipt; }
        let submittedCoupon=null;
        if(task.couponCode&&couponChecks){const field=page.locator(selector(couponChecks.inputSelector));if(await field.count()>1)throw couponError('优惠码输入不唯一');if(await field.count()===1)submittedCoupon=await field.evaluate((el,key)=>el.form===document.querySelector(key)?.form&&el.name&&!el.disabled?{name:el.name,value:String(el.value)}:null,checkout.submitSelector);if(submittedCoupon&&submittedCoupon.value!==task.couponCode)throw couponError('提交表单中的优惠码发生变化，已停止');}
        if(checkout.semantic)await captureEvidence('before_submit');
        await onBeforeSubmit({...checked,affiliate:affiliateProof});
        submissionStarted = true;
        submissionPermit = { url:target, used:false,quantity:form.quantity,...(submittedCoupon?{coupon:submittedCoupon}:{}),...(choice?{methodField:choice.field,methodValue:choice.value}:{}) };
        note('提交', '正在提交一次订单');
        const permit = submissionPermit;
        try { await sendPermittedRequest(button,permit); }
        finally { submissionPermit = null; }
        if (!permit.used) throw new Error(blockedRequest || '网站没有提交已核对的订单请求');
        const semanticConfirmation=checkout.semantic?await waitSemanticConfirmation('order',beforeConfirmation):null;
        if(!checkout.semantic)await page.locator(selector(checkout.confirmationSelector)).waitFor({ state: 'visible' });
        await ensure(); orderPage = page.url();
        receipt = { status: 'ordered', review: checked, confirmation: clean(semanticConfirmation?.text||await page.locator(checkout.confirmationSelector).innerText()),...(semanticConfirmation?{orderId:semanticConfirmation.orderId}:{}), url: clean(orderPage), affiliate:affiliateProof };
        if(task.executionMode==='pay'&&checked.total===0){receipt={...receipt,status:'awaiting_payment',paymentPending:{reason:'zero_total',message:'优惠后金额为 0，已提交订单且无需发起付款；请在商家页面确认免费订单状态'}};note('零金额订单',receipt.paymentPending.message);}
        return receipt;
      },
      invoice: async key => {
        if(paymentStarted||receipt?.status!=='ordered'||page.url()!==orderPage)throw new Error('只能打开本次新订单页面明确关联的账单');
        const link=await one(key),observed=await link.evaluate(el=>({tag:el.tagName,href:el.getAttribute('href'),text:el.innerText}));
        if(observed.tag!=='A'||!observed.href||!/invoice|bill|账单|发票/i.test(observed.href+' '+observed.text))throw new Error('所选链接不是订单账单');
        const href=sameOrigin(new URL(observed.href,orderPage).href),target=new URL(href),invoiceId=target.searchParams.get('invoiceid')||target.searchParams.get('id');
        if(!/^[\w-]{1,100}$/.test(invoiceId||'')||!/invoice|bill|账单|发票/i.test(target.pathname))throw new Error('无法绑定新订单账单号');
        const links=await page.locator('a[href]').evaluateAll(nodes=>nodes.filter(el=>el.getClientRects().length&&/invoice|bill|账单|发票/i.test(el.getAttribute('href')+' '+el.innerText)).map(el=>new URL(el.href)).filter(url=>url.origin===location.origin&&/invoice|bill|账单|发票/i.test(url.pathname)&&(url.searchParams.has('invoiceid')||url.searchParams.has('id'))).map(url=>url.href));
        if(new Set(links).size!==1||links[0]!==href)throw new Error('新订单页面存在多个账单，无法确定应付款的账单');
        await navigate(href,{waitUntil:'domcontentloaded'});await ensure();
        if(page.url()!==href)throw new Error('账单地址发生变化，已停止');
        orderPage=page.url();receipt={...receipt,invoiceId,url:clean(orderPage)};note('打开账单','已打开本次订单关联的账单 '+invoiceId);return receipt;
      },
      pay: async checks => {
        if (task.executionMode !== 'pay') throw new Error('该任务没有允许自动付款');
        if (task.dryRun) { if (receipt?.status !== 'prepared') throw new Error('付款前必须核对订单'); return receipt; }
        if (paymentStarted || receipt?.status !== 'ordered' || page.url() !== orderPage) throw new Error('只能支付本次刚创建的订单一次');
        if (!checks || typeof checks !== 'object') throw new Error('缺少付款核对字段');
        for (const key of ['paySelector','invoiceSelector','totalSelector','currencySelector','confirmationSelector']) selector(checks[key]);
        const invoiceField=await one(checks.invoiceSelector),invoice=await invoiceField.evaluate(el=>({id:String(el.value||'').trim(),name:el.name,form:!!el.form}));
        const invoiceFromUrl=new URL(orderPage).searchParams.get('invoiceid')||new URL(orderPage).searchParams.get('id')||receipt.invoiceId;
        if(!invoice.form||!invoice.name||!/^[\w-]{1,100}$/.test(invoice.id)||(invoiceFromUrl?invoice.id!==invoiceFromUrl:!/(?:invoice|invid|orderid|order_id)/i.test(invoice.name||'')||!String(receipt.confirmation||'').includes(invoice.id)))throw new Error('无法确认当前订单的付款账单号，已停止');
        receipt={...receipt,invoiceId:invoice.id};
        const total=parseOrderTotal(await (await one(checks.totalSelector)).innerText());await verifyCurrency(checks.currencySelector);
        if(total>task.maxTotal||Math.round(total*100)!==Math.round(receipt.review.total*100))throw new Error('付款金额与已核对的订单总价不符，已停止');
        const currency=receipt.review.currency;
        const defer=(reason,message,extra={})=>{note('保留待付款订单',message);receipt={...receipt,status:'awaiting_payment',paymentPending:{reason,message,...extra}};return receipt;};
        if(checks.paymentMethod)await choosePayment(checks.paymentMethod);
        const button=await one(checks.paySelector),form=await button.evaluate(inspectOrderForm,{kind:'pay',selector:checks.invoiceSelector});
        if(!form||form.method!=='POST'||form.encoding!=='application/x-www-form-urlencoded'||!form.invoiceMatches||form.cardData)throw new Error('付款表单无法与本次账单核对，已停止');
        const target=sameOrigin(form.url).split('#')[0];
        if(orderRequestKind(target)==='submission')throw new Error('付款表单指向创建订单地址，已停止在付款前');
        let choice=await bindPaymentChoice(button);
        const selectedMethods=form.controls.filter(control=>paymentBrand(control.label)||paymentMatchesIntent(control.label,paymentIntent));
        if(selectedMethods.some(control=>!paymentMatchesIntent(control.label,paymentIntent)))return defer('method_unverified','当前网页选中的付款方式与预选方式不符，已保留账单');
        if(!choice&&selectedMethods.length===1){const selected=selectedMethods[0];choice={kind:paymentIntent.kind,name:paymentIntent.name,label:selected.label,field:selected.name,value:selected.value,control:'selected'};}
        const methodText=await actionText(button);
        if(!choice&&paymentIntent.kind==='balance'&&paymentMatchesIntent(methodText,paymentIntent)&&!form.hiddenMethods.some(field=>field.value))choice={kind:'balance',name:paymentIntent.name,label:methodText,control:'button'};
        if(!choice||!paymentMatchesIntent(choice.label,paymentIntent)||task.verifiedPaymentMethod&&!samePaymentChoice(task.verifiedPaymentMethod,choice))return defer('method_unverified','无法从网页确认预选付款方式，已保留账单，请在网站付款');
        if(form.hiddenMethods.some(field=>field.value&&(field.name!==choice.field||field.value!==choice.value)))return defer('method_unverified','付款表单存在未核实的其他支付设置，已保留账单');
        let balance;
        if(paymentIntent.kind==='balance'){
          if(!checks.balanceSelector||!checks.balanceCurrencySelector)return defer('balance_unverified','无法核实账户余额，已保留待付款订单');
          try{
            balance=parseOrderTotal(await fieldValue(await one(checks.balanceSelector)));
            const balanceCurrencies=String(await fieldValue(await one(checks.balanceCurrencySelector))).toUpperCase().match(/\b[A-Z]{3}\b/g);
            if(balanceCurrencies?.length!==1||balanceCurrencies[0]!==currency)return defer('balance_unverified','账户余额币种无法与本次账单核对，已保留订单');
          }catch{return defer('balance_unverified','账户余额无法读取，已保留待付款订单');}
          if(Math.round(balance*100)<Math.round(total*100))return defer('insufficient_balance','余额不足，已保留待付款订单；不会改用其他付款方式',{balance,total,currency,shortfall:Math.round((total-balance)*100)/100});
        }
        const finalTotal=parseOrderTotal(await (await one(checks.totalSelector)).innerText());await verifyCurrency(checks.currencySelector);
        if(finalTotal>task.maxTotal||Math.round(finalTotal*100)!==Math.round(total*100))throw new Error('选择付款方式后账单金额发生变化，已停止付款');
        const checked={invoiceId:invoice.id,total,currency,paymentMethod:{...choice,url:undefined},...(balance===undefined?{}:{balance})};
        const beforeConfirmation=checks.semantic?confirmationEvidence(currentObservation,'payment'):null;
        if(!checks.semantic&&await page.locator(checks.confirmationSelector).isVisible())throw new Error('付款确认元素在付款前已经存在，无法验证成功状态');
        if(checks.semantic)await captureEvidence('before_payment');
        await onBeforePayment(checked);paymentStarted=true;gatewayHandoff=null;
        paymentPermit={url:target,invoiceField:invoice.name,invoiceId:invoice.id,used:false,...(choice.field?{methodField:choice.field,methodValue:choice.value}:{})};
        const permit=paymentPermit;note('付款','正在支付账单 '+invoice.id+' · '+choice.label+' · '+currency+' '+total);
        try{await sendPermittedRequest(button,permit);}catch(error){if(!gatewayHandoff)throw error;}finally{paymentPermit=null;}
        if(!permit.used)throw new Error(blockedRequest||'网站没有提交已核对的付款请求');
        receipt={...receipt,payment:checked,paymentMethod:checked.paymentMethod};
        if(gatewayHandoff)return defer('external_payment','已进入 '+choice.label+' 收银台，需要扫码或验证后完成付款',{cashierUrl:gatewayHandoff.url,cashierSource:gatewayHandoff.source});
        await ensure();
        if(checks.pendingSelector){const pending=await one(checks.pendingSelector);if(await pending.isVisible()&&/scan|qr|verify|authentication|扫码|二维码|驗證|验证|認証/i.test(await pending.innerText()))return defer('payment_verification','付款已发起，请在网站收银台完成扫码或验证',{cashierUrl:page.url(),cashierSource:'merchant_page'});}
        const semanticConfirmation=checks.semantic?await waitSemanticConfirmation('payment',beforeConfirmation):null;
        if(!checks.semantic)await page.locator(checks.confirmationSelector).waitFor({state:'visible'});await ensure();
        const confirmation=semanticConfirmation?.text||await page.locator(checks.confirmationSelector).innerText();
        if(/unpaid|not\s+paid|unsuccessful|pending|failed|declined|未支付|未付款|失败|失敗|impayé|non\s+payé|unbezahlt|nicht\s+bezahlt|no\s+pagado|non\s+pagato/i.test(confirmation)||!/\bpaid\b|\bpayment\s+(?:successful|complete)\b|\bsuccess\b|已支付|支付成功|已付款|payée?|bezahlt|pagad[oa]|pagat[oa]|оплачен|支払済|支払い完了|결제\s*완료/i.test(confirmation))throw new Error('网站尚未确认付款成功');
        receipt={...receipt,status:'paid',payment:checked,confirmation:clean(confirmation),url:clean(page.url())};return receipt;
      }

    };
    // Keep a background timer separate from a write caused by a preparation
    // action. Reads/waits do not grant mutation permission or poison login.
    // Waiting for a field to become editable does not make unrelated timers
    // foreground actions. Unknown writes stay blocked without poisoning reads.
    for(const key of ['click','cart','login']){
      const action=methods[key];methods[key]=async(...args)=>{orderInteraction++;try{return await action(...args);}finally{orderInteraction--;}};
    }
    const remote = {
      view: async () => {
        await ensure(true);
        const login=await page.evaluate(inspectOrderLogin,loginProof||loginCheck?.proof);
        const result=await page.evaluate(({next,loggedIn})=>{const fields=loggedIn?[]:[...document.querySelectorAll('input')].filter(el=>el.getClientRects().length&&!el.disabled&&!/search|搜索|查询/i.test(el.name+' '+el.placeholder)&&['text','email','password','tel','number','checkbox'].includes(el.type)&&(el.closest('[data-order-login-form]')||!el.form&&/username|email|password|otp|captcha|verification|验证码/i.test(el.name+' '+el.autocomplete+' '+el.getAttribute('aria-label')))).slice(0,20).map(el=>{if(!el.dataset.orderLoginField)el.dataset.orderLoginField='field-'+(next++);return{key:el.dataset.orderLoginField,type:el.type,label:(el.labels?.[0]?.innerText||el.getAttribute('aria-label')||el.placeholder||el.name||el.type).slice(0,100)};});return {fields,next};},{next:remoteFieldCounter,loggedIn:login.status==='authenticated'});
        remoteFieldCounter=result.next;const fields=result.fields;
        return {url:clean(page.url()),loginStatus:login.status,width:1280,height:900,fields,image:'data:image/png;base64,'+(await page.screenshot()).toString('base64')};
      },
      act: async input => {
        if(!loginOnly)throw new Error('此浏览器不是登录会话');
        await ensure(true);
        if(input.type==='fill'){
          if(!/^field-\d+$/.test(input.key)||typeof input.value!=='string'||input.value.length>512)throw new Error('登录输入无效');
          const field=page.locator('[data-order-login-field="'+input.key+'"]');if(await field.count()!==1)throw new Error('登录表单已变化，请刷新登录页面');
          if(input.value)loginValues.push(input.value);await field.fill(input.value);
        }else if(input.type==='scroll'){await page.mouse.wheel(0,Math.max(-900,Math.min(900,Number(input.delta)||0)));}
        else if(input.type==='click'){
          const x=Number(input.x),y=Number(input.y);if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>1280||y<0||y>900)throw new Error('登录点击位置无效');
          const target=await page.evaluate(({x,y})=>{const node=document.elementFromPoint(x,y)?.closest('a,button,input,label');if(!node)return null;return{text:node.innerText||node.value||'',href:node.getAttribute('href')||'',action:node.form?(node.hasAttribute('formaction')?node.formAction:node.form.action):'',loginForm:node.form?.hasAttribute('data-order-login-form'),fields:node.form?[...node.form.elements].map(el=>el.name||el.id).join(' '):''};},{x,y});
          const financialTarget=target&&[target.href,target.action].filter(Boolean).some(value=>isOrderAccountAction(new URL(value,page.url()).href));
          if(target&&(financialTarget||/cardnumber|cvv|cvc/i.test(target.fields)||!target.loginForm&&(/\b(?:pay|checkout|cart|orders?|register|signup)\b|购买|下单|付款|支付|注册/i.test(target.text)||/billing|quantity/i.test(target.fields))))throw new Error('登录窗口只用于登录，商品和付款请使用下单配置');
          await page.mouse.click(x,y);
        }else if(input.type==='check'){
          if(!/^field-\d+$/.test(input.key))throw new Error('登录选项无效');await page.locator('[data-order-login-field="'+input.key+'"]').setChecked(Boolean(input.checked));
        }else if(input.type==='refresh'){await browserAuthenticatedNavigation(()=>page.reload({waitUntil:'domcontentloaded'}),authentication,Boolean(proxy));}else throw new Error('不支持的登录操作');
        await page.waitForTimeout(250);await ensure(true);return remote.view();
      },
      finish: async () => {
        if(task.checkUrl&&page.url()!==sameOrigin(task.checkUrl))await navigate(sameOrigin(task.checkUrl),{waitUntil:'domcontentloaded'});
        const check=await verifyLogin();
        const state=await browserOperation(()=>context.storageState({indexedDB:true}),{signal,timeoutMs:15000,code:'ORDER_LOGIN_SAVE_TIMEOUT',message:'读取登录存储超时；当前登录窗口保留，请稍后重试'});
        const storage=await readPage(()=>page.evaluate(()=>Object.fromEntries(Object.entries(sessionStorage))));
        if(JSON.stringify([state,storage]).length>1024*1024)throw new Error('网站登录状态过大，无法保存');
        if(check.proof){
          // A public heading must not turn a user-selected marker into proof
          // of authentication. Check absence without this account's storage.
          let anonymous;
          try{
            anonymous=await createOrderBrowser({url:check.url},{proxyUrl,launch,loginOnly:true,accountReadOnly:true,restoringSession:true,loginProof:check.proof,timeoutMs:15000,signal,onTrace});
            if((await anonymous.remote.view()).loginStatus==='authenticated')throw Object.assign(new Error('所选账户标记在未登录时也存在，请选择仅登录后可见的账户信息'),{code:'ORDER_LOGIN_UNVERIFIED'});
          }finally{if(anonymous)await closeOrderBrowser(anonymous);}
        }
        for(let attempt=0;attempt<2;attempt++){
        let restored;
        try{
          restored=await createOrderBrowser({url:check.url,credentials:task.credentials},{proxyUrl,launch,restoringSession:true,timeoutMs:30000,signal,storageState:state,sessionStorageState:storage,loginCheck:check,loginVerificationTimeoutMs,onTrace});
          const restoredState=await browserOperation(()=>restored.accountState(),{signal,timeoutMs:10000,code:'ORDER_BROWSER_TIMEOUT',message:'读取恢复后的会话超时，当前登录窗口保留'});
          return {...restoredState,check:restoredState.check||check,redactions:[...loginValues,...(check.proof?.text?[check.proof.text]:[])],testedAt:new Date().toISOString()};
        }catch(error){
          signal?.throwIfAborted();
          if(!attempt&&['ORDER_BROWSER_CLOSED','ORDER_BROWSER_TIMEOUT'].includes(error.code))continue;
          if(['ORDER_LOGIN_REQUIRED','ORDER_LOGIN_UNVERIFIED'].includes(error.code))throw Object.assign(new Error('当前窗口的会话尚不能在新浏览器恢复，请等待网站完成登录或选择记住登录后再保存；当前窗口会保留'),{code:'ORDER_LOGIN_UNVERIFIED'});
          throw error;
        }finally{if(restored)await closeOrderBrowser(restored);}
        }
      }
    };
    if(loginCheck){await methods.goto(loginCheck.url);await verifyLogin(loginCheck);note('账户验证','已验证事先保存的登录会话');}
    if(!loginOnly)await visitAffiliate();
    if(page.url()!==sameOrigin(task.url)&&!(loginCheck&&sameOrigin(task.url)===sameOrigin(loginCheck.url)))await methods.goto(task.url);
    if(task.productSelection){
      if(sameOrigin(task.productSelection.url)!==sameOrigin(task.url))throw new Error('点选商品的页面已变化');
      const selectedText=task.productSelection.text.replace(/\s+/g,' ').trim();
      if(task.program?.workflow?.version===1){
        const chosen=await one(task.productSelection.selector);
        if((await chosen.innerText()).replace(/\s+/g,' ').trim()!==selectedText)throw new Error('点选商品的区域或内容已变化，请重新点选并试跑');
      }else{
        const visibleText=await readPage(()=>page.evaluate(()=>document.body.innerText));
        if(!visibleText.replace(/\s+/g,' ').includes(selectedText))throw new Error('点选商品的语义内容已变化，请重新点选');
      }
      note('商品点选','已核对用户手动选中的真实网页区域');
    }
    if(storageSeed){await storageSeed.dispose();await readPage(()=>page.evaluate(marker=>sessionStorage.removeItem(marker),seedMarker));}
    verifyingAccount=false;freshProductNavigation=true;
    return { keepAlive:milliseconds=>{if(browserClosing)return false;armWatchdog(milliseconds);return true;}, methods, snapshot, captureEvidence, trace, remote, verifyLogin, dryRun:Boolean(task.dryRun||task.executionMode==='prepare'), productHtml:async()=>{await ensure();return page.content();}, get paymentOptions(){return paymentOptions;}, get submissionStarted() { return submissionStarted; }, get paymentStarted() { return paymentStarted; }, get receipt() { return receipt; }, accountState:async()=>{
      const state=await browserOperation(()=>context.storageState({indexedDB:true}),{signal,timeoutMs:stateTimeoutMs,code:'ORDER_ACCOUNT_STATE_TIMEOUT',message:'读取登录存储超时，原保存会话仍保留',onTimeout:stop});
      const newAffiliateCookies=(affiliateEvidence?.changedCookieNames||[]).filter(name=>!accountBeforeAffiliate.cookies.some(cookie=>cookie.name===name));
      const affiliateNames=new Set([...newAffiliateCookies,affiliateCookie?.name,task.program?.affiliate?.cookieName].filter(Boolean));
      state.cookies=state.cookies.filter(cookie=>!affiliateNames.has(cookie.name));
      for(const cookie of (accountBeforeAffiliate||storageState)?.cookies||[])if(affiliateNames.has(cookie.name))state.cookies.push(cookie);
      let sessionStorage=sessionStorageState||{};
      if(new URL(page.url()).origin===origin){
        try{sessionStorage=await readPage(()=>page.evaluate(()=>Object.fromEntries(Object.entries(window.sessionStorage))));}
        catch(error){
          // Chromium can retain the merchant URL on an opaque error document.
          // Do not discard freshly rotated cookies because that document has
          // no storage access. The next use must still verify authentication.
          if(!/SecurityError:.*sessionStorage[\s\S]*Access is denied/i.test(error.message))throw error;
          note('会话存储保留','错误页面无法读取会话存储，保留原值并保存更新后的 Cookie；下次使用仍须核验登录');
        }
      }
      if(JSON.stringify([state,sessionStorage]).length>1024*1024)throw new Error('登录状态过大');return {state,sessionStorage,...(verifiedLoginCheck?{check:verifiedLoginCheck}:{})};
    }, diagnostics:async()=>{
      const base={url:clean(page.url()),submissionStarted,paymentStarted,blockedRequest:clean(blockedRequest),authentication:{proxyRejected:Boolean(authentication.proxyRejected),websiteRequired:Boolean(authentication.websiteRequired)}};
      try{const info=await browserOperation(()=>page.evaluate(()=>({title:document.title,controls:[...document.querySelectorAll('a,button,input,select,textarea,form')].slice(0,100).map(el=>({tag:el.tagName.toLowerCase(),id:el.id,name:el.getAttribute('name'),type:el.getAttribute('type'),href:el.tagName==='A'?el.getAttribute('href'):undefined,action:el.tagName==='FORM'?el.getAttribute('action'):undefined}))})),{signal,timeoutMs:1500,code:'ORDER_DIAGNOSTIC_TIMEOUT',message:'页面诊断读取超时'});return diagnosticPage({...base,...info});}catch(error){return {...base,unavailable:clean(error.message)};}
    }, close: async () => { clearTimeout(watchdog); signal?.removeEventListener('abort', stop); await stop(); } };
  } catch (error) { clearTimeout(watchdog); signal?.removeEventListener('abort', stop); await closeOrderBrowser({close:stop});signal?.throwIfAborted();error=browserAuthenticationError(error,authentication,Boolean(proxy));if(blockedRequestCode&&!timedOut&&!authentication.proxyRejected&&!authentication.websiteRequired&&!isBrowserClosedError(error))error=blockedError();if(timedOut)throw Object.assign(new Error('浏览器校验登录会话超时，原会话仍保留，请稍后重试'),{code:'ORDER_BROWSER_TIMEOUT'});if(isBrowserClosedError(error))throw Object.assign(new Error('浏览器恢复登录会话时意外关闭，原会话仍保留，请稍后重试'),{code:'ORDER_BROWSER_CLOSED'});throw Object.assign(new Error(clean(error.message)),{code:error.code}); }
}
