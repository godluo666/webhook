import { chromium } from 'playwright-core';
import { isChallengePage } from './source-fetch.js';

const selector = input => { if (typeof input !== 'string' || !input.trim() || input.length > 500) throw new Error('网页元素定位无效'); return input; };
const paymentWords = /pay(?:\s+now|\s+invoice|ment)?|支付|付款|扣款|complete\s+(?:order|purchase)|place\s+order|submit\s+order|确认订单|提交订单|确认购买|立即购买/i;
export function parseOrderTotal(text) {
  const values = String(text).replace(/,(?=\d{3}(?:\D|$))/g, '').match(/\d+(?:\.\d{1,2})?/g);
  if (!values || values.length !== 1) throw new Error('无法唯一确认订单总价，请重新生成');
  const value = Number(values[0]);
  if (!Number.isFinite(value) || value < 0) throw new Error('订单总价无效');
  return value;
}
export async function createOrderBrowser(task, { proxyUrl = '', launch = chromium.launch.bind(chromium), timeoutMs = 60_000, signal, onBeforeSubmit = async () => {}, onBeforePayment = async () => {} } = {}) {
  if (signal?.aborted) throw new Error('下单操作已停止');
  const origin = new URL(task.url).origin;
  const proxy = proxyUrl ? new URL(proxyUrl) : null;
  const browser = await launch({ executablePath: process.env.MONITOR_BROWSER_EXECUTABLE || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(proxy ? { proxy: { server: proxy.origin, username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password), bypass: '' } } : {}) });
  let context, watchdog, mutationPermit = false, committed = false, submissionStarted = false, paymentStarted = false, blockedRequest = '', receipt = null, submissionPermit = null, paymentPermit = null, orderPage = '';
  const trace = [];
  const clean = input => {
    let value = String(input || '');
    for (const secret of [...Object.values(task.credentials || {}), proxy ? decodeURIComponent(proxy.username) : '', proxy ? decodeURIComponent(proxy.password) : '']) if (secret) value = value.split(String(secret)).join('[已隐藏]');
    return value.replace(/([?&](?:token|key|password|secret)=)[^&\s]*/gi, '$1[已隐藏]').slice(0, 800);
  };
  const sameOrigin = value => { const url = new URL(value, task.url); if (url.origin !== origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('下单程序只能访问配置的商品网站'); return url.href; };
  const stop = () => browser.close().catch(() => {});
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: false, serviceWorkers: 'block' });
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) { await browser.close(); throw new Error('下单操作已停止'); }
    watchdog = setTimeout(() => context.close().catch(() => {}), timeoutMs); watchdog.unref();
    await context.route('**/*', async route => {
      const request = route.request();
      let same = false;
      try { same = new URL(request.url()).origin === origin; } catch {}
      const isTransaction = /(?:[?&](?:a|action)=|\/)(?:complete|completeorder|submitorder|place-order|processcheckout)(?:[&/?]|$)/i.test(request.url());
      const isPayment = /(?:[?&](?:a|action)=|\/)(?:pay|processpayment|capture|charge)(?:[&/?]|$)/i.test(request.url());
      let allowedMutation = mutationPermit && !submissionStarted, allowedPayment = false;
      for (const permit of [submissionPermit, paymentPermit]) {
        if (permit && request.method() === 'POST' && request.url().split('#')[0] === permit.url && !permit.used) {
          // Payment approval also binds the actual HTTP body to this invoice.
          if (permit === paymentPermit && JSON.stringify(new URLSearchParams(request.postData() || '').getAll(permit.invoiceField)) !== JSON.stringify([permit.invoiceId])) continue;
          permit.used = true; allowedMutation = true; allowedPayment = permit === paymentPermit;
        }
      }
      if (!same || isPayment && !allowedPayment || isTransaction && !allowedMutation || !['GET', 'HEAD'].includes(request.method()) && !allowedMutation) {
        if (same) blockedRequest = '程序尝试了未授权的提交或付款请求';
        await route.abort(); return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(15000);
    context.on('page', extra => { if (extra !== page) extra.close().catch(() => {}); });
    const ensure = async () => {
      if (signal?.aborted) throw new Error('下单操作已停止');
      sameOrigin(page.url());
      if (blockedRequest) throw new Error(blockedRequest);
      if (isChallengePage(await page.content(), {})) throw new Error('目标网站正在要求验证，请更换可用出口或稍后重试');
    };
    const one = async key => { await ensure(); const field = page.locator(selector(key)); if (await field.count() !== 1) throw new Error('网页元素不存在或不唯一：' + key); return field; };
    const note = (action, detail) => { trace.push({ action, detail: clean(detail), at: new Date().toISOString() }); };
    const fieldValue = field => field.evaluate(el => 'value' in el ? String(el.value) : el.innerText);
    const verifyCurrency = async key => {
      const currencies = String(await fieldValue(await one(key))).toUpperCase().match(/\b[A-Z]{3}\b/g);
      if (currencies?.length !== 1 || currencies[0] !== task.currency) throw new Error('无法确认订单币种，已停止');
    };
    const beforeOrder = () => { if (submissionStarted) throw new Error('订单已提交，不能再修改商品或跳转到其他订单'); };
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
      return scrub(evidence);
    };
    const review = async () => {
      const checks = task.program.checkout;
      const productText = await (await one(checks.productSelector)).innerText();
      const productName = value => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
      if (productName(productText) !== productName(task.product)) throw new Error('订单中的商品与配置不符，已停止');
      const total = parseOrderTotal(await (await one(checks.totalSelector)).innerText());
      await verifyCurrency(checks.currencySelector);
      const quantityText = await fieldValue(await one(checks.quantitySelector));
      if (!/^\s*\d+\s*$/.test(quantityText) || Number(quantityText) !== task.quantity) throw new Error('订单数量与配置不符，已停止');
      if (total <= 0 || total > task.maxTotal) throw new Error('订单总价超过上限，已停止');
      return { product: task.product, quantity: task.quantity, total, currency: task.currency };
    };
    const methods = {
      goto: async url => { beforeOrder(); await page.goto(sameOrigin(url), { waitUntil: 'domcontentloaded' }); await ensure(); note('访问', page.url()); return true; },
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
        await field.click(); await page.waitForTimeout(200); await ensure(); note('点击', key); return true;
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
        try { await button.click(); await page.waitForTimeout(300); await ensure(); }
        finally { submissionPermit = null; }
        note('购物车', key); return true;
      },
      login: async (usernameSelector, passwordSelector, buttonSelector) => {
        beforeOrder();
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
      submit: async () => {
        if (committed) throw new Error('同一任务不得重复提交');
        const checked = await review();
        committed = true;
        if (task.executionMode === 'prepare' || task.dryRun) { note('核对', '已到提交前，未创建订单'); receipt = { status: 'prepared', review: checked, url: clean(page.url()) }; return receipt; }
        const button = await one(task.program.checkout.submitSelector);
        if (/pay\s*(?:now|invoice)|支付|付款|扣款/i.test(await button.innerText())) throw new Error('下单和付款需要分步核对，已停在提交前');
        const form = await button.evaluate(el => el.form ? { url: el.form.action, method: el.form.method.toUpperCase(), payment: [...el.form.querySelectorAll('input,select')].some(field => /(?:cardnumber|card_number|ccnumber|cvv|cvc|usecredit|applycredit|autopay|savedpayment)/i.test(field.name || field.id) && (field.type === 'checkbox' || field.type === 'radio' ? field.checked : !!field.value)) } : null);
        if (!form || form.method !== 'POST' || form.payment) throw new Error('订单表单无法验证或包含自动付款设置，已停止');
        await onBeforeSubmit(checked);
        submissionStarted = true;
        submissionPermit = { url: sameOrigin(form.url).split('#')[0], used: false };
        note('提交', '正在提交一次订单');
        const permit = submissionPermit;
        try { await button.click(); }
        finally { submissionPermit = null; }
        if (!permit.used) throw new Error('网站没有提交已核对的订单请求');
        await page.locator(selector(task.program.checkout.confirmationSelector)).waitFor({ state: 'visible' });
        await ensure(); orderPage = page.url();
        receipt = { status: 'ordered', review: checked, confirmation: clean(await page.locator(task.program.checkout.confirmationSelector).innerText()), url: clean(orderPage) };
        return receipt;
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
        const form = await button.evaluate((el, key) => el.form ? { url: el.form.action, method: el.form.method.toUpperCase(), encoding: el.form.enctype, invoiceMatches: el.form.contains(document.querySelector(key)), cardData: [...el.form.querySelectorAll('input')].some(field => /(?:cardnumber|card_number|ccnumber|cvv|cvc)/i.test(field.name || field.id) && !!field.value) } : null, checks.invoiceSelector);
        if (!form || form.method !== 'POST' || form.encoding !== 'application/x-www-form-urlencoded' || !form.invoiceMatches || form.cardData || !/pay|支付|付款/i.test(await button.innerText())) throw new Error('付款表单无法与本次账单核对，已停止');
        const invoiceFromUrl = new URL(orderPage).searchParams.get('invoiceid') || new URL(orderPage).searchParams.get('id');
        if (invoiceFromUrl && invoiceFromUrl !== invoice.id) throw new Error('付款账单号与当前订单不符，已停止');
        receipt = { ...receipt, invoiceId: invoice.id };
        const total = parseOrderTotal(await (await one(checks.totalSelector)).innerText());
        await verifyCurrency(checks.currencySelector);
        if (total > task.maxTotal || Math.round(total * 100) !== Math.round(receipt.review.total * 100)) throw new Error('付款金额与已核对的订单总价不符，已停止');
        const checked = { invoiceId: invoice.id, total, currency: task.currency };
        receipt = { ...receipt, invoiceId: invoice.id };
        if (await page.locator(checks.confirmationSelector).isVisible()) throw new Error('付款确认元素在付款前已经存在，无法验证成功状态');
        await onBeforePayment(checked); paymentStarted = true;
        paymentPermit = { url: sameOrigin(form.url).split('#')[0], invoiceField: invoice.name, invoiceId: invoice.id, used: false };
        note('付款', '正在支付账单 ' + invoice.id + ' · ' + task.currency + ' ' + total);
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
    await methods.goto(task.url);
    return { methods, snapshot, trace, get submissionStarted() { return submissionStarted; }, get paymentStarted() { return paymentStarted; }, get receipt() { return receipt; }, close: async () => { clearTimeout(watchdog); signal?.removeEventListener('abort', stop); await browser.close(); } };
  } catch (error) { clearTimeout(watchdog); signal?.removeEventListener('abort', stop); await browser.close().catch(() => {}); throw new Error(clean(error.message)); }
}
