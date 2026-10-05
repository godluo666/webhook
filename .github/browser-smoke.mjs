import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { createBrowserSource } = await import(pathToFileURL(path.join(process.cwd(), 'lib/browser-source.js')));
const dataRoot = process.env.DATA_DIR || path.join(process.cwd(), 'release', 'browser-smoke-data');
await fs.mkdir(dataRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(dataRoot, 'smoke-'));
const originAuth = [], proxyAuth = [];
let originAuthAttempts = 0;
const server = http.createServer((req, res) => {
  originAuth.push(req.headers.authorization);
  if (req.url === '/json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ stock: 3, cookie: req.headers.cookie || '' })); return; }
  if (req.url === '/auth') { originAuthAttempts++; res.writeHead(401, { 'www-authenticate': 'Basic realm="origin-site"' }); res.end('<html><body>Login required</body></html>'); return; }
  res.setHeader('content-type', 'text/html');
  res.setHeader('set-cookie', 'session=source-cookie; Path=/; HttpOnly');
  res.end('<html><body><p id="stock">Loading</p><script>setTimeout(()=>document.getElementById("stock").textContent="READY-STOCK",100)</script></body></html>');
});
const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
const port = await listen(server);
const expectedAuth = 'Basic ' + Buffer.from('proxy-user:proxy-secret').toString('base64');
const sockets = new Set();
const proxy = http.createServer((req, res) => {
  proxyAuth.push(req.headers['proxy-authorization']);
  if (req.headers['proxy-authorization'] !== expectedAuth) { res.writeHead(407, { 'proxy-authenticate': 'Basic realm="monitor-proxy"' }); res.end(); return; }
  let target;
  try { target = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
  if (target.hostname !== '127.0.0.1' || target.port !== String(port)) { res.writeHead(403); res.end(); return; }
  const headers = { ...req.headers }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
  const upstream = http.request(target, { method: req.method, headers }, (response) => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
  upstream.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
proxy.on('connect', (_req, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
proxy.on('connection', (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
const proxyPort = await listen(proxy);
try {
  const read = createBrowserSource({ dataDir });
  const base = 'http://127.0.0.1:' + port;
  const html = await read(base, { userId: 'smoke-account' });
  assert.match(html.body, /<p id="stock">READY-STOCK<\/p>/);
  const json = await read(base + '/json', { userId: 'smoke-account', expectsJson: true });
  assert.equal(JSON.parse(json.body).stock, 3);
  assert.match(JSON.parse(json.body).cookie, /session=source-cookie/);
  const other = await read(base + '/json', { userId: 'another-account', expectsJson: true });
  assert.equal(JSON.parse(other.body).cookie, '');
  const proxyUrl = 'http://proxy-user:proxy-secret@127.0.0.1:' + proxyPort;
  const proxied = await read(base + '/json', { userId: 'smoke-account', proxyUrl, expectsJson: true });
  assert.equal(JSON.parse(proxied.body).cookie, '');
  assert.ok(proxyAuth.includes(expectedAuth), 'Browser did not authenticate with the selected proxy');
  try { await read(base + '/auth', { userId: 'smoke-account', proxyUrl }); } catch { /* origin authentication can fail navigation */ }
  assert.ok(originAuthAttempts > 0);
  assert.ok(originAuth.every((header) => !header), 'Origin received proxy credentials');
  const files = await fs.readdir(path.join(process.env.MONITOR_TEMP_DIR || dataDir, 'browser-tmp'));
  assert.equal(files.some((name) => name.startsWith('source-')), false);
  console.log('Browser JavaScript/JSON, proxy-only authentication, cookie isolation and profile cleanup passed.');
} finally {
  server.closeAllConnections(); for (const socket of sockets) socket.destroy();
  await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => proxy.close(resolve))]);
  if (path.dirname(dataDir) === dataRoot) await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
