import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantMessages } from '../lib/assistant.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startApp(dataDir) {
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, RESEND_API_KEY: '', MAIL_FROM: '', SIGNUP_CODE: '', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir },
    stdio: 'ignore'
  });
  const base = 'http://127.0.0.1:' + port;
  let cookie = '';
  const request = async (endpoint, method = 'GET', body) => {
    const response = await fetch(base + endpoint, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  };
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const status = await request('/api/auth/status');
      if (status.status === 200) {
        const registered = await request('/api/auth/register', 'POST', { username: 'frequency-user', password: 'frequency-password-123' });
        assert.equal(registered.status, 201, JSON.stringify(registered.data));
        return { request, child };
      }
    } catch (error) {
      if (child.exitCode !== null) throw error;
    }
    await delay(50);
  }
  child.kill();
  throw new Error('测试应用未能启动');
}

function monitorOf(data, id) {
  const monitor = data.monitors.find(item => item.id === id);
  assert.ok(monitor, '监控任务仍应存在');
  return monitor;
}

test('AI 周期提示支持秒、小数分钟和创建后修改', () => {
  const system = assistantMessages({ instruction: '每30秒检查一次', timeZone: 'Asia/Shanghai', turns: [] })[0].content;
  assert.match(system, /30秒.*intervalMinutes:0\.5/);
  assert.match(system, /允许小数/);
  assert.match(system, /48小时为2880分钟/);
  assert.match(system, /创建后用户可以随时修改检测周期/);
  assert.doesNotMatch(system, /service\/log周期可为1到1440分钟，其他5到1440/);
});

