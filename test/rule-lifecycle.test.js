import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruleSignature } from '../lib/monitor-rule.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
async function fixture(t) {
  let stock = false, price = 300, selector = 'stock', invalid = false, health = 200, goal = null;
  let counts = [0,0,0,0,0], english = true, aiResponse = null;
  const messages = [], calls = [];
  const source = http.createServer(async (req, res) => {
    if (req.url === '/product') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><head><title>Switch</title></head><body><h1>Nintendo Switch</h1><main><span class="' + selector + '">' + (invalid ? 'Loading' : stock ? 'In Stock' : 'Sold Out') + '</span><span class="price">￥' + price + '</span><button id="buy"' + (stock ? '' : ' disabled') + '>' + (invalid ? 'Loading' : stock ? 'Add To Cart' : 'Sold Out') + '</button></main><script>parent.dangerous=true</script><a href="javascript:alert(1)" onclick="alert(1)">unsafe link</a></body></html>');
      return;
    }
    if (req.url === '/models') {
      res.setHeader('content-type', 'text/html');
      res.end('<html lang="' + (english ? 'en' : 'zh') + '"><body><h1>TRI</h1><main id="products">' + ['Basic','Core','Pro','Elite','Ultra'].map((name,i) => '<article class="product" id="product' + i + '"><h3>TRI.' + name + '</h3><a href="/cart.php?a=add&pid=' + i + '">Order Now</a><small class="qty">' + counts[i] + (english ? ' Available' : '可用') + '</small></article>').join('') + '</main></body></html>'); return;
    }
    if (req.url === '/health') { res.statusCode = health; res.end('health'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.url === '/hook') { messages.push(JSON.parse(raw)); res.end('ok'); return; }
    if (req.url === '/v1/chat/completions') {
      calls.push(JSON.parse(raw));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(aiResponse || { status: 'ready', message: '已分析商品与条件。', goal: goal || { type: 'product_stock', condition: { operator: 'transition' } } }) } }] }));
      return;
    }
    res.statusCode = 404; res.end('unknown');
  });
  const sourcePort = await listen(source), url = 'http://127.0.0.1:' + sourcePort;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'radar-lifecycle-'));
  const reservation = http.createServer(), appPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, RESEND_API_KEY: '', MAIL_FROM: '', SIGNUP_CODE: '', MONITOR_BROWSER_ENABLED: '0', DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(appPort) } });
  const base = 'http://127.0.0.1:' + appPort;
  let cookie = '';
  const request = async (endpoint, method = 'GET', body, expected = 200) => {
    const response = await fetch(base + endpoint, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  };
  for (let i = 0; i < 100; i++) {
    try { await request('/api/auth/status'); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  t.after(async () => {
    child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await new Promise(resolve => source.close(resolve));
    const resolved = path.resolve(dataDir);
    assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('radar-lifecycle-'));
    await rm(resolved, { recursive: true, force: true });
  });
  await request('/api/auth/register', 'POST', { username: 'lifecycle-user', password: 'lifecycle-password-123' }, 201);
  await request('/api/settings', 'PUT', { aiBaseUrl: url + '/v1', aiModel: 'test', aiKey: 'private-ai-key', webhooks: [{ id: 'hook', name: '我的通知', url: url + '/hook', format: 'generic', enabled: true }] });
  return {
    request, url, dataDir, messages, calls,
    setStock(value) { stock = value; }, setPrice(value) { price = value; }, setSelector(value) { selector = value; },
    setCounts(value) { counts = value; }, setEnglish(value) { english = value; }, setResponse(value) { aiResponse = value; },
    setInvalid(value) { invalid = value; }, setHealth(value) { health = value; }, setGoal(value) { goal = value; }
  };
}
test('商品链接→AI目标→真实分析→自动验证→创建→补货通知→检测详情', async t => {
  const f = await fixture(t);
  const draft = await f.request('/api/parse', 'POST', { instruction: '帮我监控这个商品什么时候有货', sourceUrl: f.url + '/product' });
  assert.equal(draft.monitor.kind, 'unified');
  assert.equal(draft.monitor.type, 'product_stock');
  assert.equal(draft.monitor.interval, 30);
  assert.equal(draft.monitor.last_test_result.passed, true);
  assert.equal(draft.monitor.last_test_result.current_value, 'out_of_stock');
  assert.ok(f.calls[0].messages.some(m => m.content.includes('程序实际读取的页面分析')));
  assert.equal((await f.request('/api/state')).monitors.length, 0);
  const created = (await f.request('/api/monitors', 'POST', { ...draft.monitor, webhookIds: ['hook'] }, 201)).monitors[0];
  assert.ok(created.next_run_time);
  assert.equal(f.messages.length, 0);
  f.setStock(true);
  const checked = await f.request('/api/monitors/' + created.id + '/check', 'POST');
  assert.equal(checked.check.triggered, true);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].title, /库存变化提醒/);
  assert.match(f.messages[0].message, /无货 → 有货/);
  assert.match(f.messages[0].message, /Nintendo Switch/);
  await f.request('/api/monitors/' + created.id + '/check', 'POST');
  assert.equal(f.messages.length, 1); // transition conditions require a new stock change
  const logs = await f.request('/api/monitors/' + created.id + '/logs');
  assert.ok(logs.logs.some(log => log.raw?.current_value === 'in_stock' && log.raw?.triggered === true));
});
test('验证失败不保存或启用；伪造测试结果不能绕过正式验证', async t => {
  const f = await fixture(t);
  const draft = await f.request('/api/analyze', 'POST', { type: 'product_stock', url: f.url + '/product' });
  f.setInvalid(true);
  await f.request('/api/monitors', 'POST', { ...draft.monitor, last_test_result: { passed: true }, confidence: 1, webhookIds: ['hook'] }, 400);
  assert.equal((await f.request('/api/state')).monitors.length, 0);
  await f.request('/api/parse', 'POST', { instruction: '商品什么时候有货', sourceUrl: f.url + '/product' }, 400);
  assert.equal((await f.request('/api/state')).monitors.length, 0);
});
test('AI改300为200更新原任务；失败修改、暂停状态、历史、通知和URL受到保护', async t => {
  const f = await fixture(t);
  const priceDraft = await f.request('/api/analyze', 'POST', { type: 'price_change', condition: { operator: 'lt', value: 300 }, url: f.url + '/product' });
  const original = (await f.request('/api/monitors', 'POST', { ...priceDraft.monitor, notification: { title: '我的价格通知', body: '{{details}}' }, webhookIds: ['hook'] }, 201)).monitors[0];
  const paused = (await f.request('/api/monitors/' + original.id, 'PATCH', { enabled: false })).monitors[0];
  f.setGoal({ type: 'price_change', condition: { value: 200 } });
  const draft = await f.request('/api/parse', 'POST', { monitorId: paused.id, expectedRevision: paused.revision, instruction: '改成低于200提醒' });
  assert.equal(draft.monitor.condition.operator, 'lt');
  assert.equal(draft.monitor.condition.value, 200);
  assert.equal(draft.monitor.url, paused.url);
  assert.deepEqual(draft.monitor.notification, paused.notification);
  const updated = (await f.request('/api/monitors/' + paused.id, 'PATCH', { rule: draft.monitor, expectedRevision: paused.revision })).monitors[0];
  assert.equal(updated.id, original.id);
  assert.equal(updated.enabled, false);
  assert.deepEqual(updated.webhookIds, original.webhookIds);
  assert.equal(updated.createdAt, original.createdAt);
  const before = await f.request('/api/state');
  await f.request('/api/monitors/' + updated.id, 'PATCH', { rule: { target_element: { selector: '.never-exists' } }, expectedRevision: updated.revision }, 400);
  assert.deepEqual((await f.request('/api/state')).monitors, before.monitors);
  assert.ok((await f.request('/api/monitors/' + updated.id + '/logs')).logs.length > 0);
  f.setPrice(199);
  await f.request('/api/monitors/' + updated.id + '/check', 'POST');
  assert.match(f.messages[0].message, /300 → 199/);
});
test('页面结构变化自动产生已验证修复建议，确认后更新原ID且保留通知配置', async t => {
  const f = await fixture(t);
  const draft = await f.request('/api/analyze', 'POST', { type: 'product_stock', url: f.url + '/product' });
  // Select the stock label rather than the independent purchase button.
  const original = (await f.request('/api/monitors', 'POST', { ...draft.monitor, target_element: { selector: '.stock', label: '库存区域' }, detection_method: 'dom', extraction_rule: { kind: 'stock' }, webhookIds: ['hook'] }, 201)).monitors[0];
  f.setSelector('inventory-status');
  const failed = (await f.request('/api/monitors/' + original.id + '/check', 'POST')).monitors[0];
  assert.equal(failed.status, 'needs_repair');
  assert.ok(failed.repair_suggestion);
  assert.equal(failed.target_element.selector, '.stock');
  assert.deepEqual(failed.snapshot, original.snapshot);
  const proposal = failed.repair_suggestion;
  assert.equal(proposal.rule.last_test_result.passed, true);
  assert.equal(proposal.rule.sourceProxy, undefined);
  const fixed = (await f.request('/api/monitors/' + original.id, 'PATCH', { rule: proposal.rule, expectedRevision: proposal.revision })).monitors[0];
  assert.equal(fixed.id, original.id);
  assert.equal(fixed.status, 'active');
  assert.deepEqual(fixed.notification, original.notification);
  assert.deepEqual(fixed.webhookIds, original.webhookIds);
});
test('选择网页区域生成统一规则，移除脚本、事件、外链与表单；快照账户隔离', async t => {
  const f = await fixture(t);
  const preview = await f.request('/api/element-preview', 'POST', { url: f.url + '/product' });
  assert.doesNotMatch(preview.html, /<script|onclick|javascript:|href="(?!\/picker.css)/);
  const selected = await f.request('/api/select-element', 'POST', { previewId: preview.id, index: 0, type: 'webpage_change' });
  assert.equal(selected.monitor.kind, 'unified');
  assert.ok(selected.monitor.target_element.selector);
  assert.ok(selected.monitor.target_element.xpath);
  assert.equal(selected.monitor.last_test_result.passed, true);
  await f.request('/api/auth/register', 'POST', { username: 'other-user', password: 'other-password-123' }, 201);
  await f.request('/api/select-element', 'POST', { previewId: preview.id, index: 0, type: 'webpage_change' }, 404);
});
test('接口异常统一规则支持可判断的失败状态并按失败阈值推送', async t => {
  const f = await fixture(t);
  f.setGoal({ type: 'api_monitor', condition: { operator: 'unavailable', failure_threshold: 2 } });
  const draft = await f.request('/api/parse', 'POST', { instruction: '接口连续失败2次提醒', sourceUrl: f.url + '/health' });
  const created = (await f.request('/api/monitors', 'POST', { ...draft.monitor, webhookIds: ['hook'] }, 201)).monitors[0];
  f.setHealth(503);
  await f.request('/api/monitors/' + created.id + '/check', 'POST');
  assert.equal(f.messages.length, 0);
  await f.request('/api/monitors/' + created.id + '/check', 'POST');
  assert.equal(f.messages.length, 1);
  const saved = JSON.parse(await readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.ok(saved.users[0].monitors[0].next_run_time);
});

test('旧AI任务可在原ID上升级为经过真实验证的统一库存规则，保留周期、渠道和通知', async t => {
  const f = await fixture(t);
  const notification = { title: '我的补货提醒', body: '{{details}}' };
  const old = (await f.request('/api/monitors', 'POST', { kind: 'generated', label: '我的Switch任务', url: f.url + '/product', intervalMinutes: 2, plan: { sourceType: 'html', mode: 'contains', keyword: 'Sold Out', initial: 'baseline' }, notification, webhookIds: ['hook'] }, 201)).monitors[0];
  const originalLogs = (await f.request('/api/monitors/' + old.id + '/logs')).logs;
  assert.ok(originalLogs.length > 0);
  const draft = await f.request('/api/parse', 'POST', { instruction: '改为监控这个商品什么时候补货', sourceUrl: old.url, editingMonitorId: old.id, draft: old });
  assert.equal(draft.monitor.kind, 'unified');
  assert.equal(draft.monitor.last_test_result.passed, true);
  assert.equal(draft.monitor.interval, 120);
  assert.deepEqual(draft.monitor.notification, notification);
  const saved = (await f.request('/api/monitors/' + old.id, 'PATCH', { rule: draft.monitor, expectedRevision: old.revision || 0 })).monitors[0];
  assert.equal(saved.id, old.id);
  assert.equal(saved.kind, 'unified');
  assert.equal(saved.createdAt, old.createdAt);
  assert.equal(saved.label, old.label);
  assert.deepEqual(saved.webhookIds, ['hook']);
  const logs = await f.request('/api/monitors/' + old.id + '/logs');
  assert.ok(originalLogs.every(before => logs.logs.some(after => after.id === before.id)));
  f.setStock(true);
  await f.request('/api/monitors/' + old.id + '/check', 'POST');
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].title, notification.title);
});

