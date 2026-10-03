import { ProxyAgent, Agent } from 'undici';

export function validateSourceProxy(value) {
  if (!value) return '';
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('代理地址无效，请使用 http://主机:端口 或 https://主机:端口'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.pathname !== '/' || url.search || url.hash || url.href.length > 2000) throw new Error('代理仅支持 HTTP / HTTPS 地址，可包含用户名和密码');
  try { decodeURIComponent(url.username); decodeURIComponent(url.password); } catch { throw new Error('代理用户名或密码编码无效'); }
  return url.href;
}

export function proxyEndpoint(value) {
  if (!value) return '';
  try { return new URL(value).origin; } catch { return ''; }
}

export function redactProxy(text, value) {
  let output = String(text || '');
  if (!value) return output;
  const url = new URL(value);
  for (const secret of [value, url.href, url.username, url.password, decodeURIComponent(url.username), decodeURIComponent(url.password)].filter(Boolean).sort((a, b) => b.length - a.length)) output = output.split(secret).join('[redacted]');
  return output;
}

// Dispatchers are scoped to this read. Never change the application's global
// dispatcher: notification, AI and email requests retain their own network route.
export function sourceDispatcher(proxyUrl, direct = false) {
  if (proxyUrl) {
    const url = new URL(validateSourceProxy(proxyUrl));
    const token = url.username || url.password ? 'Basic ' + Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)).toString('base64') : undefined;
    url.username = ''; url.password = '';
    return new ProxyAgent({ uri: url.href, ...(token ? { token } : {}) });
  }
  return direct ? new Agent() : null;
}
