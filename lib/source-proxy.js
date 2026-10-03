import { ProxyAgent, Agent } from 'undici';
import { parseShadowsocks } from './shadowsocks.js';

export function validateSourceProxy(value) {
  if (!value) return '';
  if (/^ss:\/\//i.test(String(value).trim())) return parseShadowsocks(value).normalized;
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('代理地址无效，请粘贴 ss:// 节点或 HTTP / HTTPS 代理地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.pathname !== '/' || url.search || url.hash || url.href.length > 2000) throw new Error('支持 ss:// 节点或 HTTP / HTTPS 代理地址，可包含用户名和密码');
  try { decodeURIComponent(url.username); decodeURIComponent(url.password); } catch { throw new Error('代理用户名或密码编码无效'); }
  return url.href;
}

export function proxyEndpoint(value) {
  if (!value) return '';
  try { return /^ss:\/\//i.test(value) ? parseShadowsocks(value).endpoint : new URL(value).origin; } catch { return ''; }
}

export function redactProxy(text, value) {
  let output = String(text || '');
  if (!value) return output;
  let secrets;
  if (/^ss:\/\//i.test(value)) {
    const node = parseShadowsocks(value);
    secrets = [value, node.normalized, node.password, encodeURIComponent(node.password), Buffer.from(node.method + ':' + node.password).toString('base64url')];
  } else {
    const url = new URL(value);
    secrets = [value, url.href, url.username, url.password, decodeURIComponent(url.username), decodeURIComponent(url.password), ...(url.username || url.password ? [Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)).toString('base64')] : [])];
  }
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) output = output.split(secret).join('[redacted]');
  return output;
}

// Dispatchers are scoped to this read. Never change the application's global
// dispatcher: notification, AI and email requests retain their own network route.
export function sourceDispatcher(proxyUrl, direct = false) {
  if (proxyUrl) {
    const url = new URL(validateSourceProxy(proxyUrl));
    if (url.protocol === 'ss:') throw new Error('SS 节点需要先通过本地客户端转发');
    const token = url.username || url.password ? 'Basic ' + Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)).toString('base64') : undefined;
    url.username = ''; url.password = '';
    return new ProxyAgent({ uri: url.href, ...(token ? { token } : {}) });
  }
  return direct ? new Agent() : null;
}