test('用户明确的价格阈值优先于模型输出，保存后的规则仍遵守低于200', async t => {
  const f = await fixture(t);
  f.setGoal({ type: 'price_change', condition: { operator: 'lt', value: 300 } });
  const draft = await f.request('/api/parse', 'POST', { instruction: '价格低于200通知我', sourceUrl: f.url + '/product' });
  assert.equal(draft.monitor.condition.value, 200);
  assert.equal(draft.monitor.last_test_result.passed, true);
  const saved = (await f.request('/api/monitors', 'POST', { ...draft.monitor, webhookIds: ['hook'] }, 201)).monitors[0];
  f.setPrice(250);
  await f.request('/api/monitors/' + saved.id + '/check', 'POST');
  assert.equal(f.messages.length, 0);
  f.setPrice(199);
  await f.request('/api/monitors/' + saved.id + '/check', 'POST');
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].message, /250 → 199/);
});

test('AI把明确库存目标误判为价格时拒绝保存，并要求修正业务目标', async t => {
  const f = await fixture(t);
  f.setGoal({ type: 'price_change', condition: { operator: 'lt', value: 100 } });
  await f.request('/api/parse', 'POST', { instruction: '帮我监控库存什么时候有货', sourceUrl: f.url + '/product' }, 400);
  assert.equal((await f.request('/api/state')).monitors.length, 0);
  assert.ok(f.calls.length >= 2);
  assert.match(f.calls[1].messages.find(m => m.content.includes('上次生成的规则未通过校验')).content, /监控目标与用户需求不一致/);
});

