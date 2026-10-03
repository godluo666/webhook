import { isIP } from 'node:net';
import { sourceDispatcher, validateSourceProxy, proxyEndpoint, redactProxy } from './source-proxy.js';

export const DEFAULT_PROXY_PROBES = ['https://api64.ipify.org?format=json', 'https://www.cloudflare.com/cdn-cgi/trace'];
const safeUrl = value => { const url = new URL(value); return url.origin + url.pathname; };
function scrub(value, secrets) {
  if (typeof value === 'string') return secrets.reduce((text, secret) => redactProxy(text, secret), value);
  if (Array.isArray(value)) return value.map(item => scrub(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, secrets)]));
  return value;
}
async function limitedBody(response) {
  let size = 0;
  const parts = [];
  for await (const part of response.body || []) {
    size += part.length;
    if (size > 4096) throw Object.assign(new Error('检测服务响应过大，无法确认代理出口'), { code: 'PROXY_PROBE_RESPONSE' });
    parts.push(part);
  }
  return Buffer.concat(parts).toString('utf8');
}
function exitIp(body) {
  let value;
  try { value = JSON.parse(body)?.ip; } catch { /* plain IP and Cloudflare trace below */ }
  if (!value) value = body.trim();
  if (!isIP(String(value))) value = body.match(/^ip=([^\r\n]+)$/m)?.[1]?.trim();
  return isIP(String(value || '')) ? String(value) : '';
}

// Probes are controlled by the server, never by user form fields. A successful
// local port connection is insufficient: request a real IP response through it.
export function createProxyTester({ withProxy = (proxy, read) => read(proxy), fetchImpl = fetch, urls = DEFAULT_PROXY_PROBES, timeoutMs = 8000 } = {}) {
  const probes = urls.map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('代理检测服务地址无效');
    return url.href;
  });
  if (!probes.length || probes.length > 3) throw new Error('代理检测服务数量无效');
  return async value => {
    const proxy = validateSourceProxy(value);
    if (!proxy) throw new Error('请先粘贴代理地址或 SS 节点');
    const started = Date.now(), attempts = [];
    try {
      return await withProxy(proxy, async localProxy => {
        for (const url of probes) {
          const attempt = { url: safeUrl(url) };
          const begin = Date.now();
          let dispatcher;
          try {
            dispatcher = sourceDispatcher(localProxy);
            const response = await fetchImpl(url, { method: 'GET', redirect: 'error', dispatcher, signal: AbortSignal.timeout(timeoutMs),
              headers: { accept: 'application/json,text/plain;q=0.9', 'user-agent': 'WebhookRadar/2.2', 'cache-control': 'no-cache' } });
            attempt.httpStatus = response.status;
            const body = await limitedBody(response);
            if (!response.ok) throw Object.assign(new Error('检测服务返回 HTTP ' + response.status), { code: response.status === 407 ? 'PROXY_AUTH_FAILED' : 'PROXY_PROBE_HTTP' });
            const ip = exitIp(body);
            if (!ip) throw Object.assign(new Error('检测服务未返回有效出口 IP，无法确认代理可用'), { code: 'PROXY_PROBE_RESPONSE' });
            attempts.push({ ...attempt, outcome: 'success', durationMs: Date.now() - begin });
            return { ok: true, purpose: 'connectivity', endpoint: proxyEndpoint(proxy), ip, durationMs: Date.now() - started, testedAt: new Date().toISOString(),
              fetch: { route: 'proxy', method: 'http', proxyType: proxy.startsWith('ss://') ? 'shadowsocks' : 'http', attempts: scrub(attempts, [localProxy, proxy]) } };
          } catch (error) {
            const causes = [], seen = new Set();
            for (let cause = error; cause && causes.length < 6 && !seen.has(cause); cause = cause.cause) { causes.push(cause); seen.add(cause); }
            const networkCode = causes.flatMap(cause => [cause.code, cause.name]).filter(Boolean).join(' / ');
            const raw = causes.map(cause => cause.message).filter(Boolean).join(' → ');
            let detail = raw;
            let code = typeof error.code === 'string' && error.code.startsWith('PROXY_') ? error.code : 'PROXY_NETWORK_ERROR';
            if (/\b407\b/.test(raw)) { code = 'PROXY_AUTH_FAILED'; detail = '代理认证失败，请核对账号和密码'; }
            else if (/timeout/i.test(networkCode)) { code = 'PROXY_TIMEOUT'; detail = '代理出网检测超时（' + timeoutMs / 1000 + ' 秒）'; }
            else if (/ECONNREFUSED/.test(networkCode)) { code = 'PROXY_CONNECTION_REFUSED'; detail = '无法连接代理，请检查地址、端口和监听范围'; }
            else if (/CERT|TLS|SSL/i.test(networkCode)) { code = 'PROXY_TLS_FAILED'; detail = '代理连接或检测服务的 TLS / 证书校验失败'; }
            attempts.push(scrub({ ...attempt, outcome: 'error', durationMs: Date.now() - begin, errorCode: code, networkCode, networkCause: raw, error: detail }, [localProxy, proxy]));
            if (code === 'PROXY_AUTH_FAILED') break;
          } finally { await dispatcher?.destroy(); }
        }
        const last = attempts.at(-1);
        throw Object.assign(new Error('代理连通性测试未通过 · ' + (last?.error || '未获得有效检测结果')), { code: last?.errorCode || 'PROXY_TEST_FAILED', fetchDetails: { route: 'proxy', purpose: 'connectivity', attempts } });
      });
    } catch (error) {
      error.message = redactProxy(error.message, proxy);
      error.fetchDetails = scrub({ ...error.fetchDetails, route: 'proxy', purpose: 'connectivity', attempts: error.fetchDetails?.attempts || attempts }, [proxy]);
      throw error;
    }
  };
}
