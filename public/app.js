const $ = (selector) => document.querySelector(selector);
let appState = { settings: { webhooks: [] }, monitors: [], events: [], logs: [], sentCount: 0 };
let previewMonitor = null;
let toastTimer;
let authMode = 'login';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const activeHooks = () => (appState.settings.webhooks || []).filter((hook) => hook.enabled);
const isNtfyHook = (hook) => hook.format === 'ntfy' || (!hook.format || hook.format === 'auto') && /^https?:\/\/ntfy\.sh\//i.test(hook.url);
const selectedIds = (root) => [...root.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);

function relativeTime(timestamp) {
  if (!timestamp) return '尚未检查';
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('visible'), 4500);
}

async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let result;
  try { result = await response.json(); } catch { throw new Error('服务未返回有效数据'); }
  if (!response.ok) throw new Error(result.error || `请求失败：${response.status}`);
  return result;
}

function targetOptions(ids, emptyText = '请先添加并保存一个启用的 Webhook 地址。') {
  if (!activeHooks().length) return `<div class="target-empty">${emptyText} <a href="#settings">前往设置 ↗</a></div>`;
  const chosen = ids == null ? new Set(activeHooks().map((hook) => hook.id)) : new Set(ids);
  return activeHooks().map((hook) => `<label class="target-option"><input type="checkbox" value="${escapeHtml(hook.id)}" ${chosen.has(hook.id) ? 'checked' : ''}><span>${escapeHtml(hook.name)}</span></label>`).join('');
}

function renderStats() {
  const count = activeHooks().length;
  $('#channel-status').textContent = count ? `${count} 个已启用` : '未连接';
  $('#channel-hint').textContent = count ? '可为通知单独选择接收渠道' : '添加 Webhook 地址后开始';
  $('#active-count').textContent = appState.monitors.filter((monitor) => monitor.enabled).length;
  $('#sent-count').textContent = appState.sentCount || 0;
  $('#monitor-count').textContent = `${appState.monitors.length} 个任务`;
  $('#key-indicator').textContent = appState.settings.hasAiKey ? '· 已保存' : '';
  $('#ai-key').placeholder = appState.settings.hasAiKey ? '留空则保持当前 Key' : 'sk-...';
  $('#ai-status').textContent = appState.settings.hasAiKey && appState.settings.aiModel ? `点击后使用 ${appState.settings.aiModel} 生成本次监控逻辑` : '先在右侧设置 AI 接口、模型和 Key；点击生成时才会调用';
}