test('五型号中英库存→30秒→推广链接→逐型号通知；模型错误频率和整页判断不会覆盖需求', async t => {
  const f = await fixture(t);
  f.setGoal({ type: 'product_stock', interval: 300, condition: { operator: 'transition' } });
  const instruction = '每30秒监控一次，页面任意型号显示有货就通知我，并附上我的add链接 https://app.vmiss.com/aff.php?aff=5982';
  const draft = await f.request('/api/parse', 'POST', { instruction, sourceUrl: f.url + '/models' });
  assert.equal(draft.monitor.interval, 30);
  assert.equal(draft.monitor.extraction_rule.kind, 'stock_items');
  assert.equal(draft.monitor.condition.operator, 'equals');
  assert.equal(draft.monitor.last_test_result.snapshot.items.length, 5);
  assert.equal(draft.monitor.last_test_result.snapshot.available_count, 0);
  assert.ok(draft.monitor.last_test_result.behavior_tests.length >= 5);
  assert.ok(draft.monitor.last_test_result.behavior_tests.every(test => test.passed));
  assert.ok(draft.monitor.last_test_result.behavior_tests.some(test => /测试5个型号/.test(test.name)));
  assert.match(draft.message, /全部无货/);
  assert.match(draft.message, /30 秒/);
  assert.doesNotMatch(draft.message, /每5分钟|无法读取/);
  assert.ok(draft.monitor.notification.body.includes('https://app.vmiss.com/aff.php?aff=5982'));
  const preview = await f.request('/api/element-preview', 'POST', { rule: draft.monitor, url: draft.monitor.url });
  assert.equal(preview.highlighted, 5);
  assert.match(preview.html, /0 Available/);
  assert.equal(preview.collections.length, 5);
  const selected = await f.request('/api/select-element', 'POST', { previewId: preview.id, index: preview.collections[0].index, type: 'product_stock', scope: 'all_models', rule: draft.monitor });
  assert.equal(selected.monitor.extraction_rule.kind, 'stock_items');
  assert.equal(selected.monitor.last_test_result.snapshot.items.length, 5);
  assert.equal(selected.monitor.interval, 30);
  const original = (await f.request('/api/monitors', 'POST', { ...draft.monitor, webhookIds: ['hook'] }, 201)).monitors[0];
  assert.equal(f.messages.length, 0);
  f.setCounts([0, 1, 0, 0, 0]);
  await f.request('/api/monitors/' + original.id + '/check', 'POST');
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].message, /TRI.Core.*无货 → 有货/);
  assert.match(f.messages[0].message, /https:\/\/app.vmiss.com\/aff.php\?aff=5982/);
  f.setEnglish(false); // A cloud source may change its language while the rule is running.
  f.setCounts([0, 1, 0, 2, 0]);
  await f.request('/api/monitors/' + original.id + '/check', 'POST');
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[1].message, /TRI.Elite.*无货 → 有货/);
  assert.doesNotMatch(f.messages[1].message, /TRI.Core/);
  await f.request('/api/monitors/' + original.id + '/check', 'POST');
  assert.equal(f.messages.length, 2);
  const logs = await f.request('/api/monitors/' + original.id + '/logs');
  assert.ok(logs.logs.some(log => log.raw?.items?.length === 5 && log.raw.triggered_items?.includes('product3')));
  f.setGoal({ type: 'product_stock', interval: 300 });
  const edit = await f.request('/api/parse', 'POST', { monitorId: original.id, instruction: '仅修改任务名称' });
  assert.equal(edit.monitor.interval, 30);
  assert.equal(edit.monitor.extraction_rule.kind, 'stock_items');
  assert.deepEqual(edit.monitor.notification, original.notification);
});
test('旧模型返回整页缺货消失规则仍编译为逐型号库存；有真实证据无需用户粘贴技术样例', async t => {
  const f = await fixture(t);
  f.setResponse({ status: 'ready', message: '不支持30秒，只能每5分钟等整页缺货文字消失', monitor: { kind: 'generated', label: 'TRI补货', intervalMinutes: 5, plan: { sourceType: 'html', mode: 'absent', keyword: '0可用', initial: 'baseline' } } });
  const draft = await f.request('/api/parse', 'POST', { instruction: '每30秒检查，任意套餐补货时通知我', sourceUrl: f.url + '/models' });
  assert.equal(draft.monitor.kind, 'unified');
  assert.equal(draft.monitor.extraction_rule.kind, 'stock_items');
  assert.equal(draft.monitor.interval, 30);
  assert.equal(draft.monitor.condition.operator, 'transition');
  assert.doesNotMatch(draft.message, /不支持|整页缺货文字消失/);
  f.setResponse({ status: 'need_more_info', questions: ['请提供库存字段名和页面样例'] });
  const automatic = await f.request('/api/parse', 'POST', { instruction: '任意型号有货就通知我', sourceUrl: f.url + '/models' });
  assert.equal(automatic.status, 'ready');
  assert.equal(automatic.monitor.last_test_result.passed, true);
});
test('推广链接只用于通知，不会被补充对话误当成监控来源', async t => {
  const f = await fixture(t);
  const draft = await f.request('/api/parse', 'POST', { instruction: '任意商品补货通知我', sourceUrl: f.url + '/models', conversation: [{ role: 'user', content: '通知里带上我的推广链接 [https://app.vmiss.com/aff.php?aff=5982](https://app.vmiss.com/aff.php?aff=5982)' }] });
  assert.equal(draft.monitor.url, f.url + '/models');
  assert.ok(draft.monitor.notification.body.includes('https://app.vmiss.com/aff.php?aff=5982'));
});