test('30秒监控可创建、随时改周期，AI 小数周期与实际调度保持一致', async t => {
  let sourceRequests = 0;
  const aiCalls = [];
  const source = http.createServer(async (req, res) => {
    if (req.url === '/source') {
      sourceRequests++;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<p>healthy</p>');
      return;
    }
    if (req.url === '/v1/chat/completions') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const call = JSON.parse(raw);
      aiCalls.push(call);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        status: 'ready', message: '每30秒检查一次，创建后可以随时调整。',
        monitor: {
          kind: 'generated', label: '30秒检测', url: 'http://127.0.0.1:' + source.address().port + '/source',
          intervalMinutes: 0.5, fetch: { mode: 'http', proxy: 'default' },
          plan: { sourceType: 'html', mode: 'contains', initial: 'baseline', keyword: 'down' }
        }
      }) } }] }));
      return;
    }
    if (req.url === '/hook') { res.end('ok'); return; }
    res.writeHead(404); res.end();
  });
  const sourcePort = await listen(source);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'radar-frequency-'));
  let app;
  try {
    app = await startApp(dataDir);
    const { request } = app;
    const saved = await request('/api/settings', 'PUT', {
      aiBaseUrl: 'http://127.0.0.1:' + sourcePort + '/v1', aiModel: 'frequency-test', aiKey: 'frequency-ai-key',
      webhooks: [{ id: 'hook', name: '测试渠道', url: 'http://127.0.0.1:' + sourcePort + '/hook', format: 'generic' }]
    });
    assert.equal(saved.status, 200);
    const rule = {
      kind: 'webpage', label: '网页30秒检测', url: 'http://127.0.0.1:' + sourcePort + '/source',
      keyword: 'down', mode: 'contains', intervalMinutes: 0.5, fetch: { mode: 'http' }, webhookIds: ['hook']
    };
    let id;

    await t.test('创建30秒周期并保留原值', async () => {
      const created = await request('/api/monitors', 'POST', rule);
      assert.equal(created.status, 201, JSON.stringify(created.data));
      const monitor = created.data.monitors[0];
      id = monitor.id;
      assert.equal(monitor.intervalMinutes, 0.5);
      assert.equal(monitor.baselined, true);
      assert.ok(monitor.lastCheckAt);
      const paused = await request('/api/monitors/' + id, 'PATCH', { enabled: false });
      assert.equal(paused.status, 200);
    });

    await t.test('只修改周期不重置基线或检查时间，也不额外读取网站', async () => {
      const before = monitorOf((await request('/api/state')).data, id);
      const readsBefore = sourceRequests;
      for (const intervalMinutes of [1.25, 0.25, 0.5]) {
        const updated = await request('/api/monitors/' + id, 'PATCH', { rule: { intervalMinutes } });
        assert.equal(updated.status, 200, JSON.stringify(updated.data));
        const after = monitorOf(updated.data, id);
        assert.equal(after.intervalMinutes, intervalMinutes);
        assert.equal(after.baselined, before.baselined);
        assert.deepEqual(after.snapshot, before.snapshot);
        assert.equal(after.lastCheckAt, before.lastCheckAt);
        assert.deepEqual(after.pendingNotifications, before.pendingNotifications);
      }
      assert.equal(sourceRequests, readsBefore);
    });

    await t.test('AI 解析带来源和待补来源的30秒草稿均保留0.5分钟', async () => {
      const ready = await request('/api/parse', 'POST', {
        instruction: '每30秒检查一次，出现down时通知', sourceUrl: rule.url
      });
      assert.equal(ready.status, 200, JSON.stringify(ready.data));
      assert.equal(ready.data.status, 'ready');
      assert.equal(ready.data.monitor.intervalMinutes, 0.5);
      assert.equal(ready.data.monitor.fetch.mode, 'http');
      const draft = await request('/api/parse', 'POST', { instruction: '每30秒检查一次，出现down时通知，地址稍后补充' });
      assert.equal(draft.status, 200, JSON.stringify(draft.data));
      assert.equal(draft.data.status, 'draft');
      assert.equal(draft.data.monitor.url, '');
      assert.equal(draft.data.monitor.intervalMinutes, 0.5);
      assert.equal(draft.data.monitor.fetch.mode, 'http');
      assert.equal(aiCalls.length, 2);
      assert.match(aiCalls[0].messages[0].content, /30秒.*intervalMinutes:0\.5/);
    });

    await t.test('非法周期明确拒绝，已有规则保持原值', async () => {
      const before = monitorOf((await request('/api/state')).data, id);
      for (const intervalMinutes of [0, -1, 1 / 120, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, 'bad-number']) {
        const created = await request('/api/monitors', 'POST', { ...rule, intervalMinutes });
        assert.equal(created.status, 400, JSON.stringify(created.data));
        assert.match(created.data.error, /周期/);
        const edited = await request('/api/monitors/' + id, 'PATCH', { rule: { intervalMinutes } });
        assert.equal(edited.status, 400, JSON.stringify(edited.data));
        assert.match(edited.data.error, /周期/);
      }
      const afterState = (await request('/api/state')).data;
      assert.equal(afterState.monitors.length, 1);
      const after = monitorOf(afterState, id);
      assert.equal(after.intervalMinutes, before.intervalMinutes);
      assert.deepEqual(after.snapshot, before.snapshot);
      assert.equal(after.lastCheckAt, before.lastCheckAt);
    });

    await t.test('生成的服务监控同样可使用30秒周期', async () => {
      const created = await request('/api/monitors', 'POST', {
        kind: 'generated', label: '服务30秒检测', url: rule.url, intervalMinutes: 0.5,
        plan: { sourceType: 'service', mode: 'unavailable', initial: 'baseline', failureThreshold: 1 }, webhookIds: ['hook']
      });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      assert.equal(created.data.monitors[0].intervalMinutes, 0.5);
      const paused = await request('/api/monitors/' + created.data.monitors[0].id, 'PATCH', { enabled: false });
      assert.equal(paused.status, 200);
    });

    await t.test('48小时周期可创建和后续修改，不受旧24小时上限限制', async () => {
      const before = monitorOf((await request('/api/state')).data, id);
      const updated = await request('/api/monitors/' + id, 'PATCH', { rule: { intervalMinutes: 2880 } });
      assert.equal(updated.status, 200, JSON.stringify(updated.data));
      const after = monitorOf(updated.data, id);
      assert.equal(after.intervalMinutes, 2880);
      assert.deepEqual(after.snapshot, before.snapshot);
      assert.equal(after.lastCheckAt, before.lastCheckAt);
      const created = await request('/api/monitors', 'POST', { ...rule, label: '48小时检测', intervalMinutes: 2880 });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      const longer = created.data.monitors[0];
      assert.equal(longer.intervalMinutes, 2880);
      assert.equal(longer.baselined, true);
      const paused = await request('/api/monitors/' + longer.id, 'PATCH', { enabled: false });
      assert.equal(paused.status, 200);
    });

    await t.test('按秒周期会自动复查，不受旧20秒调度限制', async () => {
      const before = monitorOf((await request('/api/state')).data, id);
      const readsBefore = sourceRequests;
      const changed = await request('/api/monitors/' + id, 'PATCH', { rule: { intervalMinutes: 1 / 60 }, enabled: true });
      assert.equal(changed.status, 200, JSON.stringify(changed.data));
      assert.equal(monitorOf(changed.data, id).lastCheckAt, before.lastCheckAt);
      const deadline = Date.now() + 5000;
      let after = before;
      while (Date.now() < deadline) {
        await delay(100);
        after = monitorOf((await request('/api/state')).data, id);
        if (after.lastCheckAt !== before.lastCheckAt) break;
      }
      assert.notEqual(after.lastCheckAt, before.lastCheckAt, '应在5秒内自动重新检查');
      assert.ok(sourceRequests > readsBefore, '自动检查应实际读取来源');
      assert.equal(after.intervalMinutes, 1 / 60);
      assert.deepEqual(after.snapshot, before.snapshot);
      const paused = await request('/api/monitors/' + id, 'PATCH', { enabled: false });
      assert.equal(paused.status, 200);
    });
  } finally {
    if (app?.child && app.child.exitCode === null) {
      const stopped = new Promise(resolve => app.child.once('exit', resolve));
      app.child.kill();
      await stopped;
    }
    source.closeAllConnections();
    await new Promise(resolve => source.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
