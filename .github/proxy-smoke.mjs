import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = process.cwd();
const { createShadowsocksBridge, buildShadowsocksUrl, parseShadowsocks, SHADOWSOCKS_METHODS } = await import(pathToFileURL(path.join(root, 'lib/shadowsocks.js')));
const { createSourceFetcher } = await import(pathToFileURL(path.join(root, 'lib/source-fetch.js')));
const { createBrowserSource } = await import(pathToFileURL(path.join(root, 'lib/browser-source.js')));
const { createProxyTester } = await import(pathToFileURL(path.join(root, 'lib/proxy-connectivity.js')));
const dataRoot = process.env.DATA_DIR || tmpdir();
const dataDir = await fs.mkdtemp(path.join(dataRoot, 'ss-smoke-'));
const listen = srv => new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
const headers = [];
const target = http.createServer((req, res) => {
  headers.push({ ...req.headers, path: req.url });
  if (req.url === '/proxy-probe') { res.setHeader('content-type', 'application/json'); res.end('{"ip":"203.0.113.10"}'); return; }
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
const serverExecutable = process.env.SS_SMOKE_SERVER_EXECUTABLE || '/app/ssserver-test';
const child = spawn(serverExecutable, ['-c', configFile], { windowsHide: true, stdio: 'ignore' });
let spawnError, application;
child.on('error', error => { spawnError = error; });
try {
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(spawnError, undefined);
  assert.equal(child.exitCode, null);
  const bridge = createShadowsocksBridge({ dataDir });
  const read = createSourceFetcher({ browserFetch: createBrowserSource({ dataDir }) });
  const node = buildShadowsocksUrl({server:'127.0.0.1',port:ssPort,method:'aes-256-gcm',password:'local-smoke-password'});
  const testProxy = createProxyTester({ withProxy: bridge, urls: ['http://127.0.0.1:' + targetPort + '/proxy-probe'] });
  const verified = await testProxy(node);
  assert.equal(verified.ok, true);
  assert.equal(verified.ip, '203.0.113.10');
  assert.equal(verified.fetch.proxyType, 'shadowsocks');
  assert.equal(JSON.stringify(verified).includes('local-smoke-password'), false);
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
  assert.equal((await fs.readdir(path.join(process.env.MONITOR_TEMP_DIR || dataDir, 'proxy-tmp'))).length, 0);
  // Exercise the same save endpoint as the form, with a real encrypted route.
  const appReservation = http.createServer(), appPort = await listen(appReservation);
  await new Promise(resolve => appReservation.close(resolve));
  const appBase = 'http://127.0.0.1:' + appPort;
  application = spawn(process.execPath, ['server.js'], {cwd:root,windowsHide:true,stdio:'ignore',env:{
    ...process.env,DATA_DIR:path.join(dataDir,'application'),HOST:'127.0.0.1',PORT:String(appPort),SIGNUP_CODE:'',
    RESEND_API_KEY:'',MAIL_FROM:'',MONITOR_BROWSER_ENABLED:'0',MONITOR_PROXY_TEST_URL:'http://127.0.0.1:'+targetPort+'/proxy-probe'
  }});
  application.on('error', error => { spawnError = error; });
  let appReady = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(appBase+'/api/auth/status')).ok) { appReady = true; break; } } catch {}
    if (spawnError || application.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve,50));
  }
  assert.ok(appReady,'Real SS API application must start');
  const registration = await fetch(appBase+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'ss-api-smoke',password:'local-smoke-registration-password'})});
  assert.equal(registration.status,201);
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  let savedState;
  for (const [index, method] of SHADOWSOCKS_METHODS.entries()) {
    const password = method.startsWith('2022-') ? Buffer.alloc(method.includes('aes-128') ? 16 : 32, 251).toString('base64') : '测试仿密码+/?:@';
    const reservation = http.createServer(), port = await listen(reservation);
    await new Promise(resolve => reservation.close(resolve));
    const cipherFile = path.join(dataDir, method + '.json');
    await fs.writeFile(cipherFile, JSON.stringify({server:'127.0.0.1',server_port:port,method,password,mode:'tcp_only',timeout:10,runtime:{mode:'single_thread'}}), {mode:0o600});
    let cipherOutput = '', launchError;
    const server = spawn(serverExecutable, ['-c', cipherFile], { windowsHide:true, stdio:['ignore','ignore','pipe'] });
    server.stderr.on('data', chunk => { cipherOutput = (cipherOutput + chunk.toString()).slice(-4000); });
    server.on('error', error => { launchError = error; });
    try {
      await new Promise(resolve => setTimeout(resolve,300));
      assert.equal(launchError,undefined,method+' server must start');
      assert.equal(server.exitCode,null,method+' server must run: '+cipherOutput.split(password).join('[redacted]'));
      const generated = buildShadowsocksUrl({server:'127.0.0.1',port,method,password});
      const encoded = method.startsWith('2022-') ? generated : 'ss://' + Buffer.from(method+':'+password).toString('base64') + '@127.0.0.1:' + port + '/?plugin=&unsupported=exporter@client#matrix';
      assert.equal(parseShadowsocks(encoded).normalized,generated);
      const report = await createProxyTester({withProxy:bridge,urls:['http://127.0.0.1:'+targetPort+'/proxy-probe']})(encoded);
      assert.equal(report.ip,'203.0.113.10');
      const body = index % 2 ? {shadowsocks:{server:'127.0.0.1',port,method,password},name:method} : {proxyUrl:encoded,name:method};
      const response = await fetch(appBase+'/api/source-proxies',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)});
      savedState = await response.json();
      assert.equal(response.status,201,method+' add endpoint failed: '+JSON.stringify(savedState).split(password).join('[redacted]'));
      const profile = savedState.settings.sourceProxies.find(item => item.name === method);
      assert.ok(profile,method+' must be saved in the proxy list');
      assert.equal(profile.test.ip,'203.0.113.10');
      assert.equal(profile.endpoint,'ss://127.0.0.1:'+port);
      assert.equal(savedState.settings.hasSourceProxy,false,'Adding a profile must preserve the current default route');
      assert.equal(JSON.stringify(savedState).includes(password),false,'Saved public state must hide node passwords');
      console.log('PASS real encrypted SS link import, exit-IP probe and add API: '+method);
    } finally {
      if (server.pid && server.exitCode === null && server.signalCode === null) {
        const closed = new Promise(resolve => server.once('close',resolve));
        server.kill(); await closed;
      }
    }
  }
  assert.equal((await fs.readdir(path.join(process.env.MONITOR_TEMP_DIR || dataDir, 'proxy-tmp'))).length, 0);
  assert.equal(savedState.settings.sourceProxies.length,SHADOWSOCKS_METHODS.length);
  const stateResponse = await fetch(appBase+'/api/state',{headers:{cookie}});
  assert.equal((await stateResponse.json()).settings.sourceProxies.length,SHADOWSOCKS_METHODS.length);
  assert.equal((await fs.readdir(path.join(process.env.MONITOR_TEMP_DIR || path.join(dataDir,'application'), 'proxy-tmp'))).length,0);
  console.log('Real Shadowsocks add API, exit-IP validation, HTTP/browser reads, cross-read cookies, account isolation, credential isolation and temporary cleanup passed.');
} finally {
  if (application?.pid && application.exitCode === null && application.signalCode === null) {
    const closed = new Promise(resolve => application.once('close',resolve));
    application.kill(); await closed;
  }
  const closed = new Promise(resolve => child.once('close', resolve));
  if (child.pid && child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
  target.closeAllConnections(); await new Promise(resolve => target.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
