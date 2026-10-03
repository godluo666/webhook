import { sourceDispatcher, redactProxy } from './source-proxy.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_BYTES = 2_000_000;

export function isChallengePage(body, headers = {}) {
  const header = (name) => typeof headers.get === 'function' ? headers.get(name) : headers[name] || headers[name.toLowerCase()];
  if (String(header('cf-mitigated')).toLowerCase() === 'challenge') return true;
  const html = String(body || '').slice(0, 150_000);
  if (!/^\s*(?:<!doctype\s+html|<html|<head|<title)/i.test(html) && !String(header('content-type')).includes('text/html')) return false;
  return /<script\b[^>]*>[\s\S]*?(?:window\.)?_cf_chl_opt\s*=/i.test(html)
    || /<[^>]+\bid\s*=\s*["'](?:challenge-form|cf-browser-verification)["']/i.test(html)
    || /<title[^>]*>\s*(?:Just a moment|Attention Required)[\s\S]*?<\/title>/i.test(html) && /cloudflare|\/cdn-cgi\/challenge-platform\//i.test(html)
    || /\/cdn-cgi\/challenge-platform\//i.test(html) && /(?:Verifying you are human|Checking your browser|Performing security verification)/i.test(html);
}

export function validateFetchOptions(value) {
  if (value == null) return { mode: 'auto', proxy: 'default' };
  if (typeof value !== 'object' || Array.isArray(value) || !['auto', 'http', 'browser'].includes(value.mode)) throw new Error('网页读取方式无效');
  if (value.proxy != null && !['default', 'direct'].includes(value.proxy)) throw new Error('监控代理选择无效');
  return { mode: value.mode, proxy: value.proxy || 'default' };
}

function failure(message, code, metadata = {}) {
  return Object.assign(new Error(message), { code, fetchDetails: metadata, responseStatus: metadata.httpStatus, responseBody: metadata.responseBody });
}
export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  return Math.min(3_600_000, Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now || 0));
}
async function bodyText(response) {
  let size = 0;
  const parts = [];
  for await (const part of response.body || []) {
    size += part.length;
    if (size > MAX_BYTES) throw failure('来源内容超过 2 MB，请使用更小的接口或页面', 'SOURCE_TOO_LARGE');
    parts.push(part);
  }
  return Buffer.concat(parts).toString('utf8');
}

export function createSourceFetcher({ fetchImpl = fetch, browserFetch, browserEnabled = true, wait = sleep } = {}) {
  return async function fetchSource(url, { userId, expectsJson = false, mode = 'auto', proxyUrl = '', direct = false } = {}) {
    const attempts = [];
    const metadata = () => ({ attempts: [...attempts], route: proxyUrl ? 'proxy' : direct ? 'direct' : 'server' });
    const browser = async (original) => {
      if (!browserEnabled || !browserFetch) throw failure('来源需要浏览器验证，但浏览器读取已关闭；请启用浏览器或使用可直连的数据来源', 'SOURCE_CHALLENGE', { ...metadata(), ...original?.fetchDetails });
      try {
        const result = await browserFetch(url, { userId, expectsJson, proxyUrl });
        if (isChallengePage(result.body, result.headers)) throw failure('浏览器仍停留在 Cloudflare 验证页，可能与出口 IP 有关；请在读取设置配置可访问该网站的代理', 'SOURCE_CHALLENGE', { httpStatus: result.status, responseBody: redactProxy(result.body, proxyUrl).slice(0, 4000) });
        if (result.status < 200 || result.status >= 300) throw failure('浏览器读取返回 HTTP ' + result.status, 'SOURCE_HTTP_ERROR', { httpStatus: result.status, responseBody: redactProxy(result.body, proxyUrl).slice(0, 4000) });
        if (Buffer.byteLength(result.body) > MAX_BYTES) throw failure('浏览器返回的来源内容超过 2 MB', 'SOURCE_TOO_LARGE');
        attempts.push({ method: 'browser', httpStatus: result.status, outcome: 'success' });
        return { ...result, metadata: { ...metadata(), method: 'browser', httpStatus: result.status, finalUrl: result.finalUrl || url } };
      } catch (error) {
        attempts.push({ method: 'browser', outcome: 'error', error: redactProxy(error.message, proxyUrl).slice(0, 240) });
        const origin = original?.fetchDetails || {};
        throw failure((original ? 'Cloudflare 验证未完成：' : '浏览器读取失败：') + redactProxy(error.message, proxyUrl), original ? 'SOURCE_CHALLENGE' : error.code || 'SOURCE_BROWSER_ERROR', { ...origin, ...error.fetchDetails, ...metadata() });
      }
    };
    if (mode === 'browser') return browser();
    for (let attempt = 0; attempt < 2; attempt++) {
      let response, dispatcher;
      try {
        dispatcher = sourceDispatcher(proxyUrl, direct);
        response = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15_000), ...(dispatcher ? { dispatcher } : {}),
          headers: { 'user-agent': 'WebhookRadar/2.1', accept: expectsJson ? 'application/json' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
        const body = await bodyText(response);
        const info = { httpStatus: response.status, finalUrl: response.url || url, cfRay: response.headers.get('cf-ray') || null,
          retryAfterMs: retryAfterMs(response.headers.get('retry-after')) };
        if (isChallengePage(body, response.headers)) {
          attempts.push({ method: 'http', httpStatus: response.status, outcome: 'challenge' });
          const error = failure('Cloudflare 验证页，未取得真实来源内容；原检测状态已保留', 'SOURCE_CHALLENGE', { ...info, ...metadata(), responseBody: redactProxy(body, proxyUrl).slice(0, 4000) });
          if (mode === 'http') throw error;
          return browser(error);
        }
        attempts.push({ method: 'http', httpStatus: response.status, outcome: response.ok ? 'success' : 'error' });
        if (response.ok) return { body, status: response.status, finalUrl: response.url || url, headers: Object.fromEntries(response.headers),
          metadata: { ...metadata(), ...info, method: 'http' } };
        if (attempt === 0 && [429, 502, 503, 504].includes(response.status) && info.retryAfterMs <= 1500) { await wait(info.retryAfterMs || 250); continue; }
        throw failure('来源返回 HTTP ' + response.status, response.status === 429 ? 'SOURCE_RATE_LIMITED' : 'SOURCE_HTTP_ERROR', { ...info, ...metadata(), responseBody: redactProxy(body, proxyUrl).slice(0, 4000) });
      } catch (error) {
        if (error.code) throw error;
        if (attempt === 0) { attempts.push({ method: 'http', outcome: 'network-error', error: error.cause?.code || error.name }); await wait(250); continue; }
        throw Object.assign(failure('连接来源失败：' + redactProxy(error.cause?.code || error.message, proxyUrl), 'SOURCE_NETWORK_ERROR', metadata()),
          { networkCode: error.cause?.code || error.name, networkCause: redactProxy(error.cause?.message || error.message, proxyUrl) });
      } finally { await dispatcher?.destroy(); }
    }
  };
}