function renderMonitors() {
  const list = $('#monitor-list');
  if (!appState.monitors.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-icon">◎</span><strong>还没有监控任务</strong><span>在上方输入一句话，创建第一个监控。</span></div>';
    return;
  }
  list.innerHTML = appState.monitors.map((monitor) => {
    const status = !monitor.enabled ? ['已暂停', 'paused'] : monitor.lastError ? ['检查异常', 'error'] : monitor.baselined ? ['运行中', ''] : ['等待检查', 'paused'];
    const recipients = (monitor.webhookIds || []).map((id) => appState.settings.webhooks.find((hook) => hook.id === id)?.name).filter(Boolean).join('、') || '未设置';
    return `<article class="monitor-item">
      <div class="monitor-top"><div><div class="monitor-name">${escapeHtml(monitor.label)}</div><div class="monitor-description">${escapeHtml(monitor.description)}</div></div><span class="monitor-status ${status[1]}">${status[0]}</span></div>
      <div class="monitor-meta">每 ${monitor.intervalMinutes} 分钟检查 · ${escapeHtml(relativeTime(monitor.lastCheckAt))} · <a href="${escapeHtml(monitor.url)}" target="_blank" rel="noopener noreferrer">查看来源 ↗</a></div>
      <div class="monitor-result">接收渠道：${escapeHtml(recipients)}</div>
      ${monitor.lastError ? `<div class="monitor-result monitor-error">${escapeHtml(monitor.lastError)}</div>` : monitor.lastResult ? `<div class="monitor-result">${escapeHtml(monitor.lastResult)}</div>` : ''}
      <details class="monitor-route" data-id="${escapeHtml(monitor.id)}"><summary>编辑任务</summary>
        <div class="rule-fields">
          <label>任务名称<input class="edit-label" type="text" maxlength="60" value="${escapeHtml(monitor.label)}"></label>
          ${monitor.kind !== 'dmit' ? `<label>监控地址<input class="edit-url" type="url" value="${escapeHtml(monitor.url)}"></label>` : ''}
          ${monitor.kind === 'webpage' ? `<label>监控文字<input class="edit-keyword" type="text" maxlength="80" value="${escapeHtml(monitor.keyword)}"></label><label>触发方式<select class="edit-mode"><option value="contains" ${monitor.mode === 'contains' ? 'selected' : ''}>文字出现</option><option value="absent" ${monitor.mode === 'absent' ? 'selected' : ''}>文字消失</option></select></label>` : ''}
          ${monitor.kind === 'dmit' ? `<label>触发方式<select class="edit-trigger-mode"><option value="restock" ${monitor.triggerMode !== 'any-available' ? 'selected' : ''}>由无货变为有货</option><option value="any-available" ${monitor.triggerMode === 'any-available' ? 'selected' : ''}>任意有货（首次满足即通知）</option></select></label>` : ''}
          ${monitor.kind === 'json' ? `<label>JSON 字段路径<input class="edit-json-path" type="text" value="${escapeHtml(monitor.jsonPath)}"></label><label>比较方式<select class="edit-operator">${operatorOptions(monitor.operator)}</select></label><label>比较值<input class="edit-expected" type="text" value="${escapeHtml(monitor.expected)}"></label>` : ''}
          ${monitor.kind === 'rss' ? `<label>标题包含（可选）<input class="edit-keyword" type="text" value="${escapeHtml(monitor.keyword)}"></label>` : ''}
          <div class="priority-field"><span>ntfy 优先级（仅对 ntfy 生效）</span>${priorityPicker(`edit-priority-${monitor.id}`, monitor.priority, true, 'edit-priority')}</div>
          ${monitor.kind === 'generated' ? `<label class="plan-field">生成的监控逻辑<textarea class="edit-plan" rows="9" spellcheck="false">${escapeHtml(JSON.stringify(monitor.plan, null, 2))}</textarea></label>` : ''}
          <label>检查间隔（分钟）<input class="edit-interval" type="number" min="5" max="1440" value="${monitor.intervalMinutes}"></label>
        </div>
        <div class="field-label">通知到</div><div class="target-options">${targetOptions(monitor.webhookIds || [])}</div>
        <p class="edit-hint">修改地址或监控文字后会重新建立基线，取消旧的待发送提醒。</p>
        <button class="mini-button" data-action="save-rule" data-id="${escapeHtml(monitor.id)}" type="button">保存任务</button>
      </details>
      <div class="monitor-actions"><button class="mini-button" data-action="check" data-id="${escapeHtml(monitor.id)}">立即检查</button><button class="mini-button" data-action="toggle" data-id="${escapeHtml(monitor.id)}">${monitor.enabled ? '暂停' : '继续'}</button><button class="mini-button danger" data-action="delete" data-id="${escapeHtml(monitor.id)}">删除</button></div>
    </article>`;
  }).join('');
}

function renderEvents() {
  const list = $('#activity-list');
  if (!appState.events.length) {
    list.innerHTML = '<div class="activity-empty">还没有活动记录。发送一条测试通知试试。</div>';
    return;
  }
  list.innerHTML = appState.events.slice(0, 8).map((event) => `<div class="activity-row"><span class="event-dot ${escapeHtml(event.type)}"></span><div><div class="event-title">${escapeHtml(event.title)}</div><div class="event-detail">${escapeHtml(event.detail)}</div><div class="event-time">${escapeHtml(relativeTime(event.at))}</div></div></div>`).join('');
}

