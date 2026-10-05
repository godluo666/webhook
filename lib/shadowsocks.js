import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

export const SHADOWSOCKS_METHODS = ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
  'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb', 'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr', 'rc4-md5', 'chacha20-ietf'];
const METHODS = new Set(SHADOWSOCKS_METHODS);
const invalid = () => new Error('Shadowsocks 节点无效，请粘贴完整 ss:// 分享链接');
function decode64(value) {
  if (!/^[a-zA-Z0-9+/_-]+={0,2}$/.test(value) || value.replace(/=+$/, '').length % 4 === 1) throw invalid();
  return Buffer.from(value, 'base64url').toString('utf8');
}

// Build the URI from raw form values; password characters are encoded once.
// https://shadowsocks.org/doc/sip002.html
export function buildShadowsocksUrl(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请填写 Shadowsocks 服务器参数');
  let server = String(input.server || '').trim();
  if (server.startsWith('[') && server.endsWith(']')) server = server.slice(1, -1);
  if (!server || /[\s/@?#\\%]/.test(server)) throw new Error('服务器地址只需填写 IP 或域名，不包含协议、端口或路径');
  if (net.isIP(server) === 6) server = '[' + server + ']';
  else {
    if (server.includes(':')) throw new Error('服务器 IP 或域名无效，请将端口填写在端口栏');
    let host;
    try { host = new URL('http://' + server); } catch { throw new Error('服务器 IP 或域名无效'); }
    if (host.port || host.pathname !== '/' || !host.hostname || host.hostname.length > 253 || host.hostname.replace(/\.$/, '').split('.').some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) throw new Error('服务器 IP 或域名无效，请将端口填写在端口栏');
    server = host.hostname;
  }
  const port = String(input.port ?? '').trim();
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('服务器端口需要填写 1–65535 的整数');
  const method = String(input.method || '').trim();
  if (!METHODS.has(method)) throw new Error('请选择受支持的 Shadowsocks 加密方式');
  const password = input.password;
  if (typeof password !== 'string' || !password || password.length > 1000 || /[\r\n\0]/.test(password)) throw new Error('请填写有效的 Shadowsocks 密码或密钥');
  const uri = 'ss://' + encodeURIComponent(method) + ':' + encodeURIComponent(password) + '@' + server + ':' + Number(port);
  if (uri.length > 2000) throw new Error('生成的 SS 配置过长，请核对服务器地址和密码');
  return parseShadowsocks(uri).normalized;
}

export function parseShadowsocks(value) {
  const input = String(value || '').trim();
  if (!/^ss:\/\//i.test(input) || input.length > 2000 || /[\r\n\0]/.test(input)) throw invalid();
  let address = input.slice(5).split('#')[0], method, password, url;
  try {
    const authority = address.split('?')[0];
    const at = authority.lastIndexOf('@');
    if (at < 0) {
      const [encoded, ...query] = address.split('?');
      const decoded = decode64(decodeURIComponent(encoded.replace(/\/$/, '')));
      const legacyAt = decoded.lastIndexOf('@');
      const colon = decoded.indexOf(':');
      if (legacyAt < 0 || colon < 1 || colon >= legacyAt) throw invalid();
      method = decoded.slice(0, colon); password = decoded.slice(colon + 1, legacyAt);
      address = decoded.slice(legacyAt + 1) + (query.length ? '?' + query.join('?') : '');
    } else {
      // Split userinfo before URL parsing: older exporters use standard Base64,
      // whose slash would otherwise be interpreted as the start of a path.
      const userinfo = address.slice(0, at);
      const colon = userinfo.indexOf(':');
      if (colon >= 0) {
        method = decodeURIComponent(userinfo.slice(0, colon));
        password = decodeURIComponent(userinfo.slice(colon + 1));
      } else {
        const decoded = decode64(decodeURIComponent(userinfo));
        const decodedColon = decoded.indexOf(':');
        if (decodedColon < 1) throw invalid();
        method = decoded.slice(0, decodedColon); password = decoded.slice(decodedColon + 1);
      }
      address = address.slice(at + 1);
    }
    url = new URL('ss://' + address);
  } catch { throw invalid(); }
  if (url.searchParams.getAll('plugin').some(value => value)) throw new Error('这个 SS 节点需要额外插件；请使用不带插件的节点，或填写现有客户端的 HTTP 代理地址');
  if (!METHODS.has(method)) throw new Error('暂不支持此 SS 加密方式，请使用 AES-GCM、ChaCha20-Poly1305 或 AEAD-2022 节点');
  if (!password || password.length > 1000 || /[\r\n\0]/.test(password) || !url.hostname || !/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535 || !['', '/'].includes(url.pathname)) throw invalid();
  if (method.startsWith('2022-')) {
    const size = method.includes('aes-128') ? 16 : 32;
    if (password.split(':').some(key => !/^[a-zA-Z0-9+/]+={0,2}$/.test(key) || Buffer.from(key, 'base64').length !== size)) throw new Error('SS 2022 需要服务器提供的 Base64 密钥，每段解码后应为 ' + size + ' 字节；请核对密码与加密方式');
  }
  const endpoint = 'ss://' + url.host;
  const normalized = 'ss://' + encodeURIComponent(method) + ':' + encodeURIComponent(password) + '@' + url.host;
  return { server: url.hostname.replace(/^\[|\]$/g, ''), server_port: Number(url.port), method, password, endpoint, normalized };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function proxyError(message, code = 'SOURCE_PROXY_CLIENT') { return Object.assign(new Error(message), { code, fetchDetails: { route: 'proxy', proxyType: 'shadowsocks' } }); }
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
function probe(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = value => { if (done) return; done = true; socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(150, () => finish(false));
  });
}
async function waitForClose(child,milliseconds){
  if(child.exitCode!==null||child.signalCode!==null)return;
  let timer,listener;try{await new Promise(resolve=>{listener=resolve;child.once('close',listener);timer=setTimeout(resolve,milliseconds);});}finally{clearTimeout(timer);child.removeListener('close',listener);}
}
async function stop(child){
  if(!child?.pid||child.exitCode!==null||child.signalCode!==null)return;
  child.kill('SIGTERM');await waitForClose(child,1500);
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await waitForClose(child,1500);}
}

// Each read owns an authenticated loopback proxy; no account shares a client.
// Credentials live in private temporary files, never process arguments or logs.
export function createShadowsocksBridge({ dataDir, executable = process.env.MONITOR_SS_EXECUTABLE || '', spawnClient = spawn } = {}) {
  let active = 0;
  const queue = [];
  const acquire = async () => {
    if (active < 4) { active++; return; }
    if (queue.length >= 8) throw proxyError('代理读取正在排队，请稍后重试', 'SOURCE_PROXY_BUSY');
    await new Promise((resolve, reject) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); reject(proxyError('等待代理读取超时，请稍后重试', 'SOURCE_PROXY_BUSY')); }, 60_000);
      queue.push(entry);
    });
  };
  const release = () => { const next = queue.shift(); if (next) { clearTimeout(next.timer); next.resolve(); } else active--; };
  return async (value, read) => {
    if (!/^ss:\/\//i.test(value || '')) return read(value || '', '');
    const node = parseShadowsocks(value);
    if (!executable) throw proxyError('当前运行环境尚未包含 SS 客户端，请更新到最新版 Docker 镜像，或配置 MONITOR_SS_EXECUTABLE', 'SOURCE_PROXY_UNAVAILABLE');
    await acquire();
    let child, directory, launchError, stderr = '', localSecrets = [];
    try {
      const tempRoot = path.join(process.env.MONITOR_TEMP_DIR || dataDir, 'proxy-tmp');
      await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
      directory = await fs.mkdtemp(path.join(tempRoot, 'ss-'));
      const port = await freePort();
      const user = randomBytes(16).toString('hex'), password = randomBytes(24).toString('hex');
      localSecrets = [value, node.normalized, node.password, encodeURIComponent(node.password), JSON.stringify(node.password).slice(1, -1), user, password].sort((a, b) => b.length - a.length);
      const authFile = path.join(directory, 'auth.json'), configFile = path.join(directory, 'config.json');
      await fs.writeFile(authFile, JSON.stringify({ basic: { users: [{ user_name: user, password }] } }), { mode: 0o600 });
      await fs.writeFile(configFile, JSON.stringify({
        server: node.server, server_port: node.server_port, method: node.method, password: node.password,
        timeout: 20, runtime: { mode: 'single_thread' },
        locals: [{ protocol: 'http', local_address: '127.0.0.1', local_port: port, mode: 'tcp_only', http_auth_config_path: authFile }]
      }), { mode: 0o600 });
      child = spawnClient(executable, ['-c', configFile], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr?.on('data', data => { stderr = (stderr + data.toString('utf8')).slice(-4000); });
      child.once('error', error => { launchError = error; });
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (launchError || child.exitCode !== null || child.signalCode !== null) throw proxyError('SS 客户端启动失败' + (launchError?.code ? ' · ' + launchError.code : '') + '，请确认镜像已更新且节点类型受支持');
        if (await probe(port)) break;
        await delay(100);
      }
      if (Date.now() >= deadline) throw proxyError('SS 客户端启动超时，请检查运行日志');
      const identity = createHash('sha256').update(node.normalized).digest('hex');
      return await read('http://' + user + ':' + password + '@127.0.0.1:' + port, identity);
    } catch (error) {
      if (stderr) {
        let detail = stderr;
        for (const secret of localSecrets.filter(Boolean)) detail = detail.split(secret).join('[redacted]');
        error.fetchDetails = { ...error.fetchDetails, proxyType: 'shadowsocks', proxyClientError: detail };
      }
      throw error;
    } finally {
      try {
        await stop(child);
        if (directory) await fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      } finally { release(); }
    }
  };
}
