import { chromium } from 'playwright-core';
import { isChallengePage } from './source-fetch.js';

const selector = input => { if (typeof input !== 'string' || !input.trim() || input.length > 500) throw new Error('网页元素定位无效'); return input; };
const paymentWords = /pay(?:\s+now|\s+invoice|ment)?|支付|付款|扣款|complete\s+(?:order|purchase)|place\s+order|submit\s+order|确认订单|提交订单|确认购买|立即购买/i;
export function parseOrderTotal(text) {
  const values = String(text).replace(/,(?=\d{3}(?:\D|$))/g, '').match(/-?\d+(?:\.\d{1,2})?/g);
  if (!values || values.length !== 1) throw new Error('无法唯一确认订单总价，请重新生成');
  const value = Number(values[0]);
  if (!Number.isFinite(value) || value < 0) throw new Error('订单总价无效');
  return value;
}
export async function createOrderBrowser(task, { proxyUrl = '', launch = chromium.launch.bind(chromium), timeoutMs = 60_000, signal, storageState, sessionStorageState, loginCheck, loginOnly = false, onBeforeSubmit = async () => {}, onBeforePayment = async () => {} } = {}) {
  if (signal?.aborted) throw new Error('下单操作已停止');
  const origin = new URL(task.url).origin;
  const expectedProduct=task.product||task.verifiedProduct||'',expectedCurrency=task.currency||task.verifiedCurrency||'';
  const affiliateUrl = task.affiliateUrl ? new URL(task.affiliateUrl) : null;
  let checkout = task.program?.checkout, remoteFieldCounter = 0;
  let affiliatePhase = false, affiliateEvidence = null, affiliateProof = null, affiliateCookie = null, affiliateField = null, accountBeforeAffiliate = null;
  const proxy = proxyUrl ? new URL(proxyUrl) : null;
  const browser = await launch({ executablePath: process.env.MONITOR_BROWSER_EXECUTABLE || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(proxy ? { proxy: { server: proxy.origin, username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password), bypass: '' } } : {}) });
  let context, watchdog, mutationPermit = false, committed = false, submissionStarted = false, paymentStarted = false, blockedRequest = '', receipt = null, submissionPermit = null, paymentPermit = null, orderPage = '', freshProductNavigation = false;
  const trace = [],loginValues=[];
  const clean = input => {
    let value = String(input || '');
    for (const secret of [...Object.values(task.credentials || {}), ...loginValues, proxy ? decodeURIComponent(proxy.username) : '', proxy ? decodeURIComponent(proxy.password) : '']) if (secret) value = value.split(String(secret)).join('[已隐藏]');
    return value.replace(/([?&](?:token|key|password|secret)=)[^&\s]*/gi, '$1[已隐藏]').slice(0, 800);
  };
  const sameOrigin = value => { const url = new URL(value, task.url); if (url.origin !== origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('下单程序只能访问配置的商品网站'); return url.href; };
  const stop = () => browser.close().catch(() => {});
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: false, serviceWorkers: 'block', ...(storageState ? {storageState} : {}) });
    if (sessionStorageState) await context.addInitScript(({origin,values})=>{if(location.origin===origin)for(const [key,value]of Object.entries(values))sessionStorage.setItem(key,value);}, {origin,values:sessionStorageState});
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) { await browser.close(); throw new Error('下单操作已停止'); }
    watchdog = setTimeout(() => context.close().catch(() => {}), timeoutMs); watchdog.unref();
    await context.route('**/*', async route => {
      const request = route.request();
      let same = false;
      try { same = new URL(request.url()).origin === origin; } catch {}
      const isTransaction = /(?:[?&](?:a|action)=|\/)(?:complete|completeorder|submitorder|place-order|processcheckout)(?:[&/?]|$)/i.test(request.url());
      const isPayment = /(?:[?&](?:a|action)=|\/)(?:pay|processpayment|capture|charge)(?:[&/?]|$)/i.test(request.url());
      let allowedMutation = (mutationPermit || loginOnly) && !submissionStarted, allowedPayment = false;
      for (const permit of [submissionPermit, paymentPermit]) {
        if (permit && request.method() === 'POST' && request.url().split('#')[0] === permit.url && !permit.used) {
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
          permit.used = true; allowedMutation = true; allowedPayment = permit === paymentPermit;
        }
      }
      const externalAsset = !request.isNavigationRequest() && ['GET','HEAD'].includes(request.method());
      const affiliateRead = affiliatePhase && new URL(request.url()).origin === affiliateUrl.origin && ['GET','HEAD'].includes(request.method());
      if ((!same && !externalAsset && !affiliateRead) || isPayment && !allowedPayment || isTransaction && !allowedMutation || !['GET', 'HEAD'].includes(request.method()) && !allowedMutation) {
        if (same) blockedRequest = '程序尝试了未授权的提交或付款请求';
        await route.abort(); return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(15000);
    context.on('page', extra => { if (extra !== page) extra.close().catch(() => {}); });
    const ensure = async (allowChallenge = loginOnly) => {
      if (signal?.aborted) throw new Error('下单操作已停止');
      sameOrigin(page.url());
      if (blockedRequest) throw new Error(blockedRequest);
      if (!allowChallenge && isChallengePage(await page.content(), {})) throw new Error('目标网站正在要求验证，请更换可用出口或稍后重试');
    };
    const one = async key => { await ensure(); const field = page.locator(selector(key)); if (await field.count() !== 1) throw new Error('网页元素不存在或不唯一：' + key); return field; };
    const note = (action, detail) => { trace.push({ action, detail: clean(detail), at: new Date().toISOString() }); };
    const actionText = field => field.evaluate(el=>el.innerText||el.value||'');
    const fieldValue = field => field.evaluate(el => el.tagName==='SELECT'?[...el.selectedOptions].map(option=>option.textContent).join(' '):'value' in el ? String(el.value) : el.innerText);
    const verifyCurrency = async key => {
      const currencies = String(await fieldValue(await one(key))).toUpperCase().match(/\b[A-Z]{3}\b/g);
      if (currencies?.length !== 1 || currencies[0] !== (expectedCurrency || receipt?.review?.currency)) throw new Error('无法确认订单币种，已停止');
    };
    const beforeOrder = () => { freshProductNavigation=false; if (submissionStarted) throw new Error('订单已提交，不能再修改商品或跳转到其他订单'); };
    const snapshot = async () => {
      await ensure();
      const evidence = await page.evaluate(() => ({ url: location.origin + location.pathname + location.search.replace(/([?&](?:token|key|password|secret)=)[^&]*/gi, '$1[hidden]'), title: document.title,
        text: (document.body.innerText || '').slice(0, 12000),
        elements: [...document.querySelectorAll('a,button,input,select,textarea,form,[id],label')].filter(el => el.getClientRects().length || el.tagName === 'INPUT' && el.type === 'hidden').slice(0, 160).map(el => ({ tag: el.tagName.toLowerCase(), id: el.id, class: el.getAttribute('class'), name: el.getAttribute('name'), type: el.getAttribute('type'), text: (el.tagName === 'INPUT' ? '' : el.textContent || '').trim().slice(0, 120), href: el.tagName === 'A' ? el.getAttribute('href') : undefined, action: el.tagName === 'FORM' ? el.getAttribute('action') : undefined, options: el.tagName === 'SELECT' ? [...el.options].map(o => ({value:o.value,text:o.textContent})).slice(0,30) : undefined })) }));
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
    const verifyLogin = async saved => {
      await ensure(false);
      const marker=await page.evaluate(expected=>{
        document.querySelectorAll('[data-order-account-marker]').forEach(el=>el.removeAttribute('data-order-account-marker'));
        const visible=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden';
        if([...document.querySelectorAll('input[type="password"]')].some(visible))return null;
        const nodes=[...document.querySelectorAll('a,button,input[type="submit"]')].filter(el=>{
          const href=el.getAttribute('href')||'',text=el.innerText||el.value||el.textContent||'';
          if(!/log.?out|sign.?out|退出|注销/i.test(href+' '+text))return false;
          if(href){try{const url=new URL(href,location.href);if(url.origin!==location.origin||!['http:','https:'].includes(url.protocol))return false;if(expected?.href&&url.href!==expected.href)return false;}catch{return false;}}
          return visible(el)||el.tagName==='A'&&/log.?out|sign.?out/i.test(href);
        });
        const node=nodes.find(visible)||nodes[0];if(!node)return null;
        node.setAttribute('data-order-account-marker','true');
        return {loggedInSelector:'[data-order-account-marker="true"]',loggedOutSelector:'input[type="password"]',href:node.getAttribute('href')?new URL(node.getAttribute('href'),location.href).href:null};
      },saved||null);
      if(!marker)throw Object.assign(new Error('尚未确认网站登录，请完成登录或二次认证后再保存；当前窗口会保留'),{code:'ORDER_LOGIN_REQUIRED'});
      return {...marker,url:sameOrigin(page.url())};
    };
    const visitAffiliate = async () => {
      if(!affiliateUrl)return;
      const before = await context.cookies(task.url);accountBeforeAffiliate=await context.storageState({indexedDB:true});
      affiliatePhase=true;
      try {
        const response=await page.goto(affiliateUrl.href,{waitUntil:'domcontentloaded'});
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
    const review = async () => {
      await ensure();
      const checks=checkout;
      const read=async(key,input=false)=>{const field=page.locator(selector(key));if(await field.count()!==1)throw new Error('网页元素不存在或不唯一：'+key);return input?fieldValue(field):field.innerText();};
      const [productText,totalText,quantityText,currencyText]=await Promise.all([read(checks.productSelector),read(checks.totalSelector),read(checks.quantitySelector,true),read(checks.currencySelector,true)]);
      const productName=value=>value.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
      if(!productText.trim()||productText.trim().length>200||!expectedProduct&&!task.dryRun)throw new Error('商品尚未通过试跑核对，请重新生成');
      if(expectedProduct&&productName(productText)!==productName(expectedProduct))throw new Error('订单中的商品与配置不符，已停止');
      const total=parseOrderTotal(totalText),currencies=String(currencyText).toUpperCase().match(/\b[A-Z]{3}\b/g);
      if(currencies?.length!==1||expectedCurrency&&currencies[0]!==expectedCurrency||!expectedCurrency&&!task.dryRun)throw new Error('无法确认订单币种，已停止');
      if(!/^\s*\d+\s*$/.test(quantityText)||Number(quantityText)!==task.quantity)throw new Error('订单数量与配置不符，已停止');
      if(total<=0||total>task.maxTotal)throw new Error('订单总价超过上限，已停止');
      return {product:expectedProduct||productText.trim(),quantity:task.quantity,total,currency:expectedCurrency||currencies[0]};
    };
    const methods = {
      goto: async url => { const fresh=freshProductNavigation,target=sameOrigin(url);beforeOrder();if(!fresh||target!==task.url||page.url()!==target)await page.goto(target, { waitUntil: 'domcontentloaded' }); await ensure(); note('访问', page.url()); return true; },
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
        if (key === task.program?.checkout.submitSelector || paymentWords.test(description.text) || description.submit) throw new Error('提交表单只能通过受控的 login、cart、submit 或 pay 操作');
        const previousUrl=page.url();await field.click();if(page.url()===previousUrl)await page.waitForTimeout(200);else await page.waitForLoadState('domcontentloaded'); await ensure(); note('点击', key); return true;
      },
      cart: async key => {
        beforeOrder();
        const button = await one(key);
        const form = await button.evaluate(el => el.form ? {
          url:el.form.action, method:el.form.method.toUpperCase(), text:el.innerText||el.value||'',
          fields:[...el.form.querySelectorAll('input,select')].map(field=>({name:field.name||field.id,type:field.type})), content:el.form.innerText
        } : null);
        if (!form || key === task.program?.checkout.submitSelector || paymentWords.test(form.text) || !/(?:add.*cart|update.*cart|continue|加入购物车|添加|继续|更新购物车)/i.test(form.text) || /terms|条件|条款|billing\s+address|payment\s+method/i.test(form.content) || form.fields.some(field=>field.type==='password'||/(?:email|address|payment|credit|card|cvv|cvc|firstname|lastname|terms)/i.test(field.name))) throw new Error('无法确认这是商品配置或购物车表单，已停在提交前');
        const target = sameOrigin(form.url).split('#')[0];
        if (!['GET','POST'].includes(form.method)) throw new Error('购物车表单方式无效');
        if (form.method === 'POST') submissionPermit = { url: target, used: false };
        const previousUrl=page.url();
        try { await button.click();if(page.url()===previousUrl)await page.waitForTimeout(300);else await page.waitForLoadState('domcontentloaded'); await ensure(); }
        finally { submissionPermit = null; }
        note('购物车', key); return true;
      },
      login: async (usernameSelector, passwordSelector, buttonSelector) => {
        beforeOrder();
        if(loginCheck)throw new Error('请在监控的下单账户区重新登录，不在下单时切换账户');
        if (!task.credentials?.username || !task.credentials?.password) throw new Error('网站需要登录，请在任务中保存该网站账号');
        const userField = await one(usernameSelector), passwordField = await one(passwordSelector), button = await one(buttonSelector);
        if (await passwordField.getAttribute('type') !== 'password' || buttonSelector === task.program?.checkout.submitSelector) throw new Error('登录表单无效');
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
        const form = await button.evaluate(el => el.form ? { url: el.form.action, method: el.form.method.toUpperCase(), payment: [...el.form.querySelectorAll('input,select')].some(field => /(?:cardnumber|card_number|ccnumber|cvv|cvc|usecredit|applycredit|autopay|savedpayment)/i.test(field.name || field.id) && (field.type === 'checkbox' || field.type === 'radio' ? field.checked : !!field.value)) } : null);
        if (!form || form.method !== 'POST' || form.payment) throw new Error('订单表单无法验证或包含自动付款设置，已停止');
        await verifyAffiliate(form);
        if (task.executionMode === 'prepare' || task.dryRun) { note('核对', '已到提交前，未创建订单'); receipt = {status:'prepared',review:checked,url:clean(page.url()),affiliate:affiliateProof}; return receipt; }
        await onBeforeSubmit({...checked,affiliate:affiliateProof});
        submissionStarted = true;
        submissionPermit = { url: sameOrigin(form.url).split('#')[0], used: false };
        note('提交', '正在提交一次订单');
        const permit = submissionPermit;
        try { await button.click(); }
        finally { submissionPermit = null; }
        if (!permit.used) throw new Error(blockedRequest || '网站没有提交已核对的订单请求');
        await page.locator(selector(checkout.confirmationSelector)).waitFor({ state: 'visible' });
        await ensure(); orderPage = page.url();
        receipt = { status: 'ordered', review: checked, confirmation: clean(await page.locator(checkout.confirmationSelector).innerText()), url: clean(orderPage), affiliate:affiliateProof };
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
        await page.goto(href,{waitUntil:'domcontentloaded'});await ensure();
        if(page.url()!==href)throw new Error('账单地址发生变化，已停止');
        orderPage=page.url();receipt={...receipt,invoiceId,url:clean(orderPage)};note('打开账单','已打开本次订单关联的账单 '+invoiceId);return receipt;
      },
      pay: async checks => {
        if (task.executionMode !== 'pay') throw new Error('该任务没有允许自动付款');
        if (task.dryRun) { if (receipt?.status !== 'prepared') throw new Error('付款前必须核对订单'); return receipt; }
        if (paymentStarted || receipt?.status !== 'ordered' || page.url() !== orderPage) throw new Error('只能支付本次刚创建的订单一次');
        if (!checks || typeof checks !== 'object') throw new Error('缺少付款核对字段');
        for (const key of ['paySelector','invoiceSelector','totalSelector','currencySelector','confirmationSelector']) selector(checks[key]);
        const button = await one(checks.paySelector), invoiceField = await one(checks.invoiceSelector);
        const invoice = await invoiceField.evaluate(el => ({ id: String(el.value || '').trim(), name: el.name, form: !!el.form }));
        if (!invoice.form || !/(?:invoice|invid|orderid|order_id)/i.test(invoice.name || '') || !/^[\w-]{1,100}$/.test(invoice.id)) throw new Error('无法确认当前订单的付款账单号，已停止');
        const form = await button.evaluate((el, key) => el.form ? { url: el.form.action, method: el.form.method.toUpperCase(), encoding: el.form.enctype, invoiceMatches: el.form.contains(document.querySelector(key)), paymentMethods: [...el.form.querySelectorAll('select,input[type=radio]:checked,input[type=hidden]')].filter(field=>/paymentmethod|payment_method|gateway|savedpayment|autopay/i.test(field.name||field.id)).map(field=>field.tagName==='SELECT'?[...field.selectedOptions].map(option=>option.value+' '+option.textContent).join(' '):field.value), balanceMethod: [...el.form.querySelectorAll('select,input[type=radio]:checked')].map(field=>field.tagName==='SELECT'?[...field.selectedOptions].map(option=>option.textContent).join(' '):field.value).join(' '), cardData: [...el.form.querySelectorAll('input')].some(field => /(?:cardnumber|card_number|ccnumber|cvv|cvc)/i.test(field.name || field.id) && !!field.value) } : null, checks.invoiceSelector);
        if (!form || form.method !== 'POST' || form.encoding !== 'application/x-www-form-urlencoded' || !form.invoiceMatches || form.cardData || !/pay|apply\s+credit|支付|付款|使用余额/i.test(await actionText(button))) throw new Error('付款表单无法与本次账单核对，已停止');
        const invoiceFromUrl = new URL(orderPage).searchParams.get('invoiceid') || new URL(orderPage).searchParams.get('id');
        if (invoiceFromUrl && invoiceFromUrl !== invoice.id) throw new Error('付款账单号与当前订单不符，已停止');
        receipt = { ...receipt, invoiceId: invoice.id };
        const total = parseOrderTotal(await (await one(checks.totalSelector)).innerText());
        await verifyCurrency(checks.currencySelector);
        if (total > task.maxTotal || Math.round(total * 100) !== Math.round(receipt.review.total * 100)) throw new Error('付款金额与已核对的订单总价不符，已停止');
        const currency=receipt.review.currency;
        const defer=(reason,message,extra={})=>{note('保留待付款订单',message);receipt={...receipt,status:'awaiting_payment',url:clean(page.url()),paymentPending:{reason,message,...extra}};return receipt;};
        const methodText=await actionText(button);
        const balanceWords=/account\s*(?:balance|credit)|balance|余额|账户信用额|账户余额|apply\s+credit/i;
        if(form.paymentMethods.some(method=>method&&!balanceWords.test(method)&&!/^credit$/i.test(method.trim()))||/credit\s*card|银行卡|信用卡/i.test(form.balanceMethod)||!balanceWords.test(methodText)&&!balanceWords.test(form.balanceMethod)&&!/^credit$/i.test(form.balanceMethod.trim()))return defer('balance_unverified','无法确认使用账户余额，已保留订单，请在网站付款');
        if(!checks.balanceSelector||!checks.balanceCurrencySelector)return defer('balance_unverified','无法核实账户余额，已保留待付款订单');
        let balance;
        try{
          const balanceField=await one(checks.balanceSelector);balance=parseOrderTotal(await fieldValue(balanceField));
          const balanceCurrencies=String(await fieldValue(await one(checks.balanceCurrencySelector))).toUpperCase().match(/\b[A-Z]{3}\b/g);
          if(balanceCurrencies?.length!==1||balanceCurrencies[0]!==currency)return defer('balance_unverified','账户余额币种无法与本次账单核对，已保留订单');
        }catch(error){return defer('balance_unverified','账户余额无法读取，已保留待付款订单');}
        if(Math.round(balance*100)<Math.round(total*100))return defer('insufficient_balance','余额不足，已保留待付款订单；不会改用其他付款方式',{balance,total,currency,shortfall:Math.round((total-balance)*100)/100});
        const checked = { invoiceId: invoice.id, total, currency, balance };

        receipt = { ...receipt, invoiceId: invoice.id };
        if (await page.locator(checks.confirmationSelector).isVisible()) throw new Error('付款确认元素在付款前已经存在，无法验证成功状态');
        await onBeforePayment(checked); paymentStarted = true;
        paymentPermit = { url: sameOrigin(form.url).split('#')[0], invoiceField: invoice.name, invoiceId: invoice.id, used: false };
        note('付款', '正在支付账单 ' + invoice.id + ' · ' + currency + ' ' + total);
        const permit = paymentPermit;
        try { await button.click(); }
        finally { paymentPermit = null; }
        if (!permit.used) throw new Error('网站没有提交已核对的付款请求');
        await page.locator(checks.confirmationSelector).waitFor({ state: 'visible' }); await ensure();
        const confirmation = await page.locator(checks.confirmationSelector).innerText();
        if (/unpaid|未支付|未付款/i.test(confirmation) || !/paid|payment\s+(?:successful|complete)|success|已支付|支付成功|已付款/i.test(confirmation)) throw new Error('网站尚未确认付款成功');
        receipt = { ...receipt, status: 'paid', payment: checked, confirmation: clean(await page.locator(checks.confirmationSelector).innerText()), url: clean(page.url()) };
        return receipt;
      }
    };
    const remote = {
      view: async () => {
        await ensure(true);
        const result=await page.evaluate(next=>{const visible=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden';const loggedIn=[...document.querySelectorAll('a,button')].some(el=>/log.?out|sign.?out|退出|注销/i.test((el.getAttribute('href')||'')+' '+el.textContent))&&![...document.querySelectorAll('input[type=password]')].some(visible);const fields=loggedIn?[]:[...document.querySelectorAll('input')].filter(el=>el.getClientRects().length&&!el.disabled&&!/search|搜索|查询/i.test(el.name+' '+el.placeholder)&&['text','email','password','tel','number','checkbox'].includes(el.type)).slice(0,20).map(el=>{if(!el.dataset.orderLoginField)el.dataset.orderLoginField='field-'+(next++);return{key:el.dataset.orderLoginField,type:el.type,label:(el.labels?.[0]?.innerText||el.getAttribute('aria-label')||el.placeholder||el.name||el.type).slice(0,100)};});return {fields,next};},remoteFieldCounter);
        remoteFieldCounter=result.next;const fields=result.fields;
        return {url:clean(page.url()),width:1280,height:900,fields,image:'data:image/png;base64,'+(await page.screenshot()).toString('base64')};
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
          const target=await page.evaluate(({x,y})=>{const node=document.elementFromPoint(x,y)?.closest('a,button,input,label');if(!node)return null;return{text:node.innerText||node.value||'',href:node.getAttribute('href')||'',action:node.form?.action||'',fields:node.form?[...node.form.elements].map(el=>el.name||el.id).join(' '):''};},{x,y});
          if(target && (/pay|checkout|cart|order|register|signup|购买|下单|付款|支付|注册/i.test(target.text+' '+target.href+' '+target.action)||/cardnumber|cvv|cvc|billing|quantity/i.test(target.fields)))throw new Error('登录窗口只用于登录，商品和付款请使用下单配置');
          await page.mouse.click(x,y);
        }else if(input.type==='check'){
          if(!/^field-\d+$/.test(input.key))throw new Error('登录选项无效');await page.locator('[data-order-login-field="'+input.key+'"]').setChecked(Boolean(input.checked));
        }else if(input.type==='refresh'){await page.reload({waitUntil:'domcontentloaded'});}else throw new Error('不支持的登录操作');
        await page.waitForTimeout(250);await ensure(true);return remote.view();
      },
      finish: async () => {
        const check=await verifyLogin();
        const state=await context.storageState({indexedDB:true});
        const storage=await page.evaluate(()=>Object.fromEntries(Object.entries(sessionStorage)));
        if(JSON.stringify([state,storage]).length>1024*1024)throw new Error('网站登录状态过大，无法保存');
        return {state,sessionStorage:storage,check,redactions:loginValues,testedAt:new Date().toISOString()};
      }
    };
    if(loginCheck){await methods.goto(loginCheck.url);await verifyLogin(loginCheck);note('账户验证','已验证事先保存的登录会话');}
    if(!loginOnly)await visitAffiliate();
    if(page.url()!==sameOrigin(task.url))await methods.goto(task.url);
    if(task.productSelection){
      if(sameOrigin(task.productSelection.url)!==sameOrigin(task.url))throw new Error('点选商品的页面已变化');
      const chosen=await one(task.productSelection.selector);const observed=(await chosen.innerText()).replace(/\s+/g,' ').trim();
      if(observed!==task.productSelection.text.replace(/\s+/g,' ').trim())throw new Error('点选商品的区域或内容已变化，请重新点选并试跑');
      note('商品点选','已核对用户手动选中的真实网页区域');
    }
    freshProductNavigation=true;
    return { methods, snapshot, trace, remote, verifyLogin, productHtml:async()=>{await ensure();return page.content();}, get submissionStarted() { return submissionStarted; }, get paymentStarted() { return paymentStarted; }, get receipt() { return receipt; }, accountState:async()=>{
      const state=await context.storageState({indexedDB:true});
      const newAffiliateCookies=(affiliateEvidence?.changedCookieNames||[]).filter(name=>!accountBeforeAffiliate.cookies.some(cookie=>cookie.name===name));
      const affiliateNames=new Set([...newAffiliateCookies,affiliateCookie?.name,task.program?.affiliate?.cookieName].filter(Boolean));
      state.cookies=state.cookies.filter(cookie=>!affiliateNames.has(cookie.name));
      for(const cookie of (accountBeforeAffiliate||storageState)?.cookies||[])if(affiliateNames.has(cookie.name))state.cookies.push(cookie);
      let sessionStorage=sessionStorageState||{};
      try{if(new URL(page.url()).origin===origin)sessionStorage=await page.evaluate(()=>Object.fromEntries(Object.entries(window.sessionStorage)));}catch{};
      if(JSON.stringify([state,sessionStorage]).length>1024*1024)throw new Error('登录状态过大');return {state,sessionStorage};
    }, close: async () => { clearTimeout(watchdog); signal?.removeEventListener('abort', stop); await browser.close(); } };
  } catch (error) { clearTimeout(watchdog); signal?.removeEventListener('abort', stop); await browser.close().catch(() => {}); throw Object.assign(new Error(clean(error.message)),{code:error.code}); }
}
