import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = process.cwd();
const { createShadowsocksBridge } = await import(pathToFileURL(path.join(root, 'lib/shadowsocks.js')));
const { createSourceFetcher } = await import(pathToFileURL(path.join(root, 'lib/source-fetch.js')));
const { createBrowserSource } = await import(pathToFileURL(path.join(root, 'lib/browser-source.js')));
const dataRoot = process.env.DATA_DIR;
const dataDir = await fs.mkdtemp(path.join(dataRoot, 'ss-smoke-'));
const listen = srv => new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
const headers = [];
const target = http.createServer((req, res) => {
  headers.push({ ...req.headers, path: req.url });
  if (req.url !== '/') { res.writeHead(204); res.end(); return; }
  res.setHeader('content-type', 'text/html');
  res.setHeader('set-cookie', 'sourceSession=ss-cookie; Path=/; HttpOnly');
  res.end('<html><body><div id="stock">Loading</div><script>setTimeout(()=>document.getElementById("stock").textContent="STOCK-READY",50)</script></body></html>');
});
const targetPort = await listen(target);
const reservation = http.createServer();
const ssPort = await listen(reservation);
await new Promise(resolve => reservation.close(resolve));
const configFile = path.join(dataDir, 'server.json');
await fs.writeFile(configFile, JSON.stringify({ server: '127.0.0.1', server_port: ssPort, method: 'aes-256-gcm', password: 'local-smoke-password', mode: 'tcp_only', timeout: 10, runtime: { mode: 'single_thread' } }), { mode: 0o600 });
const child = spawn('/app/ssserver-test', ['-c', configFile], { stdio: 'ignore' });
let spawnError;
child.on('error', error => { spawnError = error; });
try {
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(spawnError, undefined);
  assert.equal(child.exitCode, null);
  const bridge = createShadowsocksBridge({ dataDir });
  const read = createSourceFetcher({ browserFetch: createBrowserSource({ dataDir }) });
  const node = 'ss://aes-256-gcm:local-smoke-password@127.0.0.1:' + ssPort;
  const readThrough = (mode, userId = 'first-user') => bridge(node, (proxyUrl, proxyIdentity) => read('http://127.0.0.1:' + targetPort, { proxyUrl, proxyIdentity, mode, userId }));
  const httpResult = await readThrough('http');
  assert.equal(httpResult.status, 200);
  assert.equal(httpResult.metadata.route, 'proxy');
  const first = await readThrough('browser');
  assert.match(first.body, /STOCK-READY/);
  await readThrough('browser');
  assert.ok(headers.some(item => item.cookie?.includes('sourceSession=ss-cookie')));
  const before = headers.length;
  await readThrough('browser', 'other-user');
  assert.equal(headers.slice(before).some(item => item.path === '/' && item.cookie?.includes('sourceSession=ss-cookie')), false);
  assert.equal(headers.some(item => item.authorization || item['proxy-authorization']), false);
  assert.equal((await fs.readdir(path.join(dataDir, 'proxy-tmp'))).length, 0);
  console.log('Real Shadowsocks HTTP/browser reads, cross-read cookies, account isolation, credential isolation and temporary cleanup passed.');
} finally {
  const closed = new Promise(resolve => child.once('close', resolve));
  if (child.pid && child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
  target.closeAllConnections(); await new Promise(resolve => target.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