test('单商品当前有货首次通知，立即检查不会绕过规则重复通知', async t => {
  const f = await fixture(t);
  f.setStock(true);
  const draft = await f.request('/api/parse', 'POST', { instruction: '只要这个商品有货就通知我', sourceUrl: f.url + '/product' });
  assert.equal(draft.monitor.condition.operator, 'equals');
  const original = (await f.request('/api/monitors', 'POST', { ...draft.monitor, webhookIds: ['hook'] }, 201)).monitors[0];
  assert.equal(f.messages.length, 1);
  await f.request('/api/monitors/' + original.id + '/check', 'POST');
  await f.request('/api/monitors/' + original.id + '/check', 'POST');
  assert.equal(f.messages.length, 1);
  f.setStock(false);
  await f.request('/api/monitors/' + original.id + '/check', 'POST');
  f.setStock(true);
  await f.request('/api/monitors/' + original.id + '/check', 'POST');
  assert.equal(f.messages.length, 2);
});

test('明确何时有货的目标由程序编译，AI给出整页缺货消失条件也不会直接执行', async t => {
  const f = await fixture(t);
  f.setGoal({ type: 'product_stock', condition: { operator: 'absent', value: 'Sold Out' } });
  const draft = await f.request('/api/parse', 'POST', { instruction: '帮我监控这个商品什么时候有货', sourceUrl: f.url + '/product' });
  assert.equal(draft.monitor.condition.operator, 'transition');
  assert.deepEqual(draft.monitor.condition.from, ['out_of_stock']);
  assert.deepEqual(draft.monitor.condition.to, ['in_stock']);
  assert.equal(draft.monitor.last_test_result.passed, true);
});

