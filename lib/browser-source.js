import { browserOperation, isBrowserClosedError, settledBrowserRead } from './browser-operation.js';
import { installProxyAuthentication, browserAuthenticationError, browserAuthenticatedNavigation } from './browser-proxy-auth.js';
import { ExpiringMap } from './expiring-map.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isChallengePage } from './source-fetch.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessions = new ExpiringMap({expiresAt:item=>item.expires,maxEntries:64});
let busy = false;
const waiting = [];
async function acquire(signal) {
  signal?.throwIfAborted();
  if (!busy) { busy = true; return; }
  if (waiting.length >= 8) throw new Error('浏览器读取繁忙，请稍后再试');
  await new Promise((resolve, reject) => {
    const cleanup=()=>{clearTimeout(entry.timer);signal?.removeEventListener('abort',abort);};
    const fail=error=>{const index=waiting.indexOf(entry);if(index>=0)waiting.splice(index,1);cleanup();reject(error);};
    const abort=()=>fail(signal.reason);
    const entry={resolve:()=>{cleanup();resolve();}};
    entry.timer=setTimeout(()=>fail(new Error('等待浏览器读取超时，请稍后再试')),60000);
    waiting.push(entry);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}

function release() {
  const next = waiting.shift();
  if (next) next.resolve();
  else busy = false;
}


async function startDisplay() {
  const child = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-ac'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  try {
    const display = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('启动浏览器显示服务超时')), 8000);
      const settle = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
      child.once('error', (error) => settle(new Error('无法启动 Xvfb：' + error.message)));
      child.once('exit', () => settle(new Error('浏览器显示服务提前退出')));
      child.stdio[3].on('data', (part) => {
        buffer += part;
        if (/^\d+\n/.test(buffer)) settle(null, ':' + buffer.trim());
      });
    });
    return { child, display };
  } catch (error) { child.kill(); throw error; }
}
async function stopDisplay(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

export function createBrowserSource({ dataDir, launchContext, timeoutMs = 45_000 } = {}) {
  const tempRoot = path.join(process.env.MONITOR_TEMP_DIR || dataDir, 'browser-tmp');
  const readOnce = async (url, { userId, expectsJson = false, proxyUrl = '', proxyIdentity = '', signal, deadline } = {}) => {
    if (!userId) throw new Error('浏览器读取需要账户身份');
    const origin = new URL(url).origin;
    const key = userId + ':' + origin + ':' + createHash('sha256').update(proxyIdentity || proxyUrl).digest('hex');
    const proxy = proxyUrl ? new URL(proxyUrl) : null;
    let browser, context, profile, watchdog, displayProcess,browserClosing,timedOut=false,stage='launch',authentication={};
    const close=()=>browserClosing||=(browser?.close() || context?.close())?.catch(()=>{});
    try {
      signal?.throwIfAborted();
      await fs.mkdir(tempRoot, { recursive: true });
      profile = await fs.mkdtemp(path.join(tempRoot, 'source-'));
      const headless = process.platform !== 'linux' || process.env.MONITOR_BROWSER_HEADLESS === '1';
      let display;
      if (!headless) { const result = await startDisplay(); displayProcess = result.child; display = result.display; }
      const chromium = (await import('playwright-core')).chromium;
      context = await (launchContext || chromium.launchPersistentContext.bind(chromium))(profile, {
        viewport: { width: 1440, height: 1000 }, acceptDownloads: false,
        executablePath: process.env.MONITOR_BROWSER_EXECUTABLE || undefined,
        headless, timeout: Math.max(1,Math.min(15000,deadline-Date.now())),
        env: { ...process.env, ...(display ? { DISPLAY: display } : {}) },
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions', '--disable-blink-features=AutomationControlled',
          ...(proxy ? ['--proxy-server=' + proxy.origin, '--proxy-bypass-list=<-loopback>'] : [])]
      });
      browser = context.browser();
      signal?.addEventListener('abort',close,{once:true});signal?.throwIfAborted();
      watchdog = setTimeout(() => {timedOut=true;void close();}, Math.max(1,deadline-Date.now()));
      watchdog.unref();
      const prior = sessions.get(key);
      stage='cookies';
      if (prior?.cookies?.length) await browserOperation(()=>context.addCookies(prior.cookies),{signal,timeoutMs:Math.min(10000,deadline-Date.now()),code:'SOURCE_BROWSER_TIMEOUT',message:'浏览器恢复 Cookie 超时，请检查浏览器资源与运行环境',onTimeout:close});
      const page = context.pages()[0] || await context.newPage();
      page.setDefaultTimeout(15_000);
      if (proxy && (proxy.username || proxy.password)) {
        // Origin-site 401 responses must not receive proxy credentials.
        const auth = await context.newCDPSession(page);
        auth.on('Fetch.requestPaused', ({ requestId }) => auth.send('Fetch.continueRequest', { requestId }).catch(() => {}));
        authentication=installProxyAuthentication(auth,proxy);
        await auth.send('Fetch.enable', { handleAuthRequests: true });
      }
      const apiResponses = [], apiReads = [];
      page.on('response', response => {
        const request = response.request();
        if (apiReads.length >= 8 || request.method() !== 'GET' || !['xhr', 'fetch'].includes(request.resourceType())) return;
        try {
          const endpoint = new URL(response.url());
          if (endpoint.origin !== origin || /(?:token|secret|password|key)=/i.test(endpoint.search)) return;
        } catch { return; }
        apiReads.push((async () => {
          try {
            const headers = await response.allHeaders();
            if (!String(headers['content-type']).includes('json') || Number(headers['content-length'] || 0) > 200_000) return;
            const payload = await response.body();
            if (payload.length <= 200_000) apiResponses.push({ url: response.url(), method: 'GET', body: payload.toString('utf8') });
          } catch { /* browser-only responses are never assumed to be replayable */ }
        })());
      });
      let documentResponse = null;
      page.on('response', (response) => {
        const request = response.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentResponse = response;
      });
      stage='navigation';
      const first = await browserAuthenticatedNavigation(()=>page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(1000, deadline - Date.now()) }),authentication,Boolean(proxy));
      documentResponse ||= first;stage='read';
      const readPage=operation=>settledBrowserRead(operation,{signal,timeoutMs:Math.min(5000,deadline-Date.now()),code:'SOURCE_BROWSER_TIMEOUT',message:'网页跳转尚未稳定，请检查目标网站与代理',onTimeout:close});
      let body = '';
      while (Date.now() < deadline) {
        const html = await readPage(()=>page.content());
        const headers = documentResponse ? await documentResponse.allHeaders() : {};
        if (!isChallengePage(html, headers)) {
          await pause(1000);
          const finalHtml = await readPage(()=>page.content());
          if (!isChallengePage(finalHtml, documentResponse ? await documentResponse.allHeaders() : {})) {
            body = expectsJson ? await page.innerText('body') : finalHtml;
            break;
          }
        }
        await pause(600);
      }
      if (!body) throw Object.assign(new Error('浏览器验证超时，仍未取得真实内容；请检查出口 IP 或为监控配置可用代理'), { code: 'SOURCE_CHALLENGE' });
      const finalUrl = page.url();
      if (new URL(finalUrl).origin !== origin) throw new Error('浏览器跳转到了其他网站，请确认实际来源地址');
      if (expectsJson) { try { JSON.parse(body); } catch { throw new Error('验证后未返回有效 JSON，请确认这是数据接口地址'); } }
      const cookies = (await context.cookies(url)).slice(0, 32);
      if (JSON.stringify(cookies).length < 32_000) sessions.set(key, { cookies, expires: Date.now() + 60 * 60_000 });
      await Promise.allSettled(apiReads);
      return { body, apiResponses, status: documentResponse?.status() || 200, headers: documentResponse ? await documentResponse.allHeaders() : {}, finalUrl };
    } catch(error) {
      signal?.throwIfAborted();
      error=browserAuthenticationError(error,authentication,Boolean(proxy));
      if(timedOut||stage==='launch'&&error.name==='TimeoutError')error=Object.assign(new Error('浏览器读取超时，请检查目标网站、代理和运行资源'),{code:'SOURCE_BROWSER_TIMEOUT'});
      else if(isBrowserClosedError(error))error=Object.assign(new Error('浏览器在恢复会话或读取页面时意外关闭，请稍后重试并检查运行资源'),{code:'SOURCE_BROWSER_CLOSED'});
      error.fetchDetails={...error.fetchDetails,browserStage:stage};throw error;
    } finally {
      clearTimeout(watchdog);signal?.removeEventListener('abort',close);
      try { await close(); } catch { /* the watchdog may have closed it */ }
      await stopDisplay(displayProcess);
      if (profile && path.dirname(profile) === tempRoot) await fs.rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => {});
    }
  };
  return async (url,options={})=>{
    if(!options.userId)throw new Error('浏览器读取需要账户身份');
    await acquire(options.signal);const deadline=Date.now()+timeoutMs;
    try{for(let attempt=0;;attempt++){
      try{return await readOnce(url,{...options,deadline});}
      catch(error){
        options.signal?.throwIfAborted();
        const startup=['launch','cookies'].includes(error.fetchDetails?.browserStage);
        if(attempt||!startup||!['SOURCE_BROWSER_CLOSED','SOURCE_BROWSER_TIMEOUT'].includes(error.code)||Date.now()>=deadline)throw error;
      }
    }}finally{release();}
  };
}
