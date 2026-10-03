import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isChallengePage } from './source-fetch.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessions = new Map();
let busy = false;
const waiting = [];
async function acquire() {
  if (!busy) { busy = true; return; }
  if (waiting.length >= 8) throw new Error('浏览器读取繁忙，请稍后再试');
  await new Promise((resolve, reject) => {
    const entry = { resolve: () => { clearTimeout(entry.timer); resolve(); } };
    entry.timer = setTimeout(() => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); reject(new Error('等待浏览器读取超时，请稍后再试')); }, 60_000);
    waiting.push(entry);
  });
}
function release() {
  const next = waiting.shift();
  if (next) next.resolve();
  else busy = false;
}

export function createBrowserSource({ dataDir, connectBrowser, timeoutMs = 45_000 } = {}) {
  const tempRoot = path.join(dataDir, 'browser-tmp');
  return async (url, { userId, expectsJson = false, proxyUrl = '' } = {}) => {
    if (!userId) throw new Error('浏览器读取需要账户身份');
    await acquire();
    let browser, profile, watchdog;
    const origin = new URL(url).origin;
    const key = userId + ':' + origin + ':' + createHash('sha256').update(proxyUrl).digest('hex');
    const proxy = proxyUrl ? new URL(proxyUrl) : null;
    try {
      const now = Date.now();
      for (const [id, item] of sessions) if (item.expires <= now) sessions.delete(id);
      while (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
      await fs.mkdir(tempRoot, { recursive: true });
      profile = await fs.mkdtemp(path.join(tempRoot, 'source-'));
      const connect = connectBrowser || (await import('puppeteer-real-browser')).connect;
      const headless = process.platform !== 'linux' || process.env.MONITOR_BROWSER_HEADLESS === '1';
      const deadline = Date.now() + timeoutMs;
      const connection = await connect({
        ...(proxy ? { proxy: { host: proxy.protocol + '//' + proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? '443' : '80'), } } : {}),
        headless: headless ? 'new' : false, turnstile: true, disableXvfb: headless,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions', ...(proxy ? ['--proxy-bypass-list=<-loopback>'] : [])],
        customConfig: { userDataDir: profile, connectionPollInterval: 100, maxConnectionRetries: 80,
          ...(process.env.MONITOR_BROWSER_EXECUTABLE ? { chromePath: process.env.MONITOR_BROWSER_EXECUTABLE } : {}) },
        connectOption: { defaultViewport: null, protocolTimeout: 15_000 }
      });
      browser = connection.browser;
      const page = connection.page;
      if (proxy && (proxy.username || proxy.password)) {
        // Answer proxy authentication only. Origin-site 401 challenges must
        // never receive the user's proxy credentials.
        const auth = await page.createCDPSession();
        auth.on('Fetch.requestPaused', ({ requestId }) => auth.send('Fetch.continueRequest', { requestId }).catch(() => {}));
        auth.on('Fetch.authRequired', ({ requestId, authChallenge }) => auth.send('Fetch.continueWithAuth', {
          requestId, authChallengeResponse: authChallenge.source === 'Proxy'
            ? { response: 'ProvideCredentials', username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) }
            : { response: 'CancelAuth' }
        }).catch(() => {}));
        await auth.send('Fetch.enable', { handleAuthRequests: true });
      }
      watchdog = setTimeout(() => browser.close().catch(() => {}), timeoutMs + 10_000);
      watchdog.unref();
      const prior = sessions.get(key);
      if (prior?.cookies?.length) await page.setCookie(...prior.cookies);
      let documentResponse = null;
      page.on('response', (response) => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) documentResponse = response;
      });
      const first = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(1000, deadline - Date.now()) });
      documentResponse ||= first;
      // Navigation and verification share one time budget.
      let body = '';
      while (Date.now() < deadline) {
        const html = await page.content();
        const headers = documentResponse?.headers() || {};
        if (!isChallengePage(html, headers)) {
          await pause(1000);
          const finalHtml = await page.content();
          if (!isChallengePage(finalHtml, documentResponse?.headers() || {})) {
            body = expectsJson ? await page.$eval('body', (element) => element.innerText) : finalHtml;
            break;
          }
        }
        await pause(600);
      }
      if (!body) throw Object.assign(new Error('浏览器验证超时，仍未取得真实内容；请检查出口 IP 或为监控配置可用代理'), { code: 'SOURCE_CHALLENGE' });
      const finalUrl = page.url();
      if (new URL(finalUrl).origin !== origin) throw new Error('浏览器跳转到了其他网站，请确认实际来源地址');
      if (expectsJson) { try { JSON.parse(body); } catch { throw new Error('验证后未返回有效 JSON，请确认这是数据接口地址'); } }
      const cookies = (await page.cookies(url)).slice(0, 32);
      if (JSON.stringify(cookies).length < 32_000) sessions.set(key, { cookies, expires: Date.now() + 60 * 60_000 });
      return { body, status: documentResponse?.status() || 200, headers: documentResponse?.headers() || {}, finalUrl };
    } finally {
      clearTimeout(watchdog);
      try { await browser?.close(); } catch { /* the watchdog may have already closed it */ }
      if (profile && path.dirname(profile) === tempRoot) await fs.rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => {});
      release();
    }
  };
}