test('同一库存需求在模型随机条件、周期与旧格式回答下仍产生一致的可执行规则', async t => {
  const f = await fixture(t);
  const instruction = '监控这个商品的库存，每半分钟检查';
  const signatures = [];
  for (const goal of [
    { type: 'product_stock', interval: 300, condition: { operator: 'equals', value: 'in_stock', initial: 'notify' } },
    { type: 'product_stock', interval: 5, condition: { operator: 'changed' } },
    { type: 'product_stock', interval: 60, condition: { operator: 'transition', from: ['in_stock'], to: ['out_of_stock'] } }
  ]) {
    f.setGoal(goal);
    const { monitor } = await f.request('/api/parse', 'POST', { instruction, sourceUrl: f.url + '/product' });
    assert.equal(monitor.interval, 30);
    assert.deepEqual(monitor.condition, { operator: 'transition', initial: 'baseline', from: ['out_of_stock'], to: ['in_stock'] });
    assert.equal(monitor.last_test_result.passed, true);
    signatures.push(ruleSignature(monitor));
  }
  f.setResponse({ status: 'ready', monitor: { kind: 'generated', intervalMinutes: 5, plan: { sourceType: 'html', mode: 'absent', keyword: 'Sold Out', initial: 'notify' } } });
  const legacy = await f.request('/api/parse', 'POST', { instruction, sourceUrl: f.url + '/product' });
  assert.equal(legacy.monitor.interval, 30);
  signatures.push(ruleSignature(legacy.monitor));
  assert.equal(new Set(signatures).size, 1);
});

