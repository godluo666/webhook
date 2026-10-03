import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { parseShadowsocks, createShadowsocksBridge } from '../lib/shadowsocks.js';
import { validateSourceProxy, proxyEndpoint, redactProxy } from '../lib/source-proxy.js';

test('SS 常见分享格式、特殊字符与 IPv6 解析，插件和错误参数提示', () => {
  const password = 'secret:@?# 中文';
  const node = 'ss://' + Buffer.from('aes-256-gcm:' + password).toString('base64url') + '@[::1]:8388#test';
  const result = parseShadowsocks(node);
  assert.equal(result.password, password);
  assert.equal(result.server, '::1');
  assert.equal(proxyEndpoint(node), 'ss://[::1]:8388');
  assert.deepEqual(parseShadowsocks(result.normalized), result);
  assert.equal(parseShadowsocks('ss://' + Buffer.from('aes-256-gcm:' + password + '@host.example:8388').toString('base64')).password, password);
  assert.equal(validateSourceProxy(node), result.normalized);
  assert.equal(redactProxy('password=' + password + ' node=' + node, node).includes(password), false);
  const key = Buffer.alloc(32, 1).toString('base64');
  assert.equal(parseShadowsocks('ss://2022-blake3-aes-256-gcm:' + encodeURIComponent(key) + '@host.example:8388').password, key);
  assert.throws(() => parseShadowsocks(node.split('#')[0] + '/?plugin=v2ray-plugin'), /额外插件/);
  for (const bad of ['ss://garbage', 'ss://aes-256-gcm:secret@host:0', 'ss://aes-256-gcm:secret@host:70000', 'ss://aes-256-gcm:secret@host:8388/path', 'ss://2022-blake3-aes-256-gcm:short@host:8388']) assert.throws(() => parseShadowsocks(bad));
});

test('SS 读取使用私有配置和随机本地认证，失败后结束进程并清理', async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'radar-ss-bridge-'));
  const launches = [], clients = [];
  const bridge = createShadowsocksBridge({ dataDir, executable: 'mock-sslocal', spawnClient: (_executable, args, options) => {
    launches.push({ args, options });
    const script = "const fs=require('fs'),http=require('http');const c=JSON.parse(fs.readFileSync(process.argv[1]));const l=c.locals[0];const a=JSON.parse(fs.readFileSync(l.http_auth_config_path)).basic.users[0];http.createServer((req,res)=>{res.writeHead(req.headers['proxy-authorization']==='Basic '+Buffer.from(a.user_name+':'+a.password).toString('base64')?200:407);res.end('mock bridge');}).listen(l.local_port,l.local_address);";
    const client = spawn(process.execPath, ['-e', script, args[1]], options); clients.push(client); return client;
  } });
  const node = 'ss://aes-256-gcm:private-node-secret@host.example:8388';
  try {
    let identity, firstPassword;
    const status = (url, headers = {}) => new Promise((resolve, reject) => { http.get(url, { headers }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject); });
    await bridge(node, async (url, key) => {
      identity = key;
      const local = new URL(url);
      assert.equal(local.hostname, '127.0.0.1');
      assert.ok(local.password); firstPassword = local.password;
      const auth = Buffer.from(local.username + ':' + local.password).toString('base64');
      assert.equal(await status(local.origin, { 'proxy-authorization': 'Basic ' + auth }), 200);
      assert.equal(await status(local.origin), 407);
      const config = JSON.parse(await fs.readFile(launches[0].args[1]));
      assert.equal(config.password, 'private-node-secret');
      assert.equal(config.locals[0].protocol, 'http');
      assert.equal(JSON.stringify(launches).includes('private-node-secret'), false);
    });
    await assert.rejects(bridge(node, async (url, key) => {
      assert.equal(key, identity);
      assert.notEqual(new URL(url).password, firstPassword);
      throw new Error('target request failed');
    }), /target request failed/);
    assert.equal((await fs.readdir(path.join(dataDir, 'proxy-tmp'))).length, 0);
    assert.ok(clients.every(client => client.exitCode !== null || client.signalCode !== null));
    const unavailable = createShadowsocksBridge({ dataDir, executable: '' });
    await assert.rejects(unavailable(node, () => {}), error => error.code === 'SOURCE_PROXY_UNAVAILABLE');
  } finally { for (const client of clients) client.kill(); await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }); }
});

test('SS 客户端启动失败保留诊断但隐藏节点密码，并清理配置', async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'radar-ss-failure-'));
  const bridge = createShadowsocksBridge({ dataDir, executable: 'mock-failure', spawnClient: (_executable, args, options) => spawn(process.execPath, ['-e', "const fs=require('fs');const c=JSON.parse(fs.readFileSync(process.argv[1]));console.error('mock startup failed with '+c.password);process.exit(2);", args[1]], options) });
  try {
    await assert.rejects(bridge('ss://aes-256-gcm:hidden-node-password@host.example:8388', () => assert.fail('must not read')), error => {
      assert.equal(error.code, 'SOURCE_PROXY_CLIENT');
      assert.match(error.fetchDetails.proxyClientError, /mock startup failed/);
      assert.equal(JSON.stringify(error.fetchDetails).includes('hidden-node-password'), false);
      return true;
    });
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'proxy-tmp')), []);
  } finally { await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }); }
});
