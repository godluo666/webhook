const $ = (selector) => document.querySelector(selector);
let appState = { settings: { webhooks: [] }, monitors: [], events: [], logs: [], sentCount: 0 };
let previewMonitor = null;
let assistantInstruction = '';
let assistantConversation = [];
let assistantMessages = [];
let draftHooks = [];
let editingHookDraft = null;
let toastTimer;
let authMode = 'login';
let emailVerificationEnabled = false;

const sidebarShell = $('.app-shell');
const sidebarToggle = $('#sidebar-toggle');
const sidebarVisibility = $('#sidebar-visibility');
function setSidebarExpanded(expanded, remember = false) {
  sidebarShell.classList.toggle('sidebar-collapsed', !expanded);
  sidebarToggle.setAttribute('aria-expanded', String(expanded));
  const label = expanded ? '收起导航' : '展开导航';
  sidebarToggle.setAttribute('aria-label', label);
  sidebarToggle.title = label;
  if (remember) {
    try { localStorage.setItem('webhook-radar-sidebar', expanded ? 'expanded' : 'collapsed'); } catch { /* preference is optional */ }
  }
}
let savedSidebar = 'expanded';
try { savedSidebar = localStorage.getItem('webhook-radar-sidebar') || 'expanded'; } catch { /* use compact navigation */ }
setSidebarExpanded(savedSidebar === 'expanded');
sidebarToggle.addEventListener('click', () => setSidebarExpanded(sidebarShell.classList.contains('sidebar-collapsed'), true));
function setSidebarVisible(visible, remember = false) {
  sidebarShell.classList.toggle('sidebar-hidden', !visible);
  sidebarVisibility.setAttribute('aria-expanded', String(visible));
  const label = visible ? '隐藏导航' : '显示导航';
  sidebarVisibility.setAttribute('aria-label', label);
  sidebarVisibility.title = label;
  if (remember) {
    try { localStorage.setItem('webhook-radar-sidebar-visibility', visible ? 'visible' : 'hidden'); } catch { /* preference is optional */ }
  }
}
let savedSidebarVisibility = 'visible';
try { savedSidebarVisibility = localStorage.getItem('webhook-radar-sidebar-visibility') || 'visible'; } catch { /* keep navigation visible */ }
setSidebarVisible(savedSidebarVisibility !== 'hidden');
sidebarVisibility.addEventListener('click', () => setSidebarVisible(sidebarShell.classList.contains('sidebar-hidden'), true));
function syncNavigation() {
  const target = location.hash || '#top';
  document.querySelectorAll('.side-nav .nav-link').forEach((link) => link.classList.toggle('active', link.getAttribute('href') === target));
}
window.addEventListener('hashchange', syncNavigation);
syncNavigation();

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const activeHooks = () => (appState.settings.webhooks || []).filter((hook) => hook.enabled);
const isNtfyHook = (hook) => hook.format === 'ntfy' || (!hook.format || hook.format === 'auto') && /^https?:\/\/ntfy\.sh\//i.test(hook.url);
const selectedIds = (root) => [...root.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
const hasNtfyTarget = (ids) => activeHooks().some((hook) => ids.includes(hook.id) && isNtfyHook(hook));

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
  $('#active-count').textContent = appState.monitors.filter((monitor) => monitor.enabled && !monitor.completedAt).length;
  $('#sent-count').textContent = appState.sentCount || 0;
  $('#monitor-count').textContent = `${appState.monitors.length} 个任务`;
  $('#key-indicator').textContent = appState.settings.hasAiKey ? '· 已配置' : '· 未设置';
  $('#clear-ai-key-button').classList.toggle('hidden', !appState.settings.hasAiKey);
  $('#ai-key').placeholder = appState.settings.hasAiKey ? '留空则保持当前 Key' : 'sk-...';
  $('#ai-status').textContent = appState.settings.hasAiKey && appState.settings.aiModel ? `点击后使用 ${appState.settings.aiModel} 生成本次规则或提醒` : '先在下方设置 AI 接口、模型和 Key；点击开始创建时才会调用';
}