test('只改周期或通知时保留原业务条件，模型额外改目标与历史周期不能覆盖当前草稿', async t => {
  const f = await fixture(t);
  const draft = await f.request('/api/analyze', 'POST', { type: 'price_change', condition: { operator: 'lt', value: 200 }, interval: 90, url: f.url + '/product' });
  const original = (await f.request('/api/monitors', 'POST', { ...draft.monitor, webhookIds: ['hook'] }, 201)).monitors[0];
  f.setResponse({ status: 'ready', goal: { type: 'product_stock', name: '模型擅自改名', interval: 300, condition: { operator: 'equals', value: 'in_stock', initial: 'notify' } }, notification: { title: '模型擅自改通知', body: '无关消息' } });
  const changed = await f.request('/api/parse', 'POST', { monitorId: original.id, instruction: '只把周期改成一分十五秒' });
  assert.equal(changed.monitor.type, 'price_change');
  assert.equal(changed.monitor.interval, 75);
  assert.deepEqual(changed.monitor.condition, original.condition);
  assert.deepEqual(changed.monitor.extraction_rule, original.extraction_rule);
  assert.equal(changed.monitor.url, original.url);
  assert.equal(changed.monitor.label, original.label);
  assert.deepEqual(changed.monitor.notification, original.notification);
  f.setResponse({ status: 'ready', goal: { type: 'product_stock', interval: 1, condition: { operator: 'changed' } }, notification: { title: '我的通知', body: '{{details}}' } });
  const notification = await f.request('/api/parse', 'POST', {
    instruction: '监控价格，每5分钟检查', sourceUrl: original.url, draft: changed.monitor,
    conversation: [{ role: 'user', content: '只修改通知标题为我的通知' }]
  });
  assert.equal(notification.monitor.type, 'price_change');
  assert.equal(notification.monitor.interval, 75);
  assert.deepEqual(notification.monitor.condition, original.condition);
  assert.equal(notification.monitor.notification.title, '我的通知');
  assert.equal((await f.request('/api/state')).monitors[0].interval, 90); // Drafts never overwrite the saved task.
});