function renderLogs() {
  const all = appState.logs || [];
  const logs = $('#log-errors-only').checked ? all.filter((entry) => entry.status === 'error') : all;
  $('#log-count').textContent = `显示 ${logs.length} 条`;
  const list = $('#log-list');
  const scrollTop = list.scrollTop;
  list.innerHTML = logs.length ? logs.map((entry) => `<div class="log-row ${entry.status === 'error' ? 'log-error' : ''}"><strong>${escapeHtml({ monitor: '检查', webhook: '发送', parse: '解析' }[entry.kind] || entry.kind)} · ${escapeHtml(entry.status === 'error' ? '失败' : '成功')}</strong><span>${escapeHtml(new Date(entry.at).toLocaleString('zh-CN'))} · ${escapeHtml(entry.durationMs)} ms</span><p>${escapeHtml(entry.detail)}</p>${entry.url ? `<small title="${escapeHtml(entry.url)}">${escapeHtml(entry.url)}</small>` : ''}</div>`).join('') : '<p class="field-help">没有符合条件的日志。</p>';
  list.scrollTop = scrollTop;
}

function render(force = false) {
  renderStats();
  if (force || !$('#monitor-list .monitor-route[open]')) renderMonitors();
  renderEvents();
  renderLogs();
}

function priorityPicker(id, value, allowDefault = true, className = '') {
  const options = [...(allowDefault ? [['', '默认']] : []), ['1', '最低'], ['2', '低'], ['3', '普通'], ['4', '高'], ['5', '紧急']];
  const selected = value == null || value === '' ? '' : String(value);
  return `<div id="${escapeHtml(id)}" class="priority-picker ${className}" role="group" aria-label="ntfy 优先级">${options.map(([number, label]) => `<label><input type="radio" name="${escapeHtml(id)}" value="${number}" ${selected === number ? 'checked' : ''}><span>${number ? `${number} · ` : ''}${label}</span></label>`).join('')}</div>`;
}
const priorityValue = (root) => root?.querySelector('input[type="radio"]:checked')?.value || null;

function operatorOptions(value) {
  return [['equals', '等于'], ['notEquals', '不等于'], ['contains', '包含'], ['gt', '大于'], ['gte', '大于等于'], ['lt', '小于'], ['lte', '小于等于']].map(([key, label]) => `<option value="${key}" ${value === key ? 'selected' : ''}>${label}</option>`).join('');
}