function renderMonitors() {
  const list = $('#monitor-list');
  if (!appState.monitors.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-icon">◎</span><strong>还没有任务</strong><span>在上方输入一句话，创建监控或提醒。</span></div>';
    return;
  }
  list.innerHTML = appState.monitors.map((monitor) => {
    if (monitor.kind === 'reminder') {
      const status = monitor.completedAt ? ['已发送', ''] : !monitor.enabled ? ['已暂停', 'paused'] : monitor.lastError ? ['发送待重试', 'error'] : ['等待提醒', 'paused'];
      const recipients = (monitor.webhookIds || []).map((id) => appState.settings.webhooks.find((hook) => hook.id === id)?.name).filter(Boolean).join('、') || '未设置';
      return '<article class="monitor-item">'
        + '<div class="monitor-top"><div><div class="monitor-name">' + escapeHtml(monitor.label) + '</div><div class="monitor-description">' + escapeHtml(monitor.message) + '</div></div><span class="monitor-status ' + status[1] + '">' + status[0] + '</span></div>'
        + '<div class="monitor-meta">一次性提醒 · ' + escapeHtml(reminderDate(monitor.remindAt)) + '</div>'
        + '<div class="monitor-result">接收渠道：' + escapeHtml(recipients) + '</div>'
        + (monitor.lastError ? '<div class="monitor-result monitor-error">' + escapeHtml(monitor.lastError) + '</div>' : '')
        + '<details class="monitor-route" data-id="' + escapeHtml(monitor.id) + '"><summary>编辑提醒</summary><div class="rule-fields">'
        + '<label>提醒名称<input class="edit-label" type="text" maxlength="60" value="' + escapeHtml(monitor.label) + '"></label>'
        + '<label>发送时间<input class="edit-remind-at" type="datetime-local" value="' + reminderInput(monitor.remindAt) + '"></label>'
        + '<label>提醒内容<textarea class="edit-message" rows="3" maxlength="2000">' + escapeHtml(monitor.message) + '</textarea></label>'
        + '<div class="priority-field ' + (hasNtfyTarget(monitor.webhookIds || []) ? '' : 'hidden') + '"><span>ntfy 优先级</span>' + priorityPicker('edit-priority-' + monitor.id, monitor.priority, true, 'edit-priority') + '</div></div>'
        + '<div class="field-label">通知到</div><div class="target-options">' + targetOptions(monitor.webhookIds || []) + '</div>'
        + '<p class="edit-hint">修改发送时间会重新安排一次性提醒。</p>'
        + '<button class="mini-button" data-action="save-rule" data-id="' + escapeHtml(monitor.id) + '" type="button">保存提醒</button></details>'
        + '<div class="monitor-actions">'
        + (monitor.completedAt ? '' : '<button class="mini-button" data-action="toggle" data-id="' + escapeHtml(monitor.id) + '">' + (monitor.enabled ? '暂停' : '继续') + '</button>')
        + '<button class="mini-button danger" data-action="delete" data-id="' + escapeHtml(monitor.id) + '">删除</button></div></article>';
    }
    const status = !monitor.enabled ? ['已暂停', 'paused'] : monitor.lastError ? ['检查异常', 'error'] : monitor.baselined ? ['运行中', ''] : ['等待检查', 'paused'];
    const recipients = (monitor.webhookIds || []).map((id) => appState.settings.webhooks.find((hook) => hook.id === id)?.name).filter(Boolean).join('、') || '未设置';
    return `<article class="monitor-item">
      <div class="monitor-top"><div><div class="monitor-name">${escapeHtml(monitor.label)}</div><div class="monitor-description">${escapeHtml(monitor.description)}</div></div><span class="monitor-status ${status[1]}">${status[0]}</span></div>
      <div class="monitor-meta">每 ${monitor.intervalMinutes} 分钟检查 · ${escapeHtml(relativeTime(monitor.lastCheckAt))} · ${/^https?:\/\//.test(monitor.url) ? `<a href="${escapeHtml(monitor.url)}" target="_blank" rel="noopener noreferrer">查看来源 ↗</a>` : `来源：${escapeHtml(monitor.url)}`}</div>
      <div class="monitor-result">接收渠道：${escapeHtml(recipients)}</div>
      ${monitor.lastError ? `<div class="monitor-result monitor-error">${escapeHtml(monitor.lastError)}</div>` : monitor.lastResult ? `<div class="monitor-result">${escapeHtml(monitor.lastResult)}</div>` : ''}
      <details class="monitor-route" data-id="${escapeHtml(monitor.id)}"><summary>编辑任务</summary>
        <div class="rule-fields">
          <label>任务名称<input class="edit-label" type="text" maxlength="60" value="${escapeHtml(monitor.label)}"></label>
          ${monitor.kind !== 'dmit' ? `<label>监控来源<input class="edit-url" type="${monitor.kind === 'generated' ? 'text' : 'url'}" value="${escapeHtml(monitor.url)}"></label>` : ''}
          ${monitor.kind === 'webpage' ? `<label>监控文字<input class="edit-keyword" type="text" maxlength="80" value="${escapeHtml(monitor.keyword)}"></label><label>触发方式<select class="edit-mode"><option value="contains" ${monitor.mode === 'contains' ? 'selected' : ''}>文字出现</option><option value="absent" ${monitor.mode === 'absent' ? 'selected' : ''}>文字消失</option></select></label>` : ''}
          ${monitor.kind === 'dmit' ? `<label>触发方式<select class="edit-trigger-mode"><option value="restock" ${monitor.triggerMode !== 'any-available' ? 'selected' : ''}>由无货变为有货</option><option value="any-available" ${monitor.triggerMode === 'any-available' ? 'selected' : ''}>任意有货（首次满足即通知）</option></select></label>` : ''}
          ${monitor.kind === 'json' ? `<label>JSON 字段路径<input class="edit-json-path" type="text" value="${escapeHtml(monitor.jsonPath)}"></label><label>比较方式<select class="edit-operator">${operatorOptions(monitor.operator)}</select></label><label>比较值<input class="edit-expected" type="text" value="${escapeHtml(monitor.expected)}"></label>` : ''}
          ${monitor.kind === 'rss' ? `<label>标题包含（可选）<input class="edit-keyword" type="text" value="${escapeHtml(monitor.keyword)}"></label>` : ''}
          <div class="priority-field ${hasNtfyTarget(monitor.webhookIds || []) ? '' : 'hidden'}"><span>ntfy 优先级</span>${priorityPicker(`edit-priority-${monitor.id}`, monitor.priority, true, 'edit-priority')}</div>
          ${monitor.kind === 'generated' ? `<label class="plan-field">生成的监控逻辑<textarea class="edit-plan" rows="9" spellcheck="false">${escapeHtml(JSON.stringify(monitor.plan, null, 2))}</textarea></label>` : ''}
          <label>检查间隔（分钟）<input class="edit-interval" type="number" min="${monitor.kind === 'generated' && ['service', 'log'].includes(monitor.plan.sourceType) ? 1 : 5}" max="1440" value="${monitor.intervalMinutes}"></label>
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
  const expanded = new Set([...list.querySelectorAll('.raw-log[open]')].map((details) => details.dataset.id));
  const labels = { instruction: '用户原始指令', conversation: '对话记录', firstModelError: '首次生成校验错误', firstModelResponse: '首次 AI 原始响应', sourceUrl: '提取或填写的来源地址', sourceMode: '来源地址获取方式', requestUrl: '请求地址', model: '模型', apiEndpoint: 'AI 接口', aiRequest: '发送给 AI 的原始请求体', aiResponse: 'AI 原始响应', responseBody: '原始响应内容', aiResponseTruncated: '响应已截断', aiReturnedUrl: 'AI 返回的监控地址', sourceInterpretation: '地址解释', validatedUrl: '最终监控地址', httpStatus: 'HTTP 状态', networkCode: '网络错误码', networkCause: '网络错误详情', validation: '校验结果' };
  const rawHtml = (entry) => `<details class="raw-log" data-id="${escapeHtml(entry.id)}" ${expanded.has(entry.id) ? 'open' : ''}><summary>查看原始记录</summary><button type="button" class="mini-button copy-log" data-copy-log="${escapeHtml(entry.id)}">复制原始记录</button>${Object.entries(entry.raw).filter(([, value]) => value != null && value !== '').map(([name, value]) => {
    let display = String(value ?? '');
    if (name === 'aiRequest' || name === 'aiResponse' || name === 'responseBody') { try { display = JSON.stringify(JSON.parse(display), null, 2); } catch { /* display the original text */ } }
    return `<div class="raw-log-field"><b>${escapeHtml(labels[name] || name)}</b><pre>${escapeHtml(display)}</pre></div>`;
  }).join('')}</details>`;
  list.innerHTML = logs.length ? logs.map((entry) => `<div class="log-row ${entry.status === 'error' ? 'log-error' : ''}"><strong>${escapeHtml({ monitor: '检查', webhook: '发送', parse: '解析', preview: '来源测试', 'ai-test': 'AI 连接' }[entry.kind] || entry.kind)} · ${escapeHtml(entry.status === 'error' ? '失败' : '成功')}</strong><span>${escapeHtml(new Date(entry.at).toLocaleString('zh-CN'))} · ${escapeHtml(entry.durationMs)} ms</span><p>${escapeHtml(entry.detail)}</p>${entry.url ? `<small title="${escapeHtml(entry.url)}">${escapeHtml(entry.url)}</small>` : ''}${entry.raw ? rawHtml(entry) : entry.kind === 'parse' ? '<small>旧记录未保存原始请求与回复</small>' : ''}</div>`).join('') : '<p class="field-help">没有符合条件的日志。</p>';
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

function webhookRow(hook) {
  const types = { auto: '自动识别', generic: '通用 JSON', slack: 'Slack', discord: 'Discord', wecom: '企业微信', feishu: '飞书', dingtalk: '钉钉', ntfy: 'ntfy' };
  let host = '';
  try { host = new URL(hook.url).host; } catch { host = hook.url || '尚未填写'; }
  return '<tr class="webhook-row" data-id="' + escapeHtml(hook.id) + '"><td><strong>' + escapeHtml(hook.name || '未命名渠道') + '</strong></td>'
    + '<td>' + escapeHtml(types[hook.format || 'auto'] || hook.format) + '</td>'
    + '<td><span class="channel-state ' + (hook.enabled ? 'is-active' : '') + '">' + (hook.enabled ? '已启用' : '已停用') + '</span></td>'
    + '<td class="channel-host" title="' + escapeHtml(hook.url) + '">' + escapeHtml(host) + '</td>'
    + '<td><button type="button" class="mini-button" data-hook-action="edit">编辑</button></td></tr>';
}

function renderWebhooks() {
  $('#webhook-list').innerHTML = draftHooks.map(webhookRow).join('');
  $('#channel-empty').classList.toggle('hidden', draftHooks.length > 0);
  $('.channel-table-wrap').classList.toggle('hidden', draftHooks.length === 0);
}

function hookFields(hook) {
  const formats = [['auto', '自动识别'], ['generic', '通用 JSON'], ['slack', 'Slack'], ['discord', 'Discord'], ['wecom', '企业微信'], ['feishu', '飞书'], ['dingtalk', '钉钉'], ['ntfy', 'ntfy']];
  const isNtfy = hook.format === 'ntfy' || (!hook.format || hook.format === 'auto') && /^https?:\/\/ntfy\.sh\//i.test(hook.url || '');
  return '<label class="field-label">渠道名称<input class="hook-name" type="text" maxlength="40" value="' + escapeHtml(hook.name || '') + '" placeholder="例如：团队群"></label>'
    + '<label class="field-label">Webhook 地址<input class="hook-url" type="url" value="' + escapeHtml(hook.url || '') + '" placeholder="https://example.com/webhook" autocomplete="off"></label>'
    + '<label class="field-label">消息格式<select class="hook-format">' + formats.map(([value, label]) => '<option value="' + value + '" ' + (value === (hook.format || 'auto') ? 'selected' : '') + '>' + label + '</option>').join('') + '</select></label>'
    + '<label class="drawer-switch"><input class="hook-enabled" type="checkbox" ' + (hook.enabled !== false ? 'checked' : '') + '>启用此渠道</label>'
    + '<div class="hook-priority-line ' + (isNtfy ? '' : 'hidden') + '"><span>ntfy 默认优先级</span>' + priorityPicker('drawer-priority', hook.priority ?? 3, false, 'hook-priority') + '</div>';
}

function openWebhookDrawer(hook = null) {
  editingHookDraft = hook ? { ...hook } : { id: crypto.randomUUID(), name: '', url: '', enabled: true, format: 'auto', priority: 3 };
  $('#drawer-title').textContent = hook ? '编辑渠道' : '添加渠道';
  $('#drawer-fields').innerHTML = hookFields(editingHookDraft);
  $('#drawer-delete').classList.toggle('hidden', !hook);
  $('#webhook-drawer').classList.remove('hidden');
  $('#drawer-backdrop').classList.remove('hidden');
  $('#drawer-fields .hook-name').focus();
}

function closeWebhookDrawer() {
  editingHookDraft = null;
  $('#webhook-drawer').classList.add('hidden');
  $('#drawer-backdrop').classList.add('hidden');
  $('#drawer-fields').innerHTML = '';
}
function updateSendPriorityVisibility() {
  const selected = new Set(selectedIds($('#send-targets')));
  $('#send-priority-wrap').classList.toggle('hidden', !hasNtfyTarget([...selected]));
}
function renderSendTargets(ids) { $('#send-targets').innerHTML = targetOptions(ids); updateSendPriorityVisibility(); }
$('#send-targets').addEventListener('change', updateSendPriorityVisibility);
$('#log-errors-only').addEventListener('change', renderLogs);
$('#log-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-copy-log]');
  if (!button) return;
  const entry = (appState.logs || []).find((item) => item.id === button.dataset.copyLog);
  if (!entry?.raw) return;
  navigator.clipboard.writeText(JSON.stringify(entry.raw, null, 2)).then(() => toast('原始记录已复制')).catch(() => toast('复制失败，请手动选择日志内容', true));
});

function populateSettings() {
  draftHooks = (appState.settings.webhooks || []).map((hook) => ({ ...hook }));
  renderWebhooks();
  renderSendTargets();
  $('#ai-base-url').value = appState.settings.aiBaseUrl || 'https://api.openai.com/v1';
  $('#ai-model').value = appState.settings.aiModel || '';
  $('#ai-key').value = '';
  $('#ai-test-result').textContent = '';
  $('#ai-test-result').className = '';
  $('#settings-dirty').textContent = '';
}

function settingsBody() {
  const webhooks = draftHooks.map((hook) => ({ ...hook }));
  return { webhooks, aiBaseUrl: $('#ai-base-url').value.trim(), aiModel: $('#ai-model').value.trim(), aiKey: $('#ai-key').value.trim() };
}

async function saveSettings(silent = false) {
  const currentOptions = $('#send-targets').querySelectorAll('input[type="checkbox"]');
  const previouslySelected = currentOptions.length ? selectedIds($('#send-targets')) : null;
  appState = await api('/api/settings', 'PUT', settingsBody());
  draftHooks = (appState.settings.webhooks || []).map((hook) => ({ ...hook }));
  renderWebhooks();
  renderSendTargets(previouslySelected);
  $('#ai-key').value = '';

  $('#settings-dirty').textContent = '';
  render(true);
  if (!silent) toast('设置已保存');
}

async function ensureSettings() {
  const targets = $('#preview-targets');
  const selected = targets?.querySelector('input[type="checkbox"]') ? selectedIds(targets) : null;
  await saveSettings(true);
  if (targets) {
    const retained = selected?.filter((id) => activeHooks().some((hook) => hook.id === id));
    targets.innerHTML = targetOptions(retained?.length ? retained : undefined);
    updatePriorityVisibility($('#preview'), '#preview-targets');
  }
  if (!activeHooks().length) throw new Error('请先添加并启用一个 Webhook 地址');
}

function assistantPhase(status) {
  const labels = { generating: '正在理解你的需求…', need_more_info: '等待你补充信息', ready: '规则已生成，等待确认', created: '任务已创建', failed: '处理遇到问题，可以继续补充' };
  $('#assistant-dialog').dataset.status = status;
  $('#assistant-phase').textContent = labels[status] || '等待需求';
  $('#assistant-reply-button').disabled = status === 'generating';
}

function renderAssistantMessages() {
  const list = $('#assistant-messages');
  list.innerHTML = assistantMessages.map((message) => `<div class="assistant-message ${message.role}"><small>${message.role === 'user' ? '你' : 'AI 创建助手'}</small>${escapeHtml(message.content)}</div>`).join('');
  list.scrollTop = list.scrollHeight;
}

function addAssistantMessage(role, content) {
  $('#assistant-dialog').classList.remove('hidden');
  assistantMessages.push({ role, content });
  assistantMessages = assistantMessages.slice(-20);
  renderAssistantMessages();
}

function resetAssistant(instruction = '') {
  assistantInstruction = instruction;
  assistantConversation = [];
  assistantMessages = [];
  $('#assistant-dialog').classList.toggle('hidden', !instruction);
  $('#assistant-reply').value = '';
  $('#assistant-messages').innerHTML = '';
  assistantPhase('idle');
}

async function prepareAiSettings() {
  if ((!appState.settings.hasAiKey && !$('#ai-key').value.trim()) || !$('#ai-model').value.trim()) {
    $('#ai-settings').scrollIntoView({ behavior: 'smooth', block: 'center' });
    throw new Error('请先在 AI 生成设置中填写模型和 API Key');
  }
  if ($('#settings-dirty').textContent || $('#ai-key').value || $('#ai-model').value !== appState.settings.aiModel || $('#ai-base-url').value !== appState.settings.aiBaseUrl) await saveSettings(true);
}

async function askAssistant() {
  assistantPhase('generating');
  try {
    await prepareAiSettings();
    assistantConversation = assistantConversation.slice(-6);
    const result = await api('/api/parse', 'POST', { instruction: assistantInstruction, sourceUrl: $('#instruction-url').value.trim(), conversation: assistantConversation, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    if (result.status === 'answer') {
      addAssistantMessage('assistant', result.message);
      assistantConversation.push({ role: 'assistant', content: result.message });
      assistantPhase('need_more_info');
      $('#assistant-reply').focus();
      return;
    }
    if (result.status === 'need_more_info') {
      previewMonitor = null;
      $('#preview').classList.add('hidden');
      const reply = result.questions.map((question, index) => `${index + 1}. ${question}`).join('\n');
      addAssistantMessage('assistant', `还需要确认：\n${reply}`);
      assistantConversation.push({ role: 'assistant', content: reply });
      assistantPhase('need_more_info');
      $('#assistant-reply').focus();
      return;
    }
    if (result.status !== 'ready' || !result.monitor) throw new Error('AI 未返回可确认的监控规则');
    previewMonitor = { ...result.monitor, sourceNote: result.sourceNote || '' };
    addAssistantMessage('assistant', result.monitor.kind === 'reminder' ? '提醒已准备好。请核对发送时间、内容和通知渠道，然后确认创建；需要调整可继续告诉我。' : '信息已齐，规则已生成。请核对下方的监控来源、条件和通知渠道，然后确认创建；需要调整可继续告诉我。');

    renderPreview(previewMonitor);
    assistantPhase('ready');
    $('#preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    addAssistantMessage('assistant', `暂时无法完成生成：${error.message}。你可以补充或修改需求后重试。`);
    assistantPhase('failed');
    throw error;
  }
}

function reminderDate(value) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeStyle: 'short' }).format(new Date(value));
}

function reminderInput(value) {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function renderPreview(monitor) {
  const element = $('#preview');
  element.classList.remove('hidden');
  if (monitor.kind === 'reminder') {
    element.innerHTML = '<div class="preview-head"><span>✦ &nbsp; 提醒预览</span><span>AI 本次生成 · 待确认</span></div>'
      + '<div class="preview-grid"><div class="preview-item"><small>提醒名称</small><strong>' + escapeHtml(monitor.label) + '</strong></div>'
      + '<div class="preview-item"><small>发送时间</small><strong>' + escapeHtml(reminderDate(monitor.remindAt)) + '</strong></div>'
      + '<div class="preview-item"><small>提醒内容</small><strong>' + escapeHtml(monitor.message) + '</strong></div></div>'
      + '<p class="preview-note">一次性提醒。时间按此设备的本地时区显示；请确认后再创建。</p>'
      + '<div class="field-label">通知到</div><div id="preview-targets" class="target-options">' + targetOptions() + '</div>'
      + '<details class="rule-editor"><summary>调整提醒</summary><div class="rule-fields">'
      + '<label>提醒名称<input id="rule-label" type="text" maxlength="60" value="' + escapeHtml(monitor.label) + '"></label>'
      + '<label>发送时间<input id="rule-remind-at" type="datetime-local" value="' + reminderInput(monitor.remindAt) + '"></label>'
      + '<label>提醒内容<textarea id="rule-message" rows="3" maxlength="2000">' + escapeHtml(monitor.message) + '</textarea></label>'
      + '<div class="priority-field"><span>ntfy 优先级</span>' + priorityPicker('rule-priority', monitor.priority) + '</div></div></details>'
      + '<div id="preview-result" class="preview-result" aria-live="polite"></div>'
      + '<div class="preview-actions"><button class="button button-outline" id="preview-revise-button" type="button">修改需求</button>'
      + '<button class="button button-primary" id="create-button" type="button">确认创建提醒 <span>↗</span></button></div>';
    updatePriorityVisibility(element, '#preview-targets');
    return;
  }
  const planLabels = { compare: '字段条件', changed: '字段变化', any: '任意条目符合', 'item-transition': '逐项状态变化', contains: '文字出现', absent: '文字消失', 'new-item': '新条目', unavailable: '服务不可用', available: '服务恢复', slow: '响应变慢', 'new-line': '新增日志行' };
  element.innerHTML = `<div class="preview-head"><span>✦ &nbsp; 监控规则预览</span><span>AI 本次生成 · 待确认</span></div>
    <div class="preview-grid"><div class="preview-item"><small>监控对象</small><strong>${escapeHtml(monitor.label)}</strong></div><div class="preview-item"><small>检查频率</small><strong>每 ${monitor.intervalMinutes} 分钟</strong></div><div class="preview-item"><small>触发条件</small><strong>${escapeHtml(monitor.description)}</strong></div><div class="preview-item"><small>监控来源</small><strong>${escapeHtml(monitor.url)}</strong></div><div class="preview-item"><small>告警级别</small><strong>${monitor.severity === 'critical' ? '紧急' : monitor.severity === 'info' ? '提示' : '警告（默认）'}</strong></div>${monitor.kind === 'generated' ? `<div class="preview-item"><small>首次检查</small><strong>${monitor.plan.initial === 'notify' ? '若条件满足，立即通知' : '只记录当前状态'}</strong></div><div class="preview-item"><small>执行逻辑</small><strong>${escapeHtml(monitor.plan.sourceType.toUpperCase())} · ${escapeHtml(planLabels[monitor.plan.mode] || monitor.plan.mode)}</strong></div>` : ''}</div>
    <div class="preview-note">${monitor.sourceNote ? `${escapeHtml(monitor.sourceNote)} ` : ''}${monitor.kind === 'generated' ? '这是你本次请求时由 AI 生成的逻辑。请检查来源、筛选条件与首次通知方式；可在下方编辑。' : monitor.kind === 'dmit' && monitor.triggerMode === 'any-available' ? '首次检查发现有货会立即通知；持续有货不会重复发送。' : '首次检查只记录当前状态。后续条件发生变化时发送通知。'}${monitor.kind === 'generated' && monitor.plan.sourceType === 'html' ? ' 网页检查只读取服务端返回的 HTML，不执行页面 JavaScript；建议先点“测试来源”。' : ''}${monitor.kind === 'dmit' ? '库存数据来自第三方，购买前请以官方页面为准。' : ''}</div>
    <div class="field-label">通知到</div><div id="preview-targets" class="target-options">${targetOptions()}</div>
    <details class="rule-editor"><summary>调整监控规则</summary><div class="rule-fields">
      <label>任务名称<input id="rule-label" type="text" maxlength="60" value="${escapeHtml(monitor.label)}"></label>
      ${monitor.kind === 'webpage' ? `<label>网页地址<input id="rule-url" type="url" value="${escapeHtml(monitor.url)}"></label><label>监控文字<input id="rule-keyword" type="text" maxlength="80" value="${escapeHtml(monitor.keyword)}"></label><label>触发方式<select id="rule-mode"><option value="contains" ${monitor.mode === 'contains' ? 'selected' : ''}>文字出现</option><option value="absent" ${monitor.mode === 'absent' ? 'selected' : ''}>文字消失</option></select></label>` : ''}
      ${monitor.kind === 'json' ? `<label>接口地址<input id="rule-url" type="url" value="${escapeHtml(monitor.url)}"></label><label>JSON 字段路径<input id="rule-json-path" type="text" value="${escapeHtml(monitor.jsonPath)}"></label><label>比较方式<select id="rule-operator">${operatorOptions(monitor.operator)}</select></label><label>比较值<input id="rule-expected" type="text" value="${escapeHtml(monitor.expected)}"></label>` : ''}
      ${monitor.kind === 'rss' ? `<label>订阅源地址<input id="rule-url" type="url" value="${escapeHtml(monitor.url)}"></label><label>标题包含（可选）<input id="rule-keyword" type="text" value="${escapeHtml(monitor.keyword)}"></label>` : ''}
      ${monitor.kind === 'github' ? `<label>GitHub API 地址<input id="rule-url" type="url" value="${escapeHtml(monitor.url)}"></label>` : ''}
      ${monitor.kind === 'dmit' ? `<label>触发方式<select id="rule-trigger-mode"><option value="restock" ${monitor.triggerMode !== 'any-available' ? 'selected' : ''}>由无货变为有货</option><option value="any-available" ${monitor.triggerMode === 'any-available' ? 'selected' : ''}>任意有货（首次满足即通知）</option></select></label>` : ''}
      ${monitor.kind === 'generated' ? `<label>监控来源<input id="rule-url" type="text" value="${escapeHtml(monitor.url)}"></label><label class="plan-field">本次生成的监控逻辑<textarea id="rule-plan" rows="9" spellcheck="false">${escapeHtml(JSON.stringify(monitor.plan, null, 2))}</textarea></label>` : ''}
      <div class="priority-field"><span>ntfy 优先级</span>${priorityPicker('rule-priority', monitor.priority)}</div>
      <label>检查间隔（分钟）<input id="rule-interval" type="number" min="${monitor.kind === 'generated' && ['service', 'log'].includes(monitor.plan.sourceType) ? 1 : 5}" max="1440" value="${monitor.intervalMinutes}"></label>
    </div></details>
    <div id="preview-result" class="preview-result" aria-live="polite"></div><div class="preview-actions"><button class="button button-outline" id="preview-revise-button" type="button">修改需求</button><button class="button button-outline" id="preview-check-button" type="button">测试来源</button><button class="button button-primary" id="create-button" type="button">确认并开始监控 <span>↗</span></button></div>`;
  updatePriorityVisibility(element, '#preview-targets');
}

function updatePriorityVisibility(container, targetsSelector) {
  const targets = container.querySelector(targetsSelector);
  const priority = container.querySelector('.priority-field');
  if (targets && priority) priority.classList.toggle('hidden', !hasNtfyTarget(selectedIds(targets)));
}
$('#preview').addEventListener('change', () => updatePriorityVisibility($('#preview'), '#preview-targets'));
$('#monitor-list').addEventListener('change', (event) => {
  const editor = event.target.closest('.monitor-route');
  if (editor) updatePriorityVisibility(editor, '.target-options');
});

function collectPreviewRule() {
  const options = $('#preview-targets').querySelectorAll('input[type="checkbox"]');
  const chosen = options.length ? selectedIds($('#preview-targets')) : null;
  const webhookIds = chosen ?? activeHooks().map((hook) => hook.id);
  const rule = { ...previewMonitor, label: $('#rule-label').value.trim(), priority: hasNtfyTarget(webhookIds) ? priorityValue($('#rule-priority')) : null, webhookIds };
  if (rule.kind === 'reminder') {
    const time = new Date($('#rule-remind-at').value);
    if (!Number.isFinite(time.getTime())) throw new Error('请填写有效的提醒时间');
    rule.remindAt = time.toISOString();
    rule.message = $('#rule-message').value.trim();
    return rule;
  }
  rule.intervalMinutes = Number($('#rule-interval').value);
  if ($('#rule-url')) rule.url = $('#rule-url').value.trim();
  if (rule.kind === 'generated') { try { rule.plan = JSON.parse($('#rule-plan').value); } catch { throw new Error('监控逻辑不是有效 JSON'); } }
  if (rule.kind === 'dmit') { rule.triggerMode = $('#rule-trigger-mode').value; rule.description = rule.triggerMode === 'any-available' ? '第三方库存列表中，任意套餐有货时通知；首次检查如有货会立即通知' : '第三方库存列表中，套餐由无货变为有货时通知'; }
  if (rule.kind === 'json') { rule.jsonPath = $('#rule-json-path').value.trim(); rule.operator = $('#rule-operator').value; rule.expected = $('#rule-expected').value.trim(); rule.description = `${rule.jsonPath} ${$('#rule-operator').selectedOptions[0].textContent} ${rule.expected} 时通知`; }
  if (rule.kind === 'rss') { rule.keyword = $('#rule-keyword').value.trim(); rule.description = rule.keyword ? `出现标题包含「${rule.keyword}」的新条目时通知` : '出现新条目时通知'; }
  if (rule.kind === 'webpage') { rule.keyword = $('#rule-keyword').value.trim(); rule.mode = $('#rule-mode').value; rule.description = `页面${rule.mode === 'absent' ? '不再包含' : '出现'}「${rule.keyword}」时通知`; }
  return rule;
}

async function withButton(button, work) {
  button.disabled = true;
  try { await work(); } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
}

function showAuth() {
  setAuthMode('login');
  $('#auth-screen').classList.remove('hidden');
  $('.app-shell').classList.add('auth-hidden');
  previewMonitor = null;
  resetAssistant();
  $('#preview').classList.add('hidden');
  $('#preview').innerHTML = '';
  for (const selector of ['#ai-key', '#instruction', '#instruction-url', '#send-title', '#send-message', '#auth-recovery-code', '#auth-email-code', '#account-email-code']) $(selector).value = '';
  $('#ai-test-result').textContent = '';
  $('#settings-dirty').textContent = '';
  for (const input of document.querySelectorAll('#email-password, #current-password, #new-password, #rotate-code-password')) input.value = '';
}

function showWorkspace(state) {
  appState = state;
  $('#auth-screen').classList.add('hidden');
  $('.app-shell').classList.remove('auth-hidden');
  $('#account-name').textContent = state.user.username;
  $('#local-source-hint').textContent = `日志文件使用账户目录 ${state.user.logDirectory} 内的相对路径；例如 log:app.log。`;
  $('#account-email').value = state.user.email || '';
  $('#email-status').textContent = state.user.emailVerified ? `已验证：${state.user.email}` : state.user.email ? `尚未验证：${state.user.email}` : '尚未绑定邮箱';
  $('#email-form').classList.toggle('hidden', !emailVerificationEnabled);
  $('#email-service-note').classList.toggle('hidden', emailVerificationEnabled);
  $('#recovery-code-status').textContent = state.user.hasRecoveryCode ? '已设置恢复码。生成新码后，旧码立即失效。' : '这个账号还没有恢复码；请生成并保存。';
  populateSettings();
  render(true);
}

function setAuthMode(mode) {
  if (authMode !== mode) $('#auth-password').value = '';
  authMode = mode;
  $('#show-login').classList.toggle('active', mode === 'login');
  $('#show-register').classList.toggle('active', mode === 'register');
  $('#show-recover').classList.toggle('active', mode === 'recover');
  $('#auth-submit').textContent = mode === 'login' ? '登录' : mode === 'register' ? '注册并进入' : '设置新密码';
  $('#auth-password-label').textContent = mode === 'recover' ? '新密码（至少 12 位）' : '密码';
  $('#auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#invite-wrap').classList.toggle('hidden', mode !== 'register' || !$('#auth-screen').dataset.signupCodeRequired);
  $('#auth-email-wrap').classList.toggle('hidden', mode !== 'register' || !emailVerificationEnabled);
  $('#auth-email-unavailable').classList.toggle('hidden', mode !== 'register' || emailVerificationEnabled);
  $('#auth-code-wrap').classList.toggle('hidden', mode !== 'recover');
  $('#auth-email').disabled = mode !== 'register' || !emailVerificationEnabled;
  $('#auth-email').required = mode === 'register' && emailVerificationEnabled;
  $('#auth-email-code').disabled = mode !== 'register' || !emailVerificationEnabled;
  $('#auth-email-code').required = mode === 'register' && emailVerificationEnabled;
  $('#auth-recovery-code').disabled = mode !== 'recover';
  $('#auth-recovery-code').required = mode === 'recover';
}

$('#show-login').addEventListener('click', () => setAuthMode('login'));
$('#show-register').addEventListener('click', () => setAuthMode('register'));
$('#show-recover').addEventListener('click', () => setAuthMode('recover'));

function sendEmailCode(button, status, requestBody) {
  if (button.disabled) return;
  button.disabled = true;
  api('/api/auth/email-code', 'POST', requestBody).then((result) => {
    let remaining = result.retryAfterSeconds || 60;
    status.textContent = '验证码已发送，请在 10 分钟内填写；请检查收件箱和垃圾邮件。';
    toast('验证码已发送');
    button.textContent = `${remaining} 秒后重发`;
    const timer = setInterval(() => {
      remaining -= 1;
      button.textContent = remaining > 0 ? `${remaining} 秒后重发` : '发送验证码';
      if (remaining <= 0) { clearInterval(timer); button.disabled = false; }
    }, 1000);
  }).catch((error) => {
    button.disabled = false;
    status.textContent = error.message;
    toast(error.message, true);
  });
}
$('#send-register-code').addEventListener('click', () => sendEmailCode($('#send-register-code'), $('#register-code-status'), { purpose: 'register', username: $('#auth-username').value.trim(), email: $('#auth-email').value.trim(), inviteCode: $('#auth-invite').value }));
$('#send-bind-code').addEventListener('click', () => sendEmailCode($('#send-bind-code'), $('#bind-code-status'), { purpose: 'bind', email: $('#account-email').value.trim(), password: $('#email-password').value }));
$('#auth-email').addEventListener('input', () => { $('#auth-email-code').value = ''; });
$('#account-email').addEventListener('input', () => { $('#account-email-code').value = ''; });

function showRecoveryCode(code) {
  $('#recovery-code-value').textContent = code;
  $('#recovery-code-screen').classList.remove('hidden');
  $('#close-recovery-code').focus();
}
$('#copy-recovery-code').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#recovery-code-value').textContent); toast('恢复码已复制'); }
  catch { toast('复制失败，请手动选择恢复码', true); }
});
$('#close-recovery-code').addEventListener('click', () => {
  $('#recovery-code-screen').classList.add('hidden');
  $('#recovery-code-value').textContent = '';
});

$('#auth-form').addEventListener('submit', (event) => {
  event.preventDefault();
  withButton($('#auth-submit'), async () => {
    const body = authMode === 'recover'
      ? { username: $('#auth-username').value.trim(), recoveryCode: $('#auth-recovery-code').value.trim(), newPassword: $('#auth-password').value }
      : { username: $('#auth-username').value.trim(), password: $('#auth-password').value, email: authMode === 'register' && emailVerificationEnabled ? $('#auth-email').value.trim() : undefined, emailCode: authMode === 'register' && emailVerificationEnabled ? $('#auth-email-code').value.trim() : undefined, inviteCode: $('#auth-invite').value };
    const state = await api(`/api/auth/${authMode}`, 'POST', body);
    $('#auth-password').value = '';
    $('#auth-recovery-code').value = '';
    $('#auth-email-code').value = '';
    const { recoveryCode, ...workspace } = state;
    showWorkspace(workspace);
    if (recoveryCode) showRecoveryCode(recoveryCode);
  });
});

$('#email-form').addEventListener('submit', (event) => {
  event.preventDefault();
  withButton($('#email-form button'), async () => {
    appState = await api('/api/auth/profile', 'PUT', { email: $('#account-email').value.trim(), password: $('#email-password').value, emailCode: $('#account-email-code').value.trim() });
    $('#email-password').value = '';
    $('#account-email-code').value = '';
    $('#account-email').value = appState.user.email;
    $('#email-status').textContent = appState.user.emailVerified ? `已验证：${appState.user.email}` : '尚未绑定邮箱';
    $('#bind-code-status').textContent = '修改邮箱需验证新地址；留空邮箱可解除绑定。';
    toast(appState.user.emailVerified ? '邮箱已验证并绑定' : '邮箱已解除绑定');
  });
});

$('#password-form').addEventListener('submit', (event) => {
  event.preventDefault();
  withButton($('#password-form button'), async () => {
    await api('/api/auth/change-password', 'POST', { currentPassword: $('#current-password').value, newPassword: $('#new-password').value });
    $('#current-password').value = '';
    $('#new-password').value = '';
    toast('密码已修改，其他设备需要重新登录');
  });
});

$('#rotate-code-form').addEventListener('submit', (event) => {
  event.preventDefault();
  withButton($('#rotate-code-form button'), async () => {
    const result = await api('/api/auth/recovery-code/rotate', 'POST', { password: $('#rotate-code-password').value });
    $('#rotate-code-password').value = '';
    $('#recovery-code-status').textContent = '已设置恢复码。生成新码后，旧码立即失效。';
    showRecoveryCode(result.recoveryCode);
  });
});

$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/auth/logout', 'POST'); showAuth(); appState = { settings: { webhooks: [] }, monitors: [], events: [], logs: [], sentCount: 0 }; }
  catch (error) { toast(error.message, true); }
});

$('#add-webhook').addEventListener('click', () => {
  if (draftHooks.length >= 20) return toast('最多添加 20 个 Webhook 地址', true);
  openWebhookDrawer();
});
$('#webhook-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-hook-action="edit"]');
  if (!button) return;
  const hook = draftHooks.find((item) => item.id === button.closest('.webhook-row').dataset.id);
  if (hook) openWebhookDrawer(hook);
});
$('#drawer-close').addEventListener('click', closeWebhookDrawer);
$('#drawer-backdrop').addEventListener('click', closeWebhookDrawer);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#webhook-drawer').classList.contains('hidden')) closeWebhookDrawer();
});
function updateHookPriorityVisibility() {
  const fields = $('#drawer-fields');
  if (!fields.querySelector('.hook-format')) return;
  const format = fields.querySelector('.hook-format').value;
  const url = fields.querySelector('.hook-url').value;
  fields.querySelector('.hook-priority-line').classList.toggle('hidden', !(format === 'ntfy' || format === 'auto' && /^https?:\/\/ntfy\.sh\//i.test(url)));
}
$('#drawer-fields').addEventListener('input', updateHookPriorityVisibility);
$('#drawer-fields').addEventListener('change', updateHookPriorityVisibility);
async function saveDrawer() {
  if (!editingHookDraft) return null;
  const fields = $('#drawer-fields');
  const hook = {
    ...editingHookDraft,
    name: fields.querySelector('.hook-name').value.trim(),
    url: fields.querySelector('.hook-url').value.trim(),
    enabled: fields.querySelector('.hook-enabled').checked,
    format: fields.querySelector('.hook-format').value,
    priority: Number(priorityValue(fields.querySelector('.hook-priority')) || 3)
  };
  if (!hook.url) throw new Error('请填写 Webhook 地址');
  const index = draftHooks.findIndex((item) => item.id === hook.id);
  const previous = draftHooks.map((item) => ({ ...item }));
  if (index < 0) draftHooks.push(hook);
  else draftHooks[index] = hook;
  try { await saveSettings(true); }
  catch (error) { draftHooks = previous; renderWebhooks(); throw error; }
  closeWebhookDrawer();
  toast('渠道已保存');
  return hook.id;
}
$('#drawer-save').addEventListener('click', () => withButton($('#drawer-save'), saveDrawer));
$('#drawer-test').addEventListener('click', () => withButton($('#drawer-test'), async () => {
  const id = await saveDrawer();
  if (!id) return;
  const report = await api('/api/test-webhook', 'POST', { webhookId: id });
  appState = await api('/api/state');
  render(true);
  toast(report.failed.length ? report.failed[0].name + '：' + report.failed[0].error : '测试通知已发送', Boolean(report.failed.length));
}));
$('#drawer-delete').addEventListener('click', () => withButton($('#drawer-delete'), async () => {
  if (!editingHookDraft) return;
  const id = editingHookDraft.id;
  const usedBy = appState.monitors.filter((monitor) => monitor.webhookIds?.includes(id)).length;
  if (usedBy && !confirm('这个渠道被 ' + usedBy + ' 个任务使用。删除后这些任务的接收渠道会更新，继续吗？')) return;
  const previous = draftHooks.map((item) => ({ ...item }));
  draftHooks = draftHooks.filter((hook) => hook.id !== id);
  try { await saveSettings(true); }
  catch (error) { draftHooks = previous; renderWebhooks(); throw error; }
  closeWebhookDrawer();
  toast('渠道已删除');
}));
$('#settings-form').addEventListener('input', () => { $('#settings-dirty').textContent = '未保存'; });
$('#settings-form').addEventListener('change', () => { $('#settings-dirty').textContent = '未保存'; });

$('#settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  withButton($('#save-button'), () => saveSettings());
});

$('#ai-test-button').addEventListener('click', () => {
  withButton($('#ai-test-button'), async () => {
    const result = $('#ai-test-result');
    result.textContent = '正在连接…';
    result.className = '';
    try {
      const report = await api('/api/ai/test', 'POST', { aiBaseUrl: $('#ai-base-url').value.trim(), aiModel: $('#ai-model').value.trim(), aiKey: $('#ai-key').value.trim() });
      result.textContent = `连接成功 · ${report.durationMs} ms`;
      result.className = 'success';
      api('/api/state').then((state) => { appState = state; render(); }).catch(() => {});
    } catch (error) {
      result.textContent = error.message;
      result.className = 'error';
      throw error;
    }
  });
});
$('#clear-ai-key-button').addEventListener('click', () => {
  withButton($('#clear-ai-key-button'), async () => {
    appState = await api('/api/ai/key', 'DELETE');
    $('#ai-key').value = '';
    render();
    toast('已清除保存的 API Key');
  });
});
for (const selector of ['#ai-base-url', '#ai-model', '#ai-key']) {
  $(selector).addEventListener('input', () => { $('#ai-test-result').textContent = ''; $('#ai-test-result').className = ''; });
}

$('#send-form').addEventListener('submit', (event) => {
  event.preventDefault();
  withButton($('#send-button'), async () => {
    await ensureSettings();
    const ids = selectedIds($('#send-targets'));
    if (!ids.length) throw new Error('请至少选择一个接收渠道');
    const report = await api('/api/send', 'POST', { title: $('#send-title').value, message: $('#send-message').value, webhookIds: ids, priority: hasNtfyTarget(ids) ? priorityValue($('#send-priority')) : null });
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
    const instruction = $('#instruction').value.trim();
    resetAssistant(instruction);
    previewMonitor = null;
    $('#preview').classList.add('hidden');
    if (!instruction) {
      addAssistantMessage('assistant', '告诉我你想关注什么，或者希望什么时候收到提醒。');
      assistantPhase('need_more_info');
      $('#assistant-reply').focus();
      return;
    }
    addAssistantMessage('user', instruction);
    await askAssistant();
  });
});

$('#assistant-reset').addEventListener('click', () => {
  resetAssistant();
  previewMonitor = null;
  $('#preview').classList.add('hidden');
  $('#instruction').value = '';
  $('#instruction-url').value = '';
  $('#instruction').focus();
});$('#assistant-reply-form').addEventListener('submit', (event) => {
  event.preventDefault();
  withButton($('#assistant-reply-button'), async () => {
    const reply = $('#assistant-reply').value.trim();
    if (!reply) return;
    if (!assistantInstruction) assistantInstruction = reply;
    else assistantConversation.push({ role: 'user', content: reply });
    addAssistantMessage('user', reply);
    $('#assistant-reply').value = '';
    await askAssistant();
  });
});
$('#preview').addEventListener('click', (event) => {
  if (event.target.closest('#preview-revise-button')) {
    $('#assistant-dialog').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#assistant-reply').focus();
    return;
  }
  if (event.target.closest('#preview-check-button')) {
    withButton($('#preview-check-button'), async () => {
      const resultBox = $('#preview-result');
      try {
        const result = await api('/api/preview-check', 'POST', collectPreviewRule());
        resultBox.className = `preview-result ${result.healthy === false ? 'error' : 'success'}`;
        resultBox.textContent = `来源检查完成 · ${result.status ? `HTTP ${result.status} · ` : ''}${result.summary}`;
        appState = await api('/api/state');
        render();
      } catch (error) {
        resultBox.className = 'preview-result error';
        resultBox.textContent = `来源测试失败：${error.message}`;
        throw error;
      }
    });
    return;
  }
  if (!event.target.closest('#create-button')) return;
  withButton($('#create-button'), async () => {
    try { await ensureSettings(); }
    catch (error) {
      $('#preview-result').className = 'preview-result error';
      $('#preview-result').textContent = error.message;
      addAssistantMessage('assistant', `规则已准备好，但设置需要处理：${error.message}。请检查通知渠道后再确认。`);
      $('#settings').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const rule = collectPreviewRule();
    appState = await api('/api/monitors', 'POST', rule);
    const created = appState.monitors[0];
    previewMonitor = null;
    $('#preview').classList.add('hidden');
    resetAssistant();
    addAssistantMessage('assistant', created.kind === 'reminder' ? '提醒已创建，将在' + reminderDate(created.remindAt) + '发送。' : '监控“' + created.label + '”已创建，之后会按规则自动检查。');
    assistantPhase('created');
    $('#instruction').value = '';
    $('#instruction-url').value = '';
    render(true);
    toast(created.kind === 'reminder' ? '提醒已创建，等待发送时间' : created.lastError ? '监控已创建，首次检查失败：' + created.lastError : '监控已创建，首次检查已完成', Boolean(created.lastError));
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
      const rule = { label: editor.querySelector('.edit-label').value.trim(), priority: hasNtfyTarget(ids) ? priorityValue(editor.querySelector('.edit-priority')) : null };
      if (monitor.kind === 'reminder') {
        const time = new Date(editor.querySelector('.edit-remind-at').value);
        if (!Number.isFinite(time.getTime())) throw new Error('请填写有效的提醒时间');
        rule.remindAt = time.toISOString();
        rule.message = editor.querySelector('.edit-message').value.trim();
      } else rule.intervalMinutes = Number(editor.querySelector('.edit-interval').value);
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
      const check = appState.check;
      if (check.skipped) toast('任务正在检查，请稍后查看结果');
      else if (!check.checked) toast(check.error || updated.lastError || '检查失败', true);
      else if (check.sentCount > 0) toast(check.pendingCount ? `已发送至 ${check.sentCount} 个渠道，其余通知待重试` : `条件满足，已发送至 ${check.sentCount} 个渠道`, Boolean(check.pendingCount));
      else if (check.triggered) toast(updated.lastError || '条件满足，但通知未送达', true);
      else if (check.pendingCount) toast(updated.lastError || '仍有通知待发送', true);
      else if (check.conditionSatisfied === false) toast('检查完成，当前条件未满足');
      else toast('检查完成，没有发现新变化');
    } else if (action === 'toggle') {
      appState = await api(path, 'PATCH', { enabled: !monitor.enabled });
      toast(monitor.kind === 'reminder' ? monitor.enabled ? '提醒已暂停' : '提醒已继续' : monitor.enabled ? '监控已暂停' : '监控已继续');
    } else if (action === 'delete') {
      appState = await api(path, 'DELETE');
      toast(monitor.kind === 'reminder' ? '提醒已删除' : '监控已删除');
    }
    render(true);
  });
});

async function init() {
  try {
    const status = await api('/api/auth/status');
    if (status.signupCodeRequired) $('#auth-screen').dataset.signupCodeRequired = '1';
    emailVerificationEnabled = Boolean(status.emailVerificationEnabled);
    setAuthMode(authMode);
    if (status.authenticated) showWorkspace(await api('/api/state'));
    else showAuth();
    setInterval(async () => {
      if ($('.app-shell').classList.contains('auth-hidden')) return;
      try { appState = await api('/api/state'); render(); } catch (error) { if (error.message === '请先登录') showAuth(); }
    }, 30000);
  } catch (error) { showAuth(); toast(`无法连接本地服务：${error.message}`, true); }
}
$('#send-priority-slot').innerHTML = priorityPicker('send-priority', null, true);
setAuthMode('login');
init();