test('普通接口故障和价格变化采用固定模板，模型默认阈值与首次通知不影响重复创建', async t => {
  const f = await fixture(t);
  for (const threshold of [1, 3, 8]) {
    f.setGoal({ type: 'api_monitor', interval: 300, condition: { operator: 'unavailable', failure_threshold: threshold, initial: 'notify' } });
    const { monitor } = await f.request('/api/parse', 'POST', { instruction: '这个接口异常通知我，每两分钟检查', sourceUrl: f.url + '/health' });
    assert.equal(monitor.interval, 120);
    assert.deepEqual(monitor.condition, { operator: 'unavailable', initial: 'baseline', failure_threshold: 1 });
  }
  f.setGoal({ type: 'price_change', interval: 20, condition: { operator: 'lt', value: 500, initial: 'notify' } });
  const { monitor } = await f.request('/api/parse', 'POST', { instruction: '帮我监控这个商品的价格变化', sourceUrl: f.url + '/product' });
  assert.equal(monitor.interval, 300);
  assert.deepEqual(monitor.condition, { operator: 'changed', initial: 'baseline' });
});

test('多选区域保存、重新打开和通知独立生效，非法选择与账户隔离受保护', async t => {
  const f = await fixture(t);
  const preview = await f.request('/api/element-preview', 'POST', { url: f.url + '/models' });
  const indices = [preview.collections[1].index, preview.collections[3].index];
  const draft = await f.request('/api/select-element', 'POST', { previewId: preview.id, indices, type: 'product_stock', scope: 'selected' });
  assert.equal(draft.monitor.extraction_rule.kind, 'elements');
  assert.equal(draft.monitor.last_test_result.snapshot.items.length, 2);
  assert.deepEqual(draft.monitor.last_test_result.snapshot.items.map(item => item.name), ['TRI.Core', 'TRI.Elite']);
  const saved = (await f.request('/api/monitors', 'POST', { ...draft.monitor, webhookIds: ['hook'] }, 201)).monitors[0];
  const reopened = await f.request('/api/element-preview', 'POST', { monitorId: saved.id });
  assert.equal(reopened.highlighted, 2);
  assert.equal(reopened.selected_indices.length, 2);
  f.setCounts([1,0,0,0,0]);
  await f.request('/api/monitors/' + saved.id + '/check', 'POST');
  assert.equal(f.messages.length, 0);
  f.setCounts([1,1,0,0,0]);
  await f.request('/api/monitors/' + saved.id + '/check', 'POST');
  assert.match(f.messages[0].message, /TRI.Core.*无货 → 有货/);
  f.setCounts([1,1,0,1,0]);
  await f.request('/api/monitors/' + saved.id + '/check', 'POST');
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[1].message, /TRI.Elite.*无货 → 有货/);
  assert.doesNotMatch(f.messages[1].message, /TRI.Core/);
  await f.request('/api/monitors/' + saved.id + '/check', 'POST');
  assert.equal(f.messages.length, 2);
  await f.request('/api/select-element', 'POST', { previewId: preview.id, indices: [], type: 'product_stock' }, 400);
  await f.request('/api/select-element', 'POST', { previewId: preview.id, indices: [indices[0], indices[0]], type: 'product_stock' }, 400);
  await f.request('/api/select-element', 'POST', { previewId: preview.id, indices: [1501], type: 'product_stock' }, 400);
  await f.request('/api/auth/register', 'POST', { username: 'multi-other', password: 'multi-other-password-123' }, 201);
  await f.request('/api/select-element', 'POST', { previewId: preview.id, indices, type: 'product_stock' }, 404);
});

test('多选网页内容和价格通过正式执行器并在通知中指出实际变化区域', async t => {
  const f = await fixture(t);
  const preview = await f.request('/api/element-preview', 'POST', { url: f.url + '/product' });
  const { load } = await import('cheerio');
  const $ = load(preview.html);
  const indices = [Number($('.stock').attr('data-radar-element')), Number($('.price').attr('data-radar-element'))];
  const draft = await f.request('/api/select-element', 'POST', { previewId: preview.id, indices, type: 'webpage_change' });
  const saved = (await f.request('/api/monitors', 'POST', { ...draft.monitor, webhookIds: ['hook'] }, 201)).monitors[0];
  f.setPrice(199);
  await f.request('/api/monitors/' + saved.id + '/check', 'POST');
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].message, /网页区域 2.*300.*199/);
  assert.doesNotMatch(f.messages[0].message, /Sold Out/);
  const logs = await f.request('/api/monitors/' + saved.id + '/logs');
  assert.ok(logs.logs.some(log => log.raw?.regions?.length === 2 && log.raw.triggered_regions.length === 1));
});