function webhookRow(hook = { id: crypto.randomUUID(), name: '', url: '', enabled: true }) {
  const formats = [['auto', '自动识别'], ['generic', '通用 JSON'], ['slack', 'Slack'], ['discord', 'Discord'], ['wecom', '企业微信'], ['feishu', '飞书'], ['dingtalk', '钉钉'], ['ntfy', 'ntfy']];
  const isNtfy = hook.format === 'ntfy' || (!hook.format || hook.format === 'auto') && /^https?:\/\/ntfy\.sh\//i.test(hook.url || '');
  return `<div class="webhook-row" data-id="${escapeHtml(hook.id)}">
    <div class="webhook-row-top"><input class="hook-name" type="text" maxlength="40" placeholder="渠道名称，例如：团队群" value="${escapeHtml(hook.name)}" aria-label="渠道名称"><label class="hook-toggle"><input class="hook-enabled" type="checkbox" ${hook.enabled ? 'checked' : ''}> 启用</label></div>
    <input class="hook-url" type="url" placeholder="https://example.com/webhook" value="${escapeHtml(hook.url)}" autocomplete="off" aria-label="Webhook 地址">
    <label class="hook-format-line">消息格式 <select class="hook-format" aria-label="消息格式">${formats.map(([value, label]) => `<option value="${value}" ${value === (hook.format || 'auto') ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <div class="hook-priority-line ${isNtfy ? '' : 'hidden'}"><span>ntfy 默认优先级</span>${priorityPicker(`hook-priority-${hook.id}`, hook.priority ?? 3, false, 'hook-priority')}</div>
    <div class="webhook-row-actions"><span>${hook.url ? escapeHtml(new URL(hook.url).host) : '填写地址后保存'}</span><button type="button" class="mini-button" data-hook-action="test">测试</button><button type="button" class="mini-button danger" data-hook-action="delete">删除</button></div>
  </div>`;
}

function renderWebhooks() {
  const hooks = appState.settings.webhooks || [];
  $('#webhook-list').innerHTML = (hooks.length ? hooks : [{ id: crypto.randomUUID(), name: '', url: '', enabled: true }]).map(webhookRow).join('');
}

function updateSendPriorityVisibility() {
  const selected = new Set(selectedIds($('#send-targets')));
  $('#send-priority-wrap').classList.toggle('hidden', !activeHooks().some((hook) => selected.has(hook.id) && isNtfyHook(hook)));
}
function renderSendTargets(ids) { $('#send-targets').innerHTML = targetOptions(ids); updateSendPriorityVisibility(); }
$('#send-targets').addEventListener('change', updateSendPriorityVisibility);
$('#log-errors-only').addEventListener('change', renderLogs);

function populateSettings() {
  renderWebhooks();
  renderSendTargets();
  $('#ai-base-url').value = appState.settings.aiBaseUrl || 'https://api.openai.com/v1';
  $('#ai-model').value = appState.settings.aiModel || '';
}

function settingsBody() {
  const webhooks = [...$('#webhook-list').querySelectorAll('.webhook-row')].map((row) => ({
    id: row.dataset.id,
    name: row.querySelector('.hook-name').value.trim(),
    url: row.querySelector('.hook-url').value.trim(),
    enabled: row.querySelector('.hook-enabled').checked,
    format: row.querySelector('.hook-format').value,
    priority: Number(priorityValue(row.querySelector('.hook-priority')) || 3)
  })).filter((hook) => hook.name || hook.url);
  return { webhooks, aiBaseUrl: $('#ai-base-url').value.trim(), aiModel: $('#ai-model').value.trim(), aiKey: $('#ai-key').value.trim(), clearAiKey: $('#clear-ai-key').checked };
}

async function saveSettings(silent = false) {
  const currentOptions = $('#send-targets').querySelectorAll('input[type="checkbox"]');
  const previouslySelected = currentOptions.length ? selectedIds($('#send-targets')) : null;
  appState = await api('/api/settings', 'PUT', settingsBody());
  renderWebhooks();
  renderSendTargets(previouslySelected);
  $('#ai-key').value = '';
  $('#clear-ai-key').checked = false;
  $('#settings-dirty').textContent = '';
  render(true);
  if (!silent) toast('设置已保存');
}

async function ensureSettings() {
  await saveSettings(true);
  if (!activeHooks().length) throw new Error('请先添加并启用一个 Webhook 地址');
}

function renderPreview(monitor) {
  const element = $('#preview');
  element.classList.remove('hidden');
  const planLabels = { compare: '字段条件', changed: '字段变化', any: '任意条目符合', 'item-transition': '逐项状态变化', contains: '文字出现', absent: '文字消失', 'new-item': '新条目' };
  element.innerHTML = `<div class="preview-head"><span>✦ &nbsp; 监控规则预览</span><span>AI 本次生成 · 待确认</span></div>
    <div class="preview-grid"><div class="preview-item"><small>监控对象</small><strong>${escapeHtml(monitor.label)}</strong></div><div class="preview-item"><small>检查频率</small><strong>每 ${monitor.intervalMinutes} 分钟</strong></div><div class="preview-item"><small>触发条件</small><strong>${escapeHtml(monitor.description)}</strong></div><div class="preview-item"><small>来源地址</small><strong>${escapeHtml(new URL(monitor.url).host)}</strong></div>${monitor.kind === 'generated' ? `<div class="preview-item"><small>首次检查</small><strong>${monitor.plan.initial === 'notify' ? '若条件满足，立即通知' : '只记录当前状态'}</strong></div><div class="preview-item"><small>执行逻辑</small><strong>${escapeHtml(monitor.plan.sourceType.toUpperCase())} · ${escapeHtml(planLabels[monitor.plan.mode] || monitor.plan.mode)}</strong></div>` : ''}</div>
    <div class="preview-note">${monitor.kind === 'generated' ? '这是你本次请求时由 AI 生成的逻辑。请检查来源、筛选条件与首次通知方式；可在下方编辑。' : monitor.kind === 'dmit' && monitor.triggerMode === 'any-available' ? '首次检查发现有货会立即通知；持续有货不会重复发送。' : '首次检查只记录当前状态。后续条件发生变化时发送通知。'}${monitor.kind === 'dmit' ? '库存数据来自第三方，购买前请以官方页面为准。' : ''}</div>
    <div class="field-label">通知到</div><div id="preview-targets" class="target-options">${targetOptions()}</div>
    <details class="rule-editor"><summary>调整监控规则</summary><div class="rule-fields">
      <label>任务名称<input id="rule-label" type="text" maxlength="60" value="${escapeHtml(monitor.label)}"></label>
      ${monitor.kind === 'webpage' ? `<label>网页地址<input id="rule-url" type="url" value="${escapeHtml(monitor.url)}"></label><label>监控文字<input id="rule-keyword" type="text" maxlength="80" value="${escapeHtml(monitor.keyword)}"></label><label>触发方式<select id="rule-mode"><option value="contains" ${monitor.mode === 'contains' ? 'selected' : ''}>文字出现</option><option value="absent" ${monitor.mode === 'absent' ? 'selected' : ''}>文字消失</option></select></label>` : ''}
      ${monitor.kind === 'json' ? `<label>接口地址<input id="rule-url" type="url" value="${escapeHtml(monitor.url)}"></label><label>JSON 字段路径<input id="rule-json-path" type="text" value="${escapeHtml(monitor.jsonPath)}"></label><label>比较方式<select id="rule-operator">${operatorOptions(monitor.operator)}</select></label><label>比较值<input id="rule-expected" type="text" value="${escapeHtml(monitor.expected)}"></label>` : ''}
      ${monitor.kind === 'rss' ? `<label>订阅源地址<input id="rule-url" type="url" value="${escapeHtml(monitor.url)}"></label><label>标题包含（可选）<input id="rule-keyword" type="text" value="${escapeHtml(monitor.keyword)}"></label>` : ''}
      ${monitor.kind === 'github' ? `<label>GitHub API 地址<input id="rule-url" type="url" value="${escapeHtml(monitor.url)}"></label>` : ''}
      ${monitor.kind === 'dmit' ? `<label>触发方式<select id="rule-trigger-mode"><option value="restock" ${monitor.triggerMode !== 'any-available' ? 'selected' : ''}>由无货变为有货</option><option value="any-available" ${monitor.triggerMode === 'any-available' ? 'selected' : ''}>任意有货（首次满足即通知）</option></select></label>` : ''}
      ${monitor.kind === 'generated' ? `<label>来源地址<input id="rule-url" type="url" value="${escapeHtml(monitor.url)}"></label><label class="plan-field">本次生成的监控逻辑<textarea id="rule-plan" rows="9" spellcheck="false">${escapeHtml(JSON.stringify(monitor.plan, null, 2))}</textarea></label>` : ''}
      <div class="priority-field"><span>ntfy 优先级（仅对 ntfy 生效）</span>${priorityPicker('rule-priority', monitor.priority)}</div>
      <label>检查间隔（分钟）<input id="rule-interval" type="number" min="5" max="1440" value="${monitor.intervalMinutes}"></label>
    </div></details>
    <button class="button button-primary" id="create-button" type="button">确认并开始监控 <span>↗</span></button>`;
}

async function withButton(button, work) {
  button.disabled = true;
  try { await work(); } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
}

function showAuth() {
  $('#auth-screen').classList.remove('hidden');
  $('.app-shell').classList.add('auth-hidden');
}

function showWorkspace(state, hasLegacyData = false) {
  appState = state;
  $('#auth-screen').classList.add('hidden');
  $('.app-shell').classList.remove('auth-hidden');
  $('#account-name').textContent = state.user.username;
  $('#legacy-claim').classList.toggle('hidden', !hasLegacyData);
  populateSettings();
  render(true);
}

function setAuthMode(mode) {
  authMode = mode;
  $('#show-login').classList.toggle('active', mode === 'login');
  $('#show-register').classList.toggle('active', mode === 'register');
  $('#auth-submit').textContent = mode === 'login' ? '登录' : '注册并进入';
  $('#auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#invite-wrap').classList.toggle('hidden', mode !== 'register' || !$('#auth-screen').dataset.signupCodeRequired);
}

$('#show-login').addEventListener('click', () => setAuthMode('login'));
$('#show-register').addEventListener('click', () => setAuthMode('register'));
$('#auth-form').addEventListener('submit', (event) => {
  event.preventDefault();
  withButton($('#auth-submit'), async () => {
    const state = await api(`/api/auth/${authMode}`, 'POST', { username: $('#auth-username').value.trim(), password: $('#auth-password').value, inviteCode: $('#auth-invite').value });
    const status = await api('/api/auth/status');
    $('#auth-password').value = '';
    showWorkspace(state, status.hasLegacyData);
  });
});

$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/auth/logout', 'POST'); showAuth(); appState = { settings: { webhooks: [] }, monitors: [], events: [], logs: [], sentCount: 0 }; }
  catch (error) { toast(error.message, true); }
});

$('#claim-form').addEventListener('submit', (event) => {
  event.preventDefault();
  withButton($('#claim-form button'), async () => {
    const state = await api('/api/auth/claim-legacy', 'POST', { token: $('#claim-token').value.trim() });
    $('#claim-token').value = '';
    showWorkspace(state, false);
    toast('旧版数据已认领');
  });
});

$('#add-webhook').addEventListener('click', () => {
  const blank = [...$('#webhook-list').querySelectorAll('.webhook-row')].find((row) => !row.querySelector('.hook-name').value.trim() && !row.querySelector('.hook-url').value.trim());
  if (blank) return blank.querySelector('.hook-name').focus();
  if ($('#webhook-list').querySelectorAll('.webhook-row').length >= 20) return toast('最多添加 20 个 Webhook 地址', true);
  $('#webhook-list').insertAdjacentHTML('beforeend', webhookRow());
  $('#webhook-list .webhook-row:last-child .hook-name').focus();
  $('#settings-dirty').textContent = '未保存';
});

$('#webhook-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-hook-action]');
  if (!button) return;
  const row = button.closest('.webhook-row');
  const id = row.dataset.id;
  if (button.dataset.hookAction === 'delete') {
    const usedBy = appState.monitors.filter((monitor) => monitor.webhookIds?.includes(id)).length;
    if (usedBy && !confirm(`这个渠道被 ${usedBy} 个监控任务使用。删除后这些任务的接收渠道会更新，继续吗？`)) return;
    row.remove();
    if (!$('#webhook-list .webhook-row')) $('#webhook-list').innerHTML = webhookRow();
    $('#settings-dirty').textContent = '未保存';
    toast('地址已从列表移除，点击“保存设置”生效');
    return;
  }
  withButton(button, async () => {
    if (!row.querySelector('.hook-url').value.trim()) throw new Error('请先填写要测试的 Webhook 地址');
    await saveSettings(true);
    const report = await api('/api/test-webhook', 'POST', { webhookId: id });
    appState = await api('/api/state');
    render(true);
    toast(report.failed.length ? `${report.failed[0].name}：${report.failed[0].error}` : '测试通知已发送', Boolean(report.failed.length));
  });
});

function updateHookPriorityVisibility(row) {
  const format = row.querySelector('.hook-format').value;
  const url = row.querySelector('.hook-url').value.trim();
  row.querySelector('.hook-priority-line').classList.toggle('hidden', !(format === 'ntfy' || format === 'auto' && /^https?:\/\/ntfy\.sh\//i.test(url)));
}
$('#webhook-list').addEventListener('input', (event) => { const row = event.target.closest('.webhook-row'); if (row) updateHookPriorityVisibility(row); });
$('#webhook-list').addEventListener('change', (event) => { const row = event.target.closest('.webhook-row'); if (row) updateHookPriorityVisibility(row); });

$('#settings-form').addEventListener('input', () => { $('#settings-dirty').textContent = '未保存'; });
$('#settings-form').addEventListener('change', () => { $('#settings-dirty').textContent = '未保存'; });

$('#settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  withButton($('#save-button'), () => saveSettings());
});

$('#send-form').addEventListener('submit', (event) => {
  event.preventDefault();
  withButton($('#send-button'), async () => {
    await ensureSettings();
    const ids = selectedIds($('#send-targets'));
    if (!ids.length) throw new Error('请至少选择一个接收渠道');
    const report = await api('/api/send', 'POST', { title: $('#send-title').value, message: $('#send-message').value, webhookIds: ids, priority: priorityValue($('#send-priority')) });
    appState = await api('/api/state');
    render(true);
    if (report.failed.length) {
      renderSendTargets(report.failed.map((hook) => hook.id));
      toast(`已发送 ${report.sent.length} 个，失败 ${report.failed.length} 个。已选中失败渠道，可直接重试。`, true);
    } else {
      $('#send-title').value = '';
      $('#send-message').value = '';
      toast(`通知已发送到 ${report.sent.length} 个渠道`);
    }
  });
});

$('#parse-form').addEventListener('submit', (event) => {
  event.preventDefault();
  withButton($('#parse-button'), async () => {
    if ((!appState.settings.hasAiKey && !$('#ai-key').value.trim()) || !$('#ai-model').value.trim()) {
      $('.ai-settings').open = true;
      $('#settings').scrollIntoView({ behavior: 'smooth', block: 'center' });
      throw new Error('请先在 AI 生成设置中填写模型和 API Key');
    }
    if ($('#settings-dirty').textContent || $('#ai-key').value || $('#ai-model').value !== appState.settings.aiModel || $('#ai-base-url').value !== appState.settings.aiBaseUrl) await saveSettings(true);
    const result = await api('/api/parse', 'POST', { instruction: $('#instruction').value });
    previewMonitor = result.monitor;
    renderPreview(previewMonitor);
    toast('规则已生成，请确认');
  });
});

$('#preview').addEventListener('click', (event) => {
  if (!event.target.closest('#create-button')) return;
  withButton($('#create-button'), async () => {
    const options = $('#preview-targets').querySelectorAll('input[type="checkbox"]');
    const chosen = options.length ? selectedIds($('#preview-targets')) : null;
    await ensureSettings();
    const rule = { ...previewMonitor, label: $('#rule-label').value.trim(), intervalMinutes: Number($('#rule-interval').value), priority: priorityValue($('#rule-priority')), webhookIds: chosen ?? activeHooks().map((hook) => hook.id) };
    if ($('#rule-url')) rule.url = $('#rule-url').value.trim();
    if (rule.kind === 'generated') { try { rule.plan = JSON.parse($('#rule-plan').value); } catch { throw new Error('监控逻辑不是有效 JSON'); } }
    if (rule.kind === 'dmit') { rule.triggerMode = $('#rule-trigger-mode').value; rule.description = rule.triggerMode === 'any-available' ? '第三方库存列表中，任意套餐有货时通知；首次检查如有货会立即通知' : '第三方库存列表中，套餐由无货变为有货时通知'; }
    if (rule.kind === 'json') { rule.jsonPath = $('#rule-json-path').value.trim(); rule.operator = $('#rule-operator').value; rule.expected = $('#rule-expected').value.trim(); rule.description = `${rule.jsonPath} ${$('#rule-operator').selectedOptions[0].textContent} ${rule.expected} 时通知`; }
    if (rule.kind === 'rss') { rule.keyword = $('#rule-keyword').value.trim(); rule.description = rule.keyword ? `出现标题包含「${rule.keyword}」的新条目时通知` : '出现新条目时通知'; }
    if (rule.kind === 'webpage') {
      rule.url = $('#rule-url').value.trim();
      rule.keyword = $('#rule-keyword').value.trim();
      rule.mode = $('#rule-mode').value;
      rule.description = `页面${rule.mode === 'absent' ? '不再包含' : '出现'}「${rule.keyword}」时通知`;
    }
    appState = await api('/api/monitors', 'POST', rule);
    const created = appState.monitors[0];
    previewMonitor = null;
    $('#preview').classList.add('hidden');
    $('#instruction').value = '';
    render(true);
    toast(created.lastError ? `监控已创建，首次检查失败：${created.lastError}` : '监控已创建，首次检查已完成', Boolean(created.lastError));
    $('#monitor-list').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
});

$('#monitor-list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { id, action } = button.dataset;
  const monitor = appState.monitors.find((item) => item.id === id);
  if (!monitor) return;
  if (action === 'delete' && !confirm(`删除“${monitor.label}”？`)) return;
  withButton(button, async () => {
    const path = `/api/monitors/${encodeURIComponent(id)}`;
    if (action === 'save-rule') {
      const editor = button.closest('.monitor-route');
      const ids = selectedIds(editor.querySelector('.target-options'));
      const rule = { label: editor.querySelector('.edit-label').value.trim(), intervalMinutes: Number(editor.querySelector('.edit-interval').value), priority: priorityValue(editor.querySelector('.edit-priority')) };
      if (monitor.kind === 'generated') { try { rule.plan = JSON.parse(editor.querySelector('.edit-plan').value); } catch { throw new Error('监控逻辑不是有效 JSON'); } }
      if (editor.querySelector('.edit-url')) rule.url = editor.querySelector('.edit-url').value.trim();
      if (monitor.kind === 'webpage') {
        rule.keyword = editor.querySelector('.edit-keyword').value.trim();
        rule.mode = editor.querySelector('.edit-mode').value;
        rule.description = `页面${rule.mode === 'absent' ? '不再包含' : '出现'}「${rule.keyword}」时通知`;
      }
      if (monitor.kind === 'dmit') { rule.triggerMode = editor.querySelector('.edit-trigger-mode').value; rule.description = rule.triggerMode === 'any-available' ? '第三方库存列表中，任意套餐有货时通知；首次检查如有货会立即通知' : '第三方库存列表中，套餐由无货变为有货时通知'; }
      if (monitor.kind === 'json') { rule.jsonPath = editor.querySelector('.edit-json-path').value.trim(); rule.operator = editor.querySelector('.edit-operator').value; rule.expected = editor.querySelector('.edit-expected').value.trim(); rule.description = `${rule.jsonPath} ${editor.querySelector('.edit-operator').selectedOptions[0].textContent} ${rule.expected} 时通知`; }
      if (monitor.kind === 'rss') { rule.keyword = editor.querySelector('.edit-keyword').value.trim(); rule.description = rule.keyword ? `出现标题包含「${rule.keyword}」的新条目时通知` : '出现新条目时通知'; }
      appState = await api(path, 'PATCH', { rule, webhookIds: ids });
      toast('任务已更新');
    } else if (action === 'check') {
      appState = await api(`${path}/check`, 'POST');
      const updated = appState.monitors.find((item) => item.id === id);
      toast(updated.lastError || '检查已完成', Boolean(updated.lastError));
    } else if (action === 'toggle') {
      appState = await api(path, 'PATCH', { enabled: !monitor.enabled });
      toast(monitor.enabled ? '监控已暂停' : '监控已继续');
    } else if (action === 'delete') {
      appState = await api(path, 'DELETE');
      toast('监控已删除');
    }
    render(true);
  });
});

async function init() {
  try {
    const status = await api('/api/auth/status');
    if (status.signupCodeRequired) $('#auth-screen').dataset.signupCodeRequired = '1';
    if (status.authenticated) showWorkspace(await api('/api/state'), status.hasLegacyData);
    else showAuth();
    setInterval(async () => {
      if ($('.app-shell').classList.contains('auth-hidden')) return;
      try { appState = await api('/api/state'); render(); } catch (error) { if (error.message === '请先登录') showAuth(); }
    }, 30000);
  } catch (error) { showAuth(); toast(`无法连接本地服务：${error.message}`, true); }
}
$('#send-priority-slot').innerHTML = priorityPicker('send-priority', null, true);
init();
