const $ = (selector) => document.querySelector(selector);
let appState = { settings: { webhooks: [] }, monitors: [], events: [], logs: [], sentCount: 0 };
let previewMonitor = null;
let editingMonitor = null;
let assistantInstruction = '';
let assistantConversation = [];
let assistantMessages = [];
let assistantRequestId = 0;
let draftHooks = [];
let editingHookDraft = null;
let drawerReturnFocus = null;
let toastTimer;
let authMode = 'login';
let emailVerificationEnabled = false;
let workspaceEpoch = 0;
let stateSyncVersion = 0;
let workspacePoll = null, workspaceTag = null;
let renderedMarkup = new WeakMap();
let aiInputRevision = 0;
const pendingActions = new Map();
const emailTimers = new Map();
let drawerAction = null;

function staleOperation() { const error = new Error('此操作所属的会话已结束'); error.code = 'STALE_OPERATION'; return error; }
function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else bytes.forEach((_, index) => { bytes[index] = Math.floor(Math.random() * 256); });
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
async function copyText(value) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; } } catch { /* fall back on HTTP or denied clipboard permission */ }
  const focused = document.activeElement, input = document.createElement('textarea');
  input.value = value; input.readOnly = true; input.style.cssText = 'position:fixed;left:-10000px;top:0';
  document.body.append(input); input.select();
  try { if (!document.execCommand('copy')) throw new Error('复制失败，请手动选择内容'); }
  finally { input.remove(); if (focused?.isConnected) focused.focus(); }
}


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
const pageNames = { top: '概览', create: '智能创建', monitors: '任务与提醒', notifications: '快速发送', channels: '通知渠道', 'ai-settings': 'AI 设置', 'fetch-settings': '读取设置', activity: '活动与日志', account: '账户安全' };
function syncNavigation(resetScroll = false) {
  const requested = (location.hash || '#top').slice(1);
  const view = requested === 'orders' ? 'monitors' : requested === 'settings' ? 'ai-settings' : requested in pageNames ? requested : 'top';
  sidebarShell.dataset.view = view;
  const current = view === 'top' ? '#top' : '#' + view;
  document.querySelectorAll('.side-nav .nav-link').forEach((link) => {
    const active = link.getAttribute('href') === current;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  const pageLabel = editingMonitor && view === 'create' ? '修改任务' : pageNames[view];
  $('#current-page-label').textContent = pageLabel;
  $('#settings-page-title').textContent = view === 'ai-settings' ? 'AI 设置' : '通知渠道';
  $('#settings-page-subtitle').textContent = view === 'ai-settings' ? '配置生成规则所用的模型与 API。' : '管理 Webhook 接收地址与发送方式。';
  $('#save-button').textContent = '保存 AI 设置';
  document.title = pageLabel + ' · Webhook Radar';
  if (resetScroll) requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }));
}
window.addEventListener('hashchange', () => syncNavigation(true));
syncNavigation();

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const activeHooks = () => (appState.settings.webhooks || []).filter((hook) => hook.enabled);
const isNtfyHook = (hook) => hook.format === 'ntfy' || (!hook.format || hook.format === 'auto') && /^https?:\/\/ntfy\.sh\//i.test(hook.url);
const selectedIds = (root) => [...root.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
const hasNtfyTarget = (ids) => activeHooks().some((hook) => ids.includes(hook.id) && isNtfyHook(hook));

const shanghaiLogFormatter=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hourCycle:'h23'});
function shanghaiLogTime(value){const date=new Date(value);return Number.isFinite(date.getTime())?shanghaiLogFormatter.format(date).replace(',','.'):'';}
function shanghaiLogRecord(value){
  if(Array.isArray(value))return value.map(shanghaiLogRecord);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,typeof item==='string'&&/^(?:at|.*At|.*_at)$/.test(key)&&/^\d{4}-\d{2}-\d{2}T/.test(item)&&shanghaiLogTime(item)?shanghaiLogTime(item).replace(' ','T')+'+08:00':shanghaiLogRecord(item)]));
  return value;
}
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

async function api(path, method = 'GET', body, options = {}) {
  const requestId = randomId(), epoch = workspaceEpoch;
  const assertCurrent = () => { if (epoch !== workspaceEpoch) throw staleOperation(); };
  let response;
  try {
    response = await fetch(path, { method, signal: options.signal, headers: { 'x-radar-request-id': requestId, ...(options.etag ? { 'if-none-match': options.etag } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (cause) {
    assertCurrent();
    const error = new Error((options.signal?.aborted ? '操作超时，请查看账户状态后再继续。请求 ' : '页面与 Radar 服务的连接中断，请检查服务或反向代理是否正常。请求 ') + requestId + ' · ' + method + ' ' + path);
    error.code = 'RADAR_CONNECTION_FAILED'; error.requestId = requestId; error.cause = cause;
    throw error;
  }
  if (options.allowNotModified && response.status === 304) { assertCurrent(); return null; }
  let result;
  try { result = await response.json(); }
  catch {
    assertCurrent();
    const error = new Error('Radar 返回 HTTP ' + response.status + '，但响应不是有效 JSON。请检查反向代理和服务日志。请求 ' + requestId + ' · ' + path);
    error.code = 'RADAR_INVALID_RESPONSE'; error.requestId = requestId;
    throw error;
  }
  assertCurrent();
  if (!response.ok) {
    const error = new Error(result.error || '请求失败：HTTP ' + response.status);
    error.code = result.code; error.requestId = result.requestId || requestId; error.status = response.status;
    throw error;
  }
  if (options.responseInfo) options.responseInfo.etag = response.headers.get('etag');
  return result;
}

function targetOptions(ids, emptyText = '请先添加并保存一个启用的 Webhook 地址。') {
  if (!activeHooks().length) return `<div class="target-empty">${emptyText} <a href="#channels">前往通知渠道 ↗</a></div>`;
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
  $('#ai-status').textContent = appState.settings.hasAiKey && appState.settings.aiModel ? `点击后使用 ${appState.settings.aiModel} 生成本次规则或提醒` : '先在 AI 设置中连接模型，生成方案时才会调用';
}


function usesNetworkSource(monitor) {
  return monitor.kind !== 'reminder' && !(monitor.kind === 'generated' && monitor.plan?.sourceType === 'log');
}
function proxyProfileOptions(selected = '') {
  return '<option value="">手动填写</option>' + (appState.settings.sourceProxies || []).map(item=>'<option value="'+escapeHtml(item.id)+'" '+(item.id===selected?'selected':'')+'>'+escapeHtml(item.name+' · '+item.endpoint)+'</option>').join('');
}
function readSourceProxyId(root) { return root.querySelector('.source-fetch-proxy')?.value === 'custom' ? root.querySelector('.source-proxy-id')?.value || '' : ''; }
function readCreateSourceSettings() {
  const proxy = $('#create-proxy-mode').value, sourceProxy = $('#create-source-proxy').value.trim();
  const sourceProxyId = $('#create-source-proxy-id').value;
  if (proxy === 'custom' && !sourceProxy && !sourceProxyId) throw new Error('请填写此任务的代理地址，或选择账户默认／直接连接');
  return { fetch: { mode: 'auto', proxy }, ...(proxy === 'custom' ? sourceProxyId ? {sourceProxyId} : { sourceProxy } : {}) };
}
$('#create-proxy-mode').addEventListener('change', () => $('#create-proxy-address').classList.toggle('hidden', $('#create-proxy-mode').value !== 'custom'));
$('#create-source-proxy-id').addEventListener('change',()=>{ $('#create-source-proxy').value=''; $('#create-source-proxy').disabled=Boolean($('#create-source-proxy-id').value); });
function sourceRouteLabel(monitor) {
  const proxy = monitor.fetch?.proxy || 'default';
  if (proxy === 'custom') return '独立代理 · ' + (monitor.sourceProxyEndpoint || '待配置') + (monitor.sourceProxyTest?.ip ? ' · 出口 IP ' + monitor.sourceProxyTest.ip : '');
  if (proxy === 'direct') return '直接连接';
  return appState.settings.hasSourceProxy ? '账户默认代理 · ' + appState.settings.sourceProxyEndpoint : '账户默认 · 服务器出口';
}
function intervalLabel(minutes) {
  const seconds = Math.round(Number(minutes) * 60000) / 1000;
  if (seconds < 60) return seconds + ' 秒';
  if (seconds % 3600 === 0) return seconds / 3600 + ' 小时';
  return Number((seconds / 60).toFixed(4)) + ' 分钟';
}
function intervalFields(monitor, scope) {
  const minutes = Number(monitor.intervalMinutes) || 5;
  const unit = minutes < 1 ? 'seconds' : minutes % 60 === 0 ? 'hours' : 'minutes';
  const value = unit === 'seconds' ? Number((minutes * 60).toFixed(4)) : unit === 'hours' ? minutes / 60 : minutes;
  const attr = scope === 'edit' ? 'class="edit-interval"' : 'id="rule-interval"';
  return '<label>多久检查一次<div class="interval-control"><input ' + attr + ' type="number" min="0" step="any" value="' + value + '" aria-label="检查间隔"><select class="interval-unit" aria-label="检查间隔单位">'
    + [['seconds', '秒'], ['minutes', '分钟'], ['hours', '小时']].map(([key, name]) => '<option value="' + key + '" ' + (key === unit ? 'selected' : '') + '>' + name + '</option>').join('') + '</select></div><span class="field-help">支持 1 秒起的周期，修改后保留检测记录。</span></label>';
}
function readInterval(root, selector) {
  const value = Number(root.querySelector(selector).value);
  const unit = root.querySelector('.interval-unit')?.value || 'minutes';
  const minutes = value * ({ seconds: 1 / 60, minutes: 1, hours: 60 }[unit]);
  if (!Number.isFinite(minutes) || minutes < 1 / 60 || !Number.isSafeInteger(Math.round(minutes * 60000))) throw new Error('请输入至少 1 秒的有效检查间隔');
  return minutes;
}
function sourceFetchFields(monitor) {
  if (!usesNetworkSource(monitor)) return '';
  const mode = monitor.fetch?.mode || 'auto', proxy = monitor.fetch?.proxy || 'default';
  const service = monitor.kind === 'unified' && monitor.extraction_rule?.kind === 'service' || monitor.kind === 'generated' && monitor.plan?.sourceType === 'service';
  const method = service ? '<input type="hidden" class="source-fetch-mode" value="http"><p class="field-help editor-wide">通过下方选择的出口检测服务状态。</p>' : '<label>读取方式<select class="source-fetch-mode">'
    + [['auto', '自动'], ['browser', '浏览器'], ['http', '直接请求']].map(([value, name]) => '<option value="' + value + '" ' + (mode === value ? 'selected' : '') + '>' + name + '</option>').join('') + '</select></label>';
  return method + '<label>网络出口<select class="source-fetch-proxy"><option value="default" ' + (proxy === 'default' ? 'selected' : '') + '>账户设置' + (appState.settings.hasSourceProxy ? ' · 使用代理' : ' · 服务器出口') + '</option><option value="direct" ' + (proxy === 'direct' ? 'selected' : '') + '>直接连接</option><option value="custom" ' + (proxy === 'custom' ? 'selected' : '') + '>独立代理</option></select></label>'
    + '<div class="source-custom-proxy editor-wide ' + (proxy === 'custom' ? '' : 'hidden') + '"><label>选择已保存代理<select class="source-proxy-id">' + proxyProfileOptions(monitor.sourceProxyId) + '</select></label><label>此任务的代理地址<input class="source-proxy-input" '+(appState.settings.sourceProxies?.some(item=>item.id===monitor.sourceProxyId)?'disabled':'')+' type="password" autocomplete="new-password" spellcheck="false" value="' + escapeHtml(monitor.sourceProxy || '') + '" placeholder="' + (monitor.hasSourceProxy ? '已保存独立代理；留空保持当前地址' : 'http://user:pass@host:port 或 ss://…') + '"></label>'
    + '<div class="rule-proxy-actions"><button type="button" class="button button-outline" data-source-proxy-test>测试独立代理</button><span class="rule-proxy-result" role="status">' + escapeHtml(monitor.sourceProxyEndpoint ? monitor.sourceProxyEndpoint + (monitor.sourceProxyTest?.ip ? ' · ' + sourceConnectionSummary(monitor.sourceProxyTest) : '') + (monitor.sourceProxyTest?.testedAt ? ' · 验证于 ' + new Date(monitor.sourceProxyTest.testedAt).toLocaleString('zh-CN') : '') : '保存前会验证代理连通性；验证失败保留原设置。') + '</span></div></div>'
    + '<p class="field-help editor-wide">自动读取会在需要时尝试浏览器。独立代理只用于当前任务。</p>';
}
function readSourceProxy(root, monitor) {
  const custom = root.querySelector('.source-fetch-proxy')?.value === 'custom';
  const value = root.querySelector('.source-proxy-input')?.value.trim();
  if (readSourceProxyId(root)) return undefined;
  if (custom && !value && !monitor.hasSourceProxy && !monitor.sourceProxy) throw new Error('请填入此任务的独立代理地址，或选择账户默认／直接连接');
  return custom ? value || monitor.sourceProxy || undefined : undefined;
}
function readSourceFetch(root, monitor) {
  return root.querySelector('.source-fetch-mode') ? { mode: root.querySelector('.source-fetch-mode').value, proxy: root.querySelector('.source-fetch-proxy').value } : monitor.fetch;
}
function ruleSections(sections, token) {
  return '<div class="rule-panel-editor">' + sections.map(([name, content, key], i) => '<section class="rule-section" data-rule-section="' + (key || i) + '" id="' + escapeHtml(token) + '-section-' + i + '"><h3>' + name + '</h3><div class="rule-section-content">' + content + '</div></section>').join('') + '</div>';
}

function conditionFields(monitor, scope) {
  const attr = (key) => scope === 'edit' ? 'class="edit-' + key + '"' : 'id="rule-' + key + '"';
  const field = (name, key, value, type = 'text') => '<label>' + name + '<input ' + attr(key) + ' type="' + type + '" value="' + escapeHtml(value || '') + '"></label>';
  const select = (name, key, options) => '<label>' + name + '<select ' + attr(key) + '>' + options + '</select></label>';
  if (monitor.kind === 'unified') return '<div class="unified-basic-fields rule-fields">' + unifiedConditionFields(monitor) + '</div><div class="element-actions"><button type="button" class="button button-outline" data-rule-analyze>重新分析目标</button><button type="button" class="button button-outline" data-rule-pick>选择网页元素</button></div>';
  if (monitor.kind === 'generated') return '<p class="plain-rule-summary">' + escapeHtml(friendlyRule(monitor)) + '</p><div class="plain-plan-fields">' + basicPlanFields(monitor.plan) + '</div>';
  if (monitor.kind === 'webpage') return field('要关注的文字', 'keyword', monitor.keyword) + select('什么时候提醒', 'mode', '<option value="contains" ' + (monitor.mode === 'contains' ? 'selected' : '') + '>文字出现时</option><option value="absent" ' + (monitor.mode === 'absent' ? 'selected' : '') + '>文字消失时</option>');
  if (monitor.kind === 'dmit') return select('什么时候提醒', 'trigger-mode', '<option value="restock" ' + (monitor.triggerMode !== 'any-available' ? 'selected' : '') + '>由无货变为有货</option><option value="any-available" ' + (monitor.triggerMode === 'any-available' ? 'selected' : '') + '>任意有货 · 首次满足也通知</option>');
  if (monitor.kind === 'json') return select('满足什么条件', 'operator', operatorOptions(monitor.operator)) + field('关注的内容或数值', 'expected', monitor.expected)
    + field('读取哪个字段', 'json-path', monitor.jsonPath);
  if (monitor.kind === 'rss') return field('新内容标题包含（选填）', 'keyword', monitor.keyword);
  return '<p class="field-help editor-wide">' + escapeHtml(friendlyRule(monitor)) + '</p>';
}
function taskEditor(monitor, scope = 'edit') {
  const edit = scope === 'edit', token = edit ? 'task-' + monitor.id : 'draft';
  const attr = key => edit ? 'class="edit-' + key + '"' : 'id="rule-' + key + '"';
  const field = (name, key, value, type = 'text', extra = '') => '<label>' + name + '<input ' + attr(key) + ' type="' + type + '" ' + extra + ' value="' + escapeHtml(value) + '"></label>';
  const priority = '<div class="priority-field ' + (hasNtfyTarget(monitor.webhookIds || []) ? '' : 'hidden') + '"><span>ntfy 优先级</span>' + priorityPicker(edit ? 'edit-priority-' + monitor.id : 'rule-priority', monitor.priority, true, edit ? 'edit-priority' : '') + '</div>';
  const targets = edit ? '<div class="field-label">接收渠道</div><div class="target-options">' + targetOptions(monitor.webhookIds || []) + '</div>' : '';
  const notification = targets + priority + (edit ? notificationFields(monitor) : '');
  const basic = '<div class="rule-fields">' + field(monitor.kind === 'reminder' ? '提醒名称' : '任务名称', 'label', monitor.label, 'text', 'maxlength="60"') + (monitor.kind === 'reminder' ? field('首次发送时间', 'remind-at', reminderInput(monitor.remindAt), 'datetime-local') + repeatFields(scope, monitor.repeatMinutes) : intervalFields(monitor, scope)) + '</div>';
  const sections = [['任务信息', basic, 'basics']];
  if (monitor.kind === 'reminder') sections.push(['提醒内容', '<label>到时提醒什么<textarea ' + attr('message') + ' rows="3" maxlength="2000">' + escapeHtml(monitor.message) + '</textarea></label>', 'conditions']);
  else sections.push(['提醒条件', '<div class="rule-fields">' + conditionFields(monitor, scope) + '</div>', 'conditions']);
  if (notification) sections.push(['通知', notification, 'notifications']);
  if (monitor.kind !== 'reminder') sections.push(['读取设置', '<div class="rule-fields">' + (monitor.kind !== 'dmit' ? field('监控地址或日志文件', 'url', monitor.url, 'text') : '<p class="field-help">使用第三方库存数据源。</p>') + sourceFetchFields(monitor) + '</div>', 'source']);
  let wrapper = '', raw = '';
  if (monitor.kind === 'unified') {
    wrapper = 'unified-rule-editor';
    const editable = { type: monitor.type, detection_method: monitor.detection_method, target_element: monitor.target_element, extraction_rule: monitor.extraction_rule, condition: monitor.condition };
    raw = '<textarea class="unified-json hidden" aria-hidden="true">' + escapeHtml(JSON.stringify(editable, null, 2)) + '</textarea><p class="unified-error" role="status"></p>';
    if (edit) sections.push(['检测依据', unifiedSummary(monitor) + stockModelSummary(monitor) + (monitor.repair_suggestion || monitor.lastError ? '<button type="button" class="button button-outline" data-action="rule-repair" data-id="' + escapeHtml(monitor.id) + '">修复检测规则</button>' : ''), 'evidence']);
  } else if (monitor.kind === 'generated') {
    wrapper = 'generated-plan-editor';
    raw = '<textarea data-plan-json ' + (edit ? 'class="edit-plan hidden" id="edit-plan-' + escapeHtml(monitor.id) + '"' : 'class="hidden" id="rule-plan"') + ' aria-hidden="true">' + escapeHtml(JSON.stringify(monitor.plan, null, 2)) + '</textarea><p class="advanced-feedback" role="status"></p>';
  }
  if (edit && monitor.kind !== 'reminder' && typeof renderMonitorOrder === 'function') sections.push(['自动下单（选填）', renderMonitorOrder(monitor), 'order']);
  if (edit) sections.push(['检测记录', '<div class="record-heading"><span>最近的检查与发送</span><button type="button" class="mini-button" data-action="rule-logs" data-id="' + escapeHtml(monitor.id) + '">刷新记录</button></div><div class="task-records" role="log">正在读取记录…</div>', 'records']);
  const content = ruleSections(sections, token) + raw;
  return wrapper ? '<div class="' + wrapper + '">' + content + '</div>' : content;
}

let activeTaskId = null;
let taskListScroll = 0;
function openTaskEditor(monitor, focusSection) {
  if (!activeTaskId) taskListScroll = window.scrollY;
  activeTaskId = monitor.id;
  $('#task-editor-title').textContent = monitor.label;
  $('#task-editor-body').innerHTML = '<div class="monitor-route" data-id="' + escapeHtml(monitor.id) + '" data-revision="' + (monitor.revision || 0) + '">' + taskEditor(monitor) + '</div>';
  $('#task-save').dataset.id = monitor.id;
  $('#task-list-view').classList.add('hidden');
  $('#task-workspace').classList.remove('hidden');
  $('#task-save-status').textContent = '修改后点击保存';
  const editor = $('#task-workspace .monitor-route');
  refreshChoices(editor);
  if (typeof mountMonitorOrder === 'function') mountMonitorOrder(monitor);
  const notification = editor.querySelector('.notification-editor');
  if (notification) attachNotification(notification, () => ({ ...monitor, ...readSavedRule(editor, monitor).rule, webhookIds: selectedIds(editor.querySelector('.target-options')) }), monitor.id);
  showRuleLogs(monitor).catch(error => { if (editor.isConnected) editor.querySelector('.task-records').textContent = error.message; });
  if (focusSection) editor.querySelector('[data-rule-section="' + focusSection + '"]')?.scrollIntoView({ block: 'start', behavior: 'instant' });
  else window.scrollTo({ top: 0, behavior: 'instant' });
}
function closeTaskEditor() {
  if(typeof closeRuleDialogs==='function')closeRuleDialogs();
  if (typeof resetOrderUI === 'function') resetOrderUI();
  const root = $('#task-workspace .notification-editor'), state = notificationEditors.get(root);
  if (state) { clearTimeout(state.timer); state.sequence++; }
  activeTaskId = null;
  $('#task-editor-body').innerHTML = '';
  $('#task-inspection').innerHTML = '';
  $('#task-inspection').classList.add('hidden');
  $('#task-workspace').classList.add('hidden');
  $('#task-list-view').classList.remove('hidden');
  window.scrollTo({ top: taskListScroll, behavior: 'instant' });
}
$('#task-close').addEventListener('click', closeTaskEditor);

function setListMarkup(element, html) {
  if (renderedMarkup.get(element) === html && element.childNodes.length) return;
  element.innerHTML = html;
  renderedMarkup.set(element, html);
}

function refreshRelativeTimes() {
  for (const element of document.querySelectorAll('[data-relative-time]')) {
    const text = relativeTime(element.dataset.relativeTime);
    if (element.textContent !== text) element.textContent = text;
  }
}

function renderMonitors() {
  const list = $('#monitor-list');
  if (!appState.monitors.length) {
    $('#task-no-results').classList.add('hidden');
    setListMarkup(list, '<div class="empty-state"><strong>还没有任务</strong><span>创建监控或定时提醒，让关心的事自动通知你。</span><a class="button button-primary" href="#create">创建第一个任务</a></div>');
    return;
  }
  setListMarkup(list, appState.monitors.map(monitor => {
    const reminder = monitor.kind === 'reminder';
    const status = monitor.completedAt ? ['已发送', ''] : !monitor.enabled ? ['已暂停', 'paused'] : monitor.lastSourceError === 'SOURCE_CHALLENGE' ? ['等待网站验证', 'error'] : monitor.lastError ? [reminder ? '发送待重试' : '检查异常', 'error'] : reminder ? ['等待提醒', 'paused'] : monitor.baselined ? ['运行中', ''] : ['等待检查', 'paused'];
    const recipients = (monitor.webhookIds || []).map(id => appState.settings.webhooks.find(hook => hook.id === id)?.name).filter(Boolean).join('、') || '未设置';
    const meta = reminder ? escapeHtml(repeatLabel(monitor.repeatMinutes) + (monitor.completedAt ? ' · 已完成' : ' · 下次 ' + reminderDate(monitor.remindAt))) : escapeHtml('每 ' + intervalLabel(monitor.intervalMinutes) + ' 检查 · ') + '<span data-relative-time="' + escapeHtml(monitor.lastCheckAt || '') + '">' + escapeHtml(relativeTime(monitor.lastCheckAt)) + '</span>';
    const id = escapeHtml(monitor.id), source = usesNetworkSource(monitor) ? sourceRouteLabel(monitor) : '';
    const result = monitor.lastError || (reminder ? monitor.completedAt ? '提醒已送达' : monitor.enabled ? '到时自动发送' : '提醒已暂停' : monitor.lastResult ? friendlyResult(monitor) : monitor.kind === 'unified' ? monitor.last_test_result?.summary || '等待首次检测' : '等待首次检查');
    const button = (action, label, style = '') => '<button type="button" class="mini-button ' + style + '" data-action="' + action + '" data-id="' + id + '">' + label + '</button>';
    return '<article class="monitor-item" data-monitor-id="' + id + '" data-kind="' + (reminder ? 'reminder' : 'monitor') + '"><div class="monitor-top"><div class="monitor-heading"><span class="monitor-type-label">' + escapeHtml(reminder ? '定时提醒' : ruleTypeNames[monitor.type] || '监控任务') + '</span><h3 class="monitor-name" title="' + escapeHtml(monitor.label) + '">' + escapeHtml(monitor.label) + '</h3></div><span class="monitor-status ' + status[1] + '">' + status[0] + '</span></div>'
      + '<div class="monitor-body"><div class="monitor-description" title="' + escapeHtml(reminder ? monitor.message : friendlyRule(monitor)) + '">' + escapeHtml(reminder ? monitor.message : friendlyRule(monitor)) + '</div><div class="monitor-current"><span>' + (monitor.lastError ? '需要处理' : reminder ? '提醒状态' : '当前结果') + '</span><strong class="' + (monitor.lastError ? 'monitor-error' : '') + '" title="' + escapeHtml(result) + '">' + escapeHtml(result) + '</strong></div></div>'
      + '<div class="monitor-schedule"><div class="monitor-meta">' + meta + '</div><div class="monitor-routing"><span>通知：' + escapeHtml(recipients) + '</span>' + (source ? '<span class="monitor-source-route">出口：' + escapeHtml(source) + '</span>' : '') + '</div></div>'
      + '<div class="monitor-actions"><div class="monitor-main-actions">' + button('edit', '编辑规则', 'task-edit') + (!monitor.completedAt ? button('toggle', monitor.enabled ? '暂停' : '继续') : '') + (!reminder ? button('check', '立即检查') : '') + '</div>' + button('delete', '删除', 'danger') + '</div></article>';
  }).join(''));
  filterMonitors();
}

function filterMonitors() {
  const filter = $('#task-filters [aria-pressed="true"]')?.dataset.taskFilter || 'all';
  const query = $('#task-search').value.trim().toLocaleLowerCase();
  let visible = 0;
  for (const item of $('#monitor-list').querySelectorAll('.monitor-item')) {
    const text = item.querySelector('.monitor-name').textContent + ' ' + item.querySelector('.monitor-description').textContent;
    const show = (filter === 'all' || item.dataset.kind === filter) && text.toLocaleLowerCase().includes(query);
    item.classList.toggle('hidden', !show);
    if (show) visible++;
  }
  $('#task-no-results').classList.toggle('hidden', visible > 0 || !appState.monitors.length);
}
$('#task-search').addEventListener('input', filterMonitors);
$('#task-filters').addEventListener('click', event => {
  const button = event.target.closest('[data-task-filter]');
  if (!button) return;
  for (const item of $('#task-filters').children) item.setAttribute('aria-pressed', String(item === button));
  filterMonitors();
});

function renderEvents() {
  const list = $('#activity-list');
  if (!appState.events.length) {
    setListMarkup(list, '<div class="activity-empty">还没有活动记录。发送一条测试通知试试。</div>');
    return;
  }
  setListMarkup(list, appState.events.slice(0, 8).map((event) => `<div class="activity-row"><span class="event-dot ${escapeHtml(event.type)}"></span><div><div class="event-title">${escapeHtml(event.title)}</div><div class="event-detail">${escapeHtml(event.detail)}</div><div class="event-time" data-relative-time="${escapeHtml(event.at)}">${escapeHtml(relativeTime(event.at))}</div></div></div>`).join(''));
}

function renderLogs() {
  const all = appState.logs || [];
  const logs = $('#log-errors-only').checked ? all.filter(entry => entry.status === 'error') : all;
  $('#log-count').textContent = '显示 ' + logs.length + ' 条';
  const list = $('#log-list'), scrollTop = list.scrollTop;
  setListMarkup(list, logs.length ? logs.map(entry => '<div class="log-row ' + (entry.status === 'error' ? 'log-error' : '') + '"><strong>' + escapeHtml({ monitor: '检查', webhook: '发送', simulation: '模拟发送', parse: '解析', preview: '来源测试', 'ai-test': 'AI 连接', 'proxy-test': '代理测试' }[entry.kind] || entry.kind) + ' · ' + (entry.status === 'error' ? '失败' : '成功') + '</strong><span>' + escapeHtml(shanghaiLogTime(entry.at)+' 上海时间') + ' · ' + escapeHtml(entry.durationMs) + ' ms</span><p>' + escapeHtml(entry.detail) + '</p>' + (entry.url ? '<small>' + escapeHtml(entry.url) + '</small>' : '') + (entry.raw ? '<button type="button" class="mini-button" data-view-log="' + escapeHtml(entry.id) + '">查看原始记录</button>' : '') + '</div>').join('') : '<p class="field-help">没有符合条件的日志。</p>');
  list.scrollTop = scrollTop;
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-view-log]');
  if (!button) return;
  const entry = (appState.logs || []).find(item => item.id === button.dataset.viewLog);
  if (!entry?.raw) return;
  const dialog = ruleDialog('原始记录');
  dialog.querySelector('.rule-dialog-body').innerHTML = '<button type="button" class="mini-button" data-copy-log="' + escapeHtml(entry.id) + '">复制原始记录</button><pre class="raw-record">' + escapeHtml(JSON.stringify(shanghaiLogRecord(entry.raw), null, 2)) + '</pre>';
});

function render(force = false, resetEditorId) {
  if (force) renderedMarkup = new WeakMap();
  renderStats();
  renderSourceSettings();
  renderMonitors();
  if (typeof renderOrders === 'function') renderOrders();
  if (activeTaskId && activeTaskId === resetEditorId) {
    const task = appState.monitors.find(item => item.id === activeTaskId);
    if (task) openTaskEditor(task); else closeTaskEditor();
  }
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
    + '<label class="drawer-switch"><input class="hook-enabled" type="checkbox" role="switch" ' + (hook.enabled !== false ? 'checked' : '') + '>启用此渠道</label>'
    + '<div class="hook-priority-line ' + (isNtfy ? '' : 'hidden') + '"><span>ntfy 默认优先级</span>' + priorityPicker('drawer-priority', hook.priority ?? 3, false, 'hook-priority') + '</div>';
}

function openWebhookDrawer(hook = null) {
  if (drawerAction) return;
  drawerReturnFocus = document.activeElement;
  editingHookDraft = hook ? { ...hook } : { id: randomId(), name: '', url: '', enabled: true, format: 'auto', priority: 3 };
  $('#drawer-title').textContent = hook ? '编辑渠道' : '添加渠道';
  $('#drawer-fields').innerHTML = hookFields(editingHookDraft);
  $('#drawer-delete').classList.toggle('hidden', !hook);
  $('#webhook-drawer').classList.remove('hidden');
  $('#drawer-backdrop').classList.remove('hidden');
  $('#drawer-fields .hook-name').focus();
}

function closeWebhookDrawer(force = false) {
  if (drawerAction && !force) return;
  editingHookDraft = null;
  $('#webhook-drawer').classList.add('hidden');
  $('#drawer-backdrop').classList.add('hidden');
  $('#drawer-fields').innerHTML = '';
  if (drawerReturnFocus?.isConnected) drawerReturnFocus.focus();
  drawerReturnFocus = null;
}
function updateSendPriorityVisibility() {
  const selected = new Set(selectedIds($('#send-targets')));
  $('#send-priority-wrap').classList.toggle('hidden', !hasNtfyTarget([...selected]));
}
function renderSendTargets(ids) { $('#send-targets').innerHTML = targetOptions(ids); updateSendPriorityVisibility(); }
$('#send-targets').addEventListener('change', updateSendPriorityVisibility);
$('#log-errors-only').addEventListener('change', renderLogs);
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-copy-log]');
  if (!button) return;
  const entry = (appState.logs || []).find((item) => item.id === button.dataset.copyLog);
  if (!entry?.raw) return;
  copyText(JSON.stringify(shanghaiLogRecord(entry.raw), null, 2)).then(() => toast('原始记录已复制')).catch(() => toast('复制失败，请手动选择日志内容', true));
});

function populateSettings() {
  draftHooks = (appState.settings.webhooks || []).map((hook) => ({ ...hook }));
  renderWebhooks();
  renderSendTargets();
  $('#ai-base-url').value = appState.settings.aiBaseUrl || 'https://api.openai.com/v1';
  $('#ai-model').value = appState.settings.aiModel || '';
  $('#ai-key').value = '';
  renderSourceSettings(true);
  $('#ai-test-result').textContent = '';
  $('#ai-test-result').className = '';
  $('#ai-test-log').classList.add('hidden');
  $('#settings-dirty').textContent = '';
}

function settingsBody(scope = 'ai') {
  if (scope === 'channels') return { webhooks: draftHooks.map((hook) => ({ ...hook })) };
  return { aiBaseUrl: $('#ai-base-url').value.trim(), aiModel: $('#ai-model').value.trim(), aiKey: $('#ai-key').value.trim() };
}

async function saveSettings(silent = false, scope = 'ai') {
  const inputRevision = aiInputRevision;
  const currentOptions = $('#send-targets').querySelectorAll('input[type="checkbox"]');
  const previouslySelected = currentOptions.length ? selectedIds($('#send-targets')) : null;
  appState = await api('/api/settings', 'PUT', settingsBody(scope));
  draftHooks = (appState.settings.webhooks || []).map((hook) => ({ ...hook }));
  renderWebhooks();
  renderSendTargets(previouslySelected);
  if (scope === 'ai' && inputRevision === aiInputRevision) {
    $('#ai-key').value = '';
    $('#settings-dirty').textContent = '';
  }
  render(true);
  if (!silent) toast('设置已保存');
}

async function ensureSettings() {
  const targets = $('#preview-targets');
  const selected = targets?.querySelector('input[type="checkbox"]') ? selectedIds(targets) : null;
  if (targets) {
    const retained = selected?.filter((id) => activeHooks().some((hook) => hook.id === id));
    targets.innerHTML = targetOptions(selected == null ? undefined : retained);
    updatePriorityVisibility($('#preview'), '#preview-targets');
  }
  if (!activeHooks().length) { location.hash = '#channels'; throw new Error('请先添加并启用一个 Webhook 地址'); }
}

function assistantPhase(status) {
  const labels = { answer: '可以继续提问或调整方案', draft: '方案已拟好，补上目标即可', generating: '正在根据描述拟定方案…', need_more_info: '等待你补充信息', ready: '规则已生成，等待确认', created: '任务已创建', failed: '处理遇到问题，可以继续补充' };
  $('#assistant-dialog').dataset.status = status;
  $('#assistant-phase').textContent = labels[status] || '等待需求';
  $('#assistant-reply-button').disabled = status === 'generating' || pendingActions.has($('#assistant-reply-button'));
  $('#parse-button').disabled = status === 'generating' || pendingActions.has($('#parse-button'));
  if (editingMonitor) renderRevisionDiff();
}

function renderAssistantMessages() {
  const list = $('#assistant-messages');
  list.innerHTML = assistantMessages.map((message) => `<div class="assistant-message ${message.role}"><small>${message.role === 'user' ? '你' : editingMonitor ? 'AI 修改助手' : 'AI 创建助手'}</small>${escapeHtml(message.content)}</div>`).join('');
  list.scrollTop = list.scrollHeight;
}

function addAssistantMessage(role, content) {
  $('#assistant-dialog').classList.remove('hidden');
  assistantMessages.push({ role, content });
  assistantMessages = assistantMessages.slice(-20);
  renderAssistantMessages();
}

function resetAssistant(instruction = '', keepEditing = false) {
  if (!keepEditing) editingMonitor = null;
  if (!instruction && !keepEditing) {
    $('#create-proxy-mode').value = 'default'; $('#create-source-proxy-id').value=''; $('#create-source-proxy').disabled=false; refreshChoices(); $('#create-source-proxy').value = '';
    $('#create-proxy-address').classList.add('hidden');
  }
  syncRevisionMode();
  assistantRequestId++;
  assistantInstruction = instruction;
  assistantConversation = [];
  assistantMessages = [];
  $('#assistant-dialog').classList.toggle('hidden', !instruction);
  $('#assistant-reply').value = '';
  $('#assistant-messages').innerHTML = '';
  $('#source-check-result').textContent = '';
  $('#source-check-result').classList.add('hidden');
  assistantPhase('idle');
}

async function prepareAiSettings() {
  if ((!appState.settings.hasAiKey && !$('#ai-key').value.trim()) || !$('#ai-model').value.trim()) {
    location.hash = '#ai-settings';
    throw new Error('请先在 AI 生成设置中填写模型和 API Key');
  }
  if ($('#settings-dirty').textContent || $('#ai-key').value || $('#ai-model').value !== appState.settings.aiModel || $('#ai-base-url').value !== appState.settings.aiBaseUrl) await saveSettings(true);
}

async function askAssistant() {
  const requestId = ++assistantRequestId;
  assistantPhase('generating');
  try {
    await prepareAiSettings();
    if (requestId !== assistantRequestId) return;
    assistantConversation = assistantConversation.slice(-6);
    const previousDraft = previewMonitor ? collectPreviewRule() : null;
    const routing = previousDraft || readCreateSourceSettings();
    const privateProxy = routing.sourceProxy; const sourceProxyId = routing.sourceProxyId;
    if (previousDraft) delete previousDraft.sourceProxy;
    const draftUrl = previewMonitor && previewMonitor.kind !== 'reminder' ? ($('#draft-url') || $('#rule-url'))?.value.trim() : '';
    const result = await api('/api/parse', 'POST', { monitorId: editingMonitor?.id, expectedRevision: editingMonitor?.revision, instruction: assistantInstruction, draft: previousDraft, fetch: routing.fetch, sourceProxy: privateProxy, sourceProxyId, sourceUrl: draftUrl || $('#instruction-url').value.trim(), conversation: assistantConversation, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    if (requestId !== assistantRequestId) return;
    if (result.sourceCheck) {
      $('#source-check-result').textContent = result.sourceCheck;
      $('#source-check-result').classList.remove('hidden');
    }
    if (result.status === 'answer') {
      addAssistantMessage('assistant', result.message);
      assistantConversation.push({ role: 'assistant', content: result.message });
      assistantPhase('answer');
      $('#assistant-reply').focus();
      return;
    }
    if (result.status === 'need_more_info') {
      const reply = result.questions.map((question, index) => `${index + 1}. ${question}`).join('\n');
      addAssistantMessage('assistant', `还需要确认：\n${reply}`);
      assistantConversation.push({ role: 'assistant', content: reply });
      assistantPhase('need_more_info');
      $('#assistant-reply').focus();
      return;
    }
    if (!['ready', 'draft'].includes(result.status) || !result.monitor) throw new Error('AI 未返回可确认的监控规则');
    previewMonitor = { ...result.monitor, ...(privateProxy && usesNetworkSource(result.monitor) && result.monitor.fetch?.proxy === 'custom' ? { sourceProxy: privateProxy } : {}), webhookIds: previousDraft?.webhookIds, priority: previousDraft?.priority ?? result.monitor.priority, sourceNote: result.sourceNote || '', assumptions: result.assumptions || [], missingSource: result.status === 'draft' };
    const explanation = result.message || (result.monitor.kind === 'reminder' ? '已为你安排好提醒。看一下时间和重复方式，确认即可。' : '我先按你的描述拟好了方案，可以直接确认，也可以告诉我想改哪里。');
    addAssistantMessage('assistant', explanation);
    assistantConversation.push({ role: 'assistant', content: explanation });

    renderPreview(previewMonitor);
    assistantPhase(result.status);
    $('#preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    await testPreviewSource(true);
  } catch (error) {
    if (requestId !== assistantRequestId) return;
    addAssistantMessage('assistant', `暂时无法完成生成：${error.message}。你可以补充或修改需求后重试。`);
    assistantPhase('failed');
    throw error;
  }
}

function readSavedRule(editor, monitor) {
  const problem = editor.querySelector('.advanced-feedback');
  if (problem?.textContent) throw new Error(problem.textContent);
  const ids = selectedIds(editor.querySelector('.target-options'));
  const rule = { label: editor.querySelector('.edit-label').value.trim(), priority: hasNtfyTarget(ids) ? priorityValue(editor.querySelector('.edit-priority')) : null };
  if (monitor.kind === 'reminder') {
    const time = new Date(editor.querySelector('.edit-remind-at').value);
    if (!Number.isFinite(time.getTime())) throw new Error('请填写有效的提醒时间');
    rule.remindAt = editor.querySelector('.edit-remind-at').value === reminderInput(monitor.remindAt) ? monitor.remindAt : time.toISOString();
    rule.message = editor.querySelector('.edit-message').value.trim();
    rule.repeatMinutes = repeatMinutesFrom(editor, 'edit');
  } else rule.intervalMinutes = readInterval(editor, '.edit-interval');
  if (usesNetworkSource(monitor)) { rule.fetch = readSourceFetch(editor, monitor); const proxy = readSourceProxy(editor, monitor); if (proxy) rule.sourceProxy = proxy; rule.sourceProxyId = readSourceProxyId(editor); }
  if (monitor.kind === 'unified') Object.assign(rule, readUnifiedRule(editor));
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
  const notification = editor.querySelector('.notification-editor');
  if (notification) rule.notification = readNotification(notification);
  return { rule, webhookIds: ids };
}

function monitorConfig(monitor) {
  const fields = ['schema_version', 'type', 'name', 'detection_method', 'target_element', 'extraction_rule', 'condition', 'interval', 'confidence', 'last_test_result', 'explanation', 'product', 'kind', 'url', 'label', 'description', 'intervalMinutes', 'severity', 'plan', 'fetch', 'notification', 'keyword', 'mode', 'triggerMode', 'jsonPath', 'operator', 'expected', 'message', 'remindAt', 'repeatMinutes', 'priority', 'webhookIds', 'hasSourceProxy', 'sourceProxyEndpoint', 'sourceProxyTest', 'sourceProxyId'];
  return structuredClone(Object.fromEntries(fields.filter((key) => monitor[key] !== undefined).map((key) => [key, monitor[key]])));
}
function syncRevisionMode() {
  const editing = Boolean(editingMonitor);
  $('#revision-context').classList.toggle('hidden', !editing);
  $('#parse-form').classList.toggle('hidden', editing);
  $('.monitor-type-options')?.classList.toggle('hidden', editing);
  $('#assistant-title').textContent = editing ? 'AI 修改助手' : 'AI 创建助手';
  $('.assistant-context-note').textContent = editing ? '对话仅用于本次修改。每次发送当前草稿和最近 6 条消息；确认更新、取消、退出或刷新页面后清空。' : '对话只保留在当前创建草稿中。每次仅发送原始需求、当前规则草稿和最近 6 条对话；创建、重新开始或退出后清空。';
  $('#revision-task-name').textContent = editingMonitor?.original.label || '';
  $('#create-heading').textContent = editing ? '与 AI 调整这个任务' : '描述你想关注的事';
  $('#create-subtitle').textContent = editing ? '直接说想改哪里。原任务保持现状，预览满意后再确认更新。' : '说出你想关注的事。AI 会先拟好方案，自动试跑；确认后开始监控或定时提醒。';
  $('#parse-button span').textContent = editing ? '生成修改方案' : '生成方案';
  $('#assistant-reset').textContent = editing ? '清空本次对话' : '重新开始';
  $('#instruction').placeholder = editing ? '例如：连续失败 3 次再提醒我，改成每 10 分钟检查一次，保留其他设置' : '例如：订单接口连续失败 3 次通知我；或明天上午 9 点提醒我开会';
}
function startAIRevision(monitor, editor) {
  let config = monitorConfig(monitor);
  if (editor?.closest('#task-workspace') && activeTaskId === monitor.id) {
    const pending = readSavedRule(editor, monitor);
    config = { ...config, ...pending.rule, webhookIds: pending.webhookIds };
  }
  const revision = editor?.closest('#task-workspace') && activeTaskId === monitor.id ? Number(editor.dataset.revision) : monitor.revision || 0;
  resetAssistant();
  editingMonitor = { id: monitor.id, revision, original: monitorConfig(monitor), enabled: monitor.enabled };
  assistantInstruction = '请协助我修改当前已创建的任务，保留未要求修改的设置。';
  previewMonitor = config;
  $('#instruction').value = '';
  $('#instruction-url').value = '';
  syncRevisionMode();
  addAssistantMessage('assistant', '已载入“' + monitor.label + '”的当前设置。告诉我哪里不满意、希望什么时候提醒，或想换成怎样的通知内容。确认更新前，原任务保持现状。');
  renderPreview(previewMonitor);
  assistantPhase('ready');
  location.hash = '#create';
  syncNavigation(true);
  $('#assistant-reply').focus({ preventScroll: true });
}
function revisionChanges(before, after) {
  const changes = [];
  const compare = (label, a, b, show = (value) => value == null || value === '' ? '默认' : String(value)) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push([label, show(a), show(b)]);
  };
  compare('任务名称', before.label, after.label);
  compare('提醒级别', before.severity || 'warning', after.severity || 'warning', (value) => ({ info: '提示', warning: '一般', critical: '重要' })[value] || value);
  compare('关注地址', before.url || '', after.url || '');
  if (before.kind !== 'reminder') {
    compare('读取方式', before.fetch?.mode || 'auto', after.fetch?.mode || 'auto', (v) => ({ auto: '自动', http: '直接请求', browser: '浏览器' })[v]);
    compare('网络出口', before.fetch?.proxy || 'default', after.fetch?.proxy || 'default', (v) => ({ direct: '直接连接', default: '账户设置', custom: '独立代理' })[v]);
    compare('检查频率', Number(before.intervalMinutes), Number(after.intervalMinutes), (v) => '每 ' + intervalLabel(v));
    if (after.fetch?.proxy === 'custom' && after.sourceProxy) changes.push(['独立代理地址', before.hasSourceProxy ? '已保存的独立代理' : '未设置', '验证后使用新代理']);
    const condition = (m) => [m.kind, m.type, m.detection_method, m.target_element, m.extraction_rule, m.condition, m.plan, m.keyword, m.mode, m.triggerMode, m.jsonPath, m.operator, m.expected];
    if (JSON.stringify(condition(before)) !== JSON.stringify(condition(after))) {
      const previousCondition = friendlyRule(before), nextCondition = friendlyRule(after);
      changes.push(previousCondition === nextCondition ? ['检测细节', '原来的取值与筛选方式', '检测参数已调整，可在下方高级设置中查看'] : ['提醒条件', previousCondition, nextCondition]);
      if (before.plan?.initial !== after.plan?.initial) changes.push(['第一次检查', before.plan?.initial === 'notify' ? '满足条件也提醒' : '先记录再观察', after.plan?.initial === 'notify' ? '满足条件也提醒' : '先记录再观察']);
    }
  } else {
    compare('提醒时间', before.remindAt, after.remindAt, reminderDate);
    compare('重复方式', before.repeatMinutes || 0, after.repeatMinutes || 0, repeatLabel);
    compare('提醒内容', before.message, after.message);
  }
  const template = (m) => m.notification || { title: '{{name}}', body: '{{details}}' };
  compare('通知标题', template(before).title, template(after).title);
  compare('通知正文', template(before).body, template(after).body);
  compare('ntfy 优先级', before.priority == null ? '' : String(before.priority), after.priority == null ? '' : String(after.priority));
  compare('通知渠道', [...(before.webhookIds || [])].sort(), [...(after.webhookIds || [])].sort(), (ids) => ids.map((id) => appState.settings.webhooks.find((hook) => hook.id === id)?.name || '已移除的渠道').join('、'));
  return changes;
}
function renderRevisionDiff() {
  if (!editingMonitor || !previewMonitor || !$('#create-button')) return;
  let box = $('#revision-diff');
  if (!box) {
    $('#preview .preview-head').insertAdjacentHTML('afterend', '<section id="revision-diff" class="revision-diff" aria-live="polite"></section>');
    box = $('#revision-diff');
  }
  $('#create-button').textContent = '确认更新原任务';
  $('#preview .preview-head span:last-child').textContent = '修改草稿 · 原任务未变';
  try {
    const changes = revisionChanges(editingMonitor.original, collectPreviewRule());
    box.innerHTML = '<h3>本次会修改什么</h3>' + (changes.length
      ? '<dl>' + changes.map(([label, before, after]) => '<div><dt>' + escapeHtml(label) + '</dt><dd><span class="change-before">' + escapeHtml(before) + '</span><span class="change-arrow" aria-hidden="true">→</span><strong>' + escapeHtml(after) + '</strong></dd></div>').join('') + '</dl>'
      : '<p>当前还是原来的设置。告诉 AI 你想调整的地方，或直接修改下方选项。</p>')
      + '<p class="field-help">' + (editingMonitor.enabled ? '确认后更新这一个任务，不会另建副本。' : '这个任务目前已暂停，保存修改后仍保持暂停。') + ' 调整检测方式或来源会重新记录状态，并取消旧条件下未送出的通知；修改文案和频率会保留检测记录。</p>';
    $('#create-button').disabled = !changes.length || $('#assistant-dialog').dataset.status === 'generating' || pendingActions.has($('#create-button'));
  } catch (error) { box.textContent = error.message; $('#create-button').disabled = true; }
}
function cancelAIRevision() {
  resetAssistant();
  previewMonitor = null;
  $('#preview').classList.add('hidden');
  $('#preview').innerHTML = '';
  $('#instruction').value = '';
  $('#instruction-url').value = '';
  location.hash = '#monitors';
}
$('#cancel-revision').addEventListener('click', cancelAIRevision);

function repeatLabel(minutes) {
  const value = Number(minutes) || 0;
  if (!value) return '仅一次';
  if (value % 10080 === 0) return '每 ' + value / 10080 + ' 周';
  if (value % 1440 === 0) return '每 ' + value / 1440 + ' 天';
  if (value % 60 === 0) return '每 ' + value / 60 + ' 小时';
  return '每 ' + value + ' 分钟';
}

function repeatParts(minutes) {
  const value = Number(minutes) || 0;
  if (value && value % 10080 === 0) return [value / 10080, 10080];
  if (value && value % 1440 === 0) return [value / 1440, 1440];
  if (value && value % 60 === 0) return [value / 60, 60];
  return [value || 1, 1];
}

function repeatFields(scope, minutes) {
  const [value, unit] = repeatParts(minutes);
  const repeating = Number(minutes) > 0;
  return '<label>重复方式<select class="' + scope + '-repeat-mode"><option value="once" ' + (repeating ? '' : 'selected') + '>仅提醒一次</option><option value="interval" ' + (repeating ? 'selected' : '') + '>按固定间隔重复</option></select></label>'
    + '<div class="repeat-interval ' + (repeating ? '' : 'hidden') + '"><label>间隔<input class="' + scope + '-repeat-value" type="number" min="1" max="525600" step="1" value="' + value + '"></label><label>单位<select class="' + scope + '-repeat-unit">'
    + [[1, '分钟'], [60, '小时'], [1440, '天'], [10080, '周']].map(([amount, text]) => '<option value="' + amount + '" ' + (unit === amount ? 'selected' : '') + '>' + text + '</option>').join('')
    + '</select></label></div>';
}

function repeatMinutesFrom(root, scope) {
  if (root.querySelector('.' + scope + '-repeat-mode').value === 'once') return 0;
  const value = Number(root.querySelector('.' + scope + '-repeat-value').value);
  const unit = Number(root.querySelector('.' + scope + '-repeat-unit').value);
  const minutes = value * unit;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) throw new Error('重复间隔需在 1 分钟到 1 年之间');
  return minutes;
}

function toggleRepeatFields(root, scope) {
  const mode = root.querySelector('.' + scope + '-repeat-mode');
  if (mode) root.querySelector('.repeat-interval').classList.toggle('hidden', mode.value !== 'interval');
}
function reminderDate(value) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeStyle: 'short' }).format(new Date(value));
}

function reminderInput(value) {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function friendlyRule(monitor) {
  if (monitor.kind === 'unified') return unifiedDescription(monitor);
  if (monitor.kind === 'reminder') return monitor.message;
  const plan = monitor.plan || {};
  const mode = plan.mode || monitor.mode;
  const keyword = plan.keyword ?? monitor.keyword;
  if (plan.sourceType === 'service') return mode === 'unavailable' ? '服务连续 ' + (plan.failureThreshold || 1) + ' 次无法访问时提醒我' : mode === 'available' ? '服务恢复正常时提醒我' : '服务响应超过 ' + (plan.thresholdMs || 3000) / 1000 + ' 秒时提醒我';
  if (plan.sourceType === 'log') return '新日志里出现“' + keyword + '”时提醒我';
  if (['contains', 'absent'].includes(mode)) return '页面' + (mode === 'absent' ? '不再出现' : '出现') + '“' + keyword + '”时提醒我';
  if (mode === 'changed' || monitor.kind === 'github') return monitor.kind === 'github' || plan.path === 'tag_name' ? '发布新版本时提醒我' : '关注的内容发生变化时提醒我';
  if (mode === 'item-transition') return '条目从“' + plan.fromValues.join(' / ') + '”变为“' + plan.toValues.join(' / ') + '”时提醒我';
  if (mode === 'any') {
    const filters = (plan.filters || []).filter((item) => !['provider', 'stale', 'last_check_at'].includes(item.path));
    return '有条目满足' + (filters.length ? '「' + filters.map((item, index) => friendlyPredicate(item, index)).join('，且') + '」' : '设定条件') + '时提醒我';
  }
  if (mode === 'compare') return friendlyPredicate(plan) + '时提醒我';
  if (monitor.kind === 'json') return friendlyPredicate({ path: monitor.jsonPath, operator: monitor.operator, expected: monitor.expected }) + '时提醒我';
  if (mode === 'new-item' || monitor.kind === 'rss') return '有' + (keyword ? '标题包含“' + keyword + '”的' : '') + '新内容时提醒我';
  if (monitor.kind === 'dmit') return monitor.triggerMode === 'any-available' ? '任意套餐有货时提醒我' : '套餐从无货变为有货时提醒我';
  if (monitor.kind === 'dmit-product') return '这个套餐恢复购买时提醒我';
  return monitor.description || '满足设定条件时提醒我';
}

function friendlyResult(monitor) {
  if (monitor.kind === 'unified') return monitor.lastResult || '当前状态：' + ruleValue(monitor.snapshot?.value);
  const result = String(monitor.lastResult || '');
  const path = monitor.plan?.path || monitor.jsonPath;
  const prefix = path + ' = ';
  return path && result.startsWith(prefix) ? '当前' + friendlyField(path) + '：' + result.slice(prefix.length) : result;
}

function friendlyField(field, index = 0) {
  const name = String(field || '').split('.').at(-1);
  return ({ status: '状态', state: '状态', price: '价格', stock: '库存', available: '是否可用', count: '数量', latencyMs: '响应时间', success_rate: '成功率', name: '名称', title: '标题', provider: '提供方' })[name] || '关注内容' + (index ? ' ' + (index + 1) : '');
}
function friendlyPredicate(item, index = 0) {
  const words = { equals: '是', notEquals: '不是', contains: '包含', in: '是其中之一：', gt: '超过', gte: '达到或超过', lt: '低于', lte: '不高于', withinMinutes: '在最近这些分钟内更新：' };
  const display = (value) => ({ true: '是', false: '否', available: '有货 / 可用', 'out of stock': '无货', failed: '失败', success: '成功' })[String(value)] || String(value);
  return friendlyField(item.path, index) + (words[item.operator] || '') + (Array.isArray(item.expected) ? item.expected.map(display).join('、') : display(item.expected));
}

function basicPlanFields(plan) {
  const fields = [];
  const input = (label, key, value, { type = 'text', min, max, scale, valueType } = {}) => '<label>' + escapeHtml(label) + '<input data-plan-key="' + key + '" type="' + type + '" value="' + escapeHtml(value) + '"' + (min != null ? ' min="' + min + '" max="' + max + '"' : '') + (scale ? ' step="0.1" data-scale="' + scale + '"' : '') + (valueType ? ' data-value-type="' + valueType + '"' : '') + '></label>';
  const select = (label, key, value, options) => '<label>' + label + '<select data-plan-key="' + key + '">' + options.map(([id, title]) => '<option value="' + id + '" ' + (id === value ? 'selected' : '') + '>' + title + '</option>').join('') + '</select></label>';
  if (plan.sourceType === 'service') fields.push(select('什么时候提醒', 'mode', plan.mode, [['unavailable', '无法访问时'], ['available', '恢复正常时'], ['slow', '响应太慢时']]));
  if (plan.sourceType === 'html') fields.push(select('什么时候提醒', 'mode', plan.mode, [['contains', '出现这些文字时'], ['absent', '这些文字消失时']]));
  if (['contains', 'absent', 'new-line', 'new-item'].includes(plan.mode)) fields.push(input(plan.mode === 'new-item' ? '新内容标题包含（选填）' : plan.sourceType === 'log' ? '日志中出现的文字' : '要关注的文字', 'keyword', plan.keyword || ''));
  if (plan.mode === 'unavailable') fields.push(input('连续失败几次后提醒', 'failureThreshold', plan.failureThreshold || 1, { type: 'number', min: 1, max: 10 }));
  if (plan.mode === 'slow') fields.push(input('等待超过多少秒算慢', 'thresholdMs', (plan.thresholdMs || 3000) / 1000, { type: 'number', min: .1, max: 30, scale: 1000 }));
  const predicateFields = (item, key, label) => {
    const options = [['equals', '等于'], ['notEquals', '不等于'], ['contains', '包含'], ['in', '符合任意一个'], ['gt', '超过'], ['gte', '达到或超过'], ['lt', '低于'], ['lte', '不高于']];
    if (item.operator === 'withinMinutes') options.push(['withinMinutes', '在最近这些分钟内']);
    fields.push('<div class="plain-condition">' + select(label + '的提醒条件', key + 'operator', item.operator, options) + input(item.operator === 'in' ? '符合这些内容（用逗号分隔）' : '希望关注的内容或数值', key + 'expected', Array.isArray(item.expected) ? item.expected.join(', ') : item.expected, { type: typeof item.expected === 'number' ? 'number' : 'text', valueType: Array.isArray(item.expected) ? 'array' : typeof item.expected }) + '</div>');
  };
  if (plan.mode === 'compare') predicateFields(plan, '', friendlyField(plan.path));
  if (['any', 'item-transition'].includes(plan.mode)) (plan.filters || []).forEach((item, index) => {
    if (!['provider', 'stale', 'last_check_at'].includes(item.path)) predicateFields(item, 'filters.' + index + '.', friendlyField(item.path, index));
  });
  if (plan.mode === 'item-transition') {
    fields.push(input('之前是这些状态', 'fromValues', plan.fromValues.join(', '), { valueType: 'array' }));
    fields.push(input('变成这些状态就提醒', 'toValues', plan.toValues.join(', '), { valueType: 'array' }));
  }
  if (plan.mode !== 'changed') fields.push(select('第一次检查时', 'initial', plan.initial || 'baseline', [['baseline', '先记录，之后有变化再提醒'], ['notify', '已经满足条件也提醒我']]));
  return fields.join('');
}

function syncPlanEditor(event) {
  const root = event.target.closest('.generated-plan-editor');
  if (!root) return;
  const raw = root.querySelector('[data-plan-json]');
  const feedback = root.querySelector('.advanced-feedback');
  try {
    const plan = JSON.parse(raw.value);
    if (event.target.matches('[data-plan-key]')) {
      const input = event.target;
      const keys = input.dataset.planKey.split('.');
      const property = keys.pop();
      const container = keys.reduce((value, key) => value[key], plan);
      let value = input.value;
      if (input.dataset.valueType === 'array') value = value.split(/[,，\n]/).map((part) => part.trim()).filter(Boolean);
      else if (input.dataset.valueType === 'boolean') {
        if (!['true', 'false', '是', '否'].includes(value.trim())) throw new Error('这里填写“是”或“否”即可');
        value = ['true', '是'].includes(value.trim());
      } else if (input.type === 'number') value = Number(value) * (Number(input.dataset.scale) || 1);
      container[property] = value;
      if (property === 'operator' && input.value === 'in' && !Array.isArray(container.expected)) container.expected = [container.expected];
      if (property === 'operator' && input.value !== 'in' && Array.isArray(container.expected)) container.expected = container.expected[0] ?? '';
      if (property === 'mode' && value === 'slow') plan.thresholdMs ??= 3000;
      if (property === 'mode' && value === 'unavailable') plan.failureThreshold ??= 1;
      raw.value = JSON.stringify(plan, null, 2);
      if (['mode', 'operator'].includes(property)) root.querySelector('.plain-plan-fields').innerHTML = basicPlanFields(plan);
    } else if (event.target === raw) root.querySelector('.plain-plan-fields').innerHTML = basicPlanFields(plan);
    root.querySelector('.plain-rule-summary').textContent = friendlyRule({ kind: 'generated', plan });
    feedback.textContent = '';
    root.dispatchEvent(new CustomEvent('rule-plan-updated', { bubbles: true }));
  } catch (error) { feedback.textContent = event.target === raw ? '规则尚未填写完整，保存前请检查 JSON。' : error.message; }
}
document.addEventListener('input', syncPlanEditor);

async function testPreviewSource(automatic = false) {
  const draft = previewMonitor;
  if (!draft || draft.kind === 'reminder') return;
  const resultBox = $('#preview-result');
  const rule = collectPreviewRule();
  if (!rule.url) {
    resultBox.className = 'preview-result';
    resultBox.textContent = '方案已准备好，粘贴目标地址后就能试跑。';
    if (!automatic) $('#draft-url')?.focus();
    return;
  }
  const signature = JSON.stringify(rule);
  const button = $('#preview-check-button');
  button.disabled = true;
  resultBox.className = 'preview-result checking';
  resultBox.textContent = '正在按这个方案试跑一次…';
  try {
    const result = await api('/api/preview-check', 'POST', { ...rule, monitorId: editingMonitor?.id, expectedRevision: editingMonitor?.revision });
    if (previewMonitor !== draft) return;
    if (JSON.stringify(collectPreviewRule()) !== signature) { resultBox.className = 'preview-result'; resultBox.textContent = '方案已修改，重新试跑即可查看最新结果。'; return; }
    resultBox.className = 'preview-result ' + (result.healthy === false ? 'warning' : 'success');
    resultBox.textContent = '试跑完成' + (result.fetch ? ' · ' + (result.fetch.method === 'browser' ? '浏览器读取' : '直接请求') + (result.fetch.route === 'proxy' ? ' · 代理出口' : '') : '') + ' · ' + friendlyResult({ ...rule, lastResult: result.summary }) + (editingMonitor ? '。这次试跑不会发送通知，确认更新后才会应用新方案。' : '。确认创建后才会自动发送通知。');
    await refreshNotification($('#preview .notification-editor'), result.notificationPreview);
  } catch (error) {
    if (previewMonitor !== draft) return;
    resultBox.className = 'preview-result warning';
    resultBox.textContent = '方案已保留，试跑暂未成功：' + error.message + '。可以修改地址或告诉 AI 要调整的地方。';
  } finally {
    if (previewMonitor === draft) button.disabled = false;
  }
}

const notificationEditors = new WeakMap();
let notificationEditorCount = 0;

function notificationFields(monitor) {
  const token = 'notification-' + (++notificationEditorCount);
  const template = monitor.notification || { title: '{{name}}', body: '{{details}}' };
  const common = monitor.kind === 'reminder' ? [['message', '提醒内容'], ['name', '任务名称'], ['time', '发送时间']] : [['details', '本次详情'], ['name', '任务名称'], ['summary', '检测摘要'], ['source', '监控地址'], ['time', '检测时间']];
  if (['any', 'item-transition', 'new-item'].includes(monitor.plan?.mode) || ['dmit', 'rss'].includes(monitor.kind)) common.push(['items', '匹配条目'], ['count', '条目数量']);
  if (['compare', 'changed', 'slow'].includes(monitor.plan?.mode)) common.push(['value', '当前值'], ['previous', '之前的值']);
  return '<section class="notification-editor" aria-label="通知内容与预览">'
    + '<div class="notification-heading"><div><h3>通知内容</h3><p>标题和正文都由你决定，动态内容只在插入后填入。</p></div><span class="local-badge">本地预览 · 无 AI 消耗</span></div>'
    + '<label class="field-label" for="' + token + '-title">标题（可留空）</label><input class="notification-title" id="' + token + '-title" type="text" maxlength="200" value="' + escapeHtml(template.title) + '">'
    + '<label class="field-label" for="' + token + '-body">正文</label><textarea class="notification-body" id="' + token + '-body" rows="4" maxlength="2000">' + escapeHtml(template.body) + '</textarea>'
    + '<div class="notification-variables" role="group" aria-label="插入动态内容"><span>插入内容</span>' + common.map(([key, label]) => '<button type="button" class="variable-button" data-variable="' + key + '">' + label + '</button>').join('') + '</div>'
    + '<p class="field-help">点击插入动态内容，也可直接编辑或删除。</p>'
    + '<div class="notification-render" aria-live="polite"><div class="notification-preview-label"><strong>接收效果</strong><span class="notification-basis">准备预览</span></div>'
    + '<p class="notification-note"></p><div class="notification-message"><h4></h4><p></p></div><div class="notification-channel-list"></div>'
    + '<div class="notification-wire-content hidden" aria-hidden="true"></div></div>'
    + '<div class="notification-feedback" role="status"></div><div class="notification-actions"><button type="button" class="button button-outline" data-notification-action="refresh">刷新预览</button>'
    + '<button type="button" class="button button-outline" data-notification-action="simulate" disabled>发送模拟通知</button></div>'
    + '<p class="field-help simulation-note">模拟消息会实际发送到上方渠道，标题加上【模拟】。不会创建任务或改变任务的检测、提醒进度。</p></section>';
}

function readNotification(root) {
  return { title: root.querySelector('.notification-title').value.trim(), body: root.querySelector('.notification-body').value.trim() };
}

function showNotificationPreview(root, data) {
  const state = notificationEditors.get(root);
  if (!state || !root.isConnected) return;
  state.data = data;
  root.querySelector('.notification-basis').textContent = { observed: '真实检测数据', sample: '示例数据', reminder: '提醒内容' }[data.basis];
  root.querySelector('.notification-note').textContent = data.note;
  root.querySelector('.notification-message h4').textContent = data.payload.title;
  root.querySelector('.notification-message p').textContent = data.payload.message;
  root.querySelector('.notification-message h4').classList.toggle('hidden', !data.payload.title);
  root.querySelector('.notification-message p').classList.toggle('hidden', !data.payload.message);
  root.querySelector('.notification-channel-list').innerHTML = data.channels.length ? data.channels.map((channel) => '<span class="' + (channel.error ? 'channel-invalid' : '') + '">' + escapeHtml(channel.name) + ' · ' + escapeHtml(channel.error || channel.format + (channel.format === 'ntfy' ? ' · 优先级 ' + channel.headers['x-priority'] : '')) + '</span>').join('') : '<span>尚未选择接收渠道</span>';
  root.querySelector('.notification-wire-content').innerHTML = data.channels.map((channel) => '<h5>' + escapeHtml(channel.name) + '</h5><pre>' + escapeHtml(channel.error || (typeof channel.body === 'string' ? channel.body : JSON.stringify(channel.body, null, 2))) + '</pre>').join('');
  root.querySelector('[data-notification-action="simulate"]').disabled = !data.canSend || state.sending;
  root.querySelector('.notification-feedback').textContent = '';
}

async function refreshNotification(root, supplied) {
  const state = notificationEditors.get(root);
  if (!state || !root.isConnected) return;
  const sequence = ++state.sequence;
  clearTimeout(state.timer);
  root.querySelector('[data-notification-action="simulate"]').disabled = true;
  try {
    const data = supplied || await api('/api/notification-preview', 'POST', { monitorId: state.monitorId, rule: state.getRule(), previousPreviewId: state.data?.id });
    if (sequence !== state.sequence || !root.isConnected) return;
    showNotificationPreview(root, data);
  } catch (error) {
    if (sequence !== state.sequence || !root.isConnected) return;
    root.querySelector('.notification-feedback').textContent = error.message;
    root.querySelector('.notification-basis').textContent = '待更新';
  }
}

function queueNotificationRefresh(root) {
  const state = notificationEditors.get(root);
  if (!state) return;
  state.sequence++;
  root.querySelector('[data-notification-action="simulate"]').disabled = true;
  root.querySelector('.notification-basis').textContent = '正在更新';
  clearTimeout(state.timer);
  state.timer = setTimeout(() => refreshNotification(root), 350);
}

function attachNotification(root, getRule, monitorId) {
  notificationEditors.set(root, { getRule, monitorId, sequence: 0, data: null, sending: false, field: root.querySelector('.notification-body') });
  root.addEventListener('focusin', (event) => {
    if (event.target.matches('.notification-title, .notification-body')) notificationEditors.get(root).field = event.target;
  });
  root.addEventListener('input', () => queueNotificationRefresh(root));
  root.addEventListener('click', async (event) => {
    const variable = event.target.closest('[data-variable]');
    if (variable) {
      const state = notificationEditors.get(root), field = state.field;
      field.setRangeText('{{' + variable.dataset.variable + '}}', field.selectionStart, field.selectionEnd, 'end');
      field.focus();
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const button = event.target.closest('[data-notification-action]');
    if (!button) return;
    const state = notificationEditors.get(root);
    if (button.dataset.notificationAction === 'refresh') { await refreshNotification(root); return; }
    if (!state.data?.canSend || state.sending) return;
    state.sending = true;
    const id = state.data.id;
    button.disabled = true;
    root.querySelector('.notification-feedback').textContent = '正在发送预览中的模拟消息…';
    try {
      const report = await api('/api/notification-simulate', 'POST', { previewId: id });
      root.querySelector('.notification-feedback').textContent = '模拟发送：' + report.sent.length + ' 个渠道成功' + (report.failed.length ? '；' + report.failed.map((item) => item.name + '：' + item.error).join('；') : '。请到接收端查看。') + ' 如需再次发送，请刷新预览。';
    } catch (error) { root.querySelector('.notification-feedback').textContent = error.message + '。可刷新预览后重试。'; }
    finally {
      state.sending = false;
      if (state.data?.id !== id) button.disabled = !state.data?.canSend;
    }
  });
  refreshNotification(root);
}

function mountDraftNotification(monitor) {
  const result = $('#preview-result');
  result.insertAdjacentHTML('beforebegin', notificationFields(monitor));
  attachNotification($('#preview .notification-editor'), collectPreviewRule, editingMonitor?.id);
  renderRevisionDiff();
}

function openNotificationEditor(monitor) { openTaskEditor(monitor, 'notifications'); }

function monitorSummary(monitor) {
  if (monitor.kind === 'unified') return unifiedSummary(monitor) + '<p class="plain-rule-summary">' + escapeHtml(unifiedDescription(monitor)) + ' · 每 ' + escapeHtml(intervalLabel(monitor.intervalMinutes)) + '检查</p>' + featurePanel('检测依据与型号库存', ruleValidationSummary(monitor) + stockModelSummary(monitor), 'draft-evidence') + (monitor.extraction_rule.kind !== 'service' ? '<div class="element-actions"><button type="button" class="button button-outline" data-source-preview>预览页面与检测区域</button></div>' : '');
  const items = [
    ['监控对象', monitor.label, false],
    ['检查频率', '每 ' + intervalLabel(monitor.intervalMinutes), false],
    ['什么时候提醒', friendlyRule(monitor), true]
  ];
  if (monitor.url) items.push(['关注的地址', monitor.url, true]);
  return '<div class="preview-grid">' + items.map(([label, value, wide]) => '<div class="preview-item ' + (wide ? 'summary-wide' : '') + '"><small>' + escapeHtml(label) + '</small><strong>' + escapeHtml(value) + '</strong></div>').join('') + '</div>';
}

function renderPreview(monitor) {
  const element = $('#preview');
  element.classList.remove('hidden');
  if (monitor.kind === 'reminder') {
    element.innerHTML = '<div class="preview-head"><span>✦ &nbsp; 提醒预览</span><span>AI 本次生成 · 待确认</span></div>'
      + '<div class="preview-grid"><div class="preview-item"><small>提醒名称</small><strong>' + escapeHtml(monitor.label) + '</strong></div>'
      + '<div class="preview-item"><small>首次发送</small><strong>' + escapeHtml(reminderDate(monitor.remindAt)) + '</strong></div>'
      + '<div class="preview-item"><small>重复方式</small><strong>' + escapeHtml(repeatLabel(monitor.repeatMinutes)) + '</strong></div>'
      + '<div class="preview-item"><small>提醒内容</small><strong>' + escapeHtml(monitor.message) + '</strong></div></div>'
      + '<p class="preview-note">时间按此设备的本地时区显示。重复提醒在每轮成功送达后安排下一次；请确认后再创建。</p>'
      + '<div class="field-label">通知到</div><div id="preview-targets" class="target-options">' + targetOptions(monitor.webhookIds) + '</div>'
      + '<div class="rule-editor">' + taskEditor(monitor, 'rule') + '</div>'
      + '<div id="preview-result" class="preview-result" aria-live="polite"></div>'
      + '<div class="preview-actions"><button class="button button-outline" id="preview-revise-button" type="button">修改需求</button>'
      + '<button class="button button-primary" id="create-button" type="button">确认创建提醒 <span>↗</span></button></div>';
    updatePriorityVisibility(element, '#preview-targets');
    mountDraftNotification(monitor);
    return;
  }
  element.innerHTML = `<div class="preview-head"><span>✦ &nbsp; 监控规则预览</span><span>AI 本次生成 · 待确认</span></div>
    ${monitorSummary(monitor)}
    <div class="preview-note">${monitor.sourceNote ? `${escapeHtml(monitor.sourceNote)} ` : ''}${monitor.kind === 'generated' ? '请核对提醒条件。时间和通知选项可以直接调整，也可以继续用一句话修改需求。' : (monitor.kind === 'unified' && monitor.condition.initial === 'notify' || monitor.kind === 'dmit' && monitor.triggerMode === 'any-available') ? '首次检查发现有货会立即通知；持续有货不会重复发送。' : '首次检查只记录当前状态。后续条件发生变化时发送通知。'}${monitor.kind === 'generated' && monitor.plan.sourceType === 'html' ? ' 自动读取遇到网站验证会尝试浏览器；创建前会试跑一次。' : ''}${monitor.kind === 'dmit' ? '库存数据来自第三方，购买前请以官方页面为准。' : ''}</div>
    <div class="field-label">通知到</div><div id="preview-targets" class="target-options">${targetOptions(monitor.webhookIds)}</div>
    <div class="rule-editor">${taskEditor(monitor, 'rule')}</div>
    <div id="preview-result" class="preview-result" aria-live="polite"></div><div class="preview-actions"><button class="button button-outline" id="preview-revise-button" type="button">修改需求</button><button class="button button-outline" id="preview-check-button" type="button">试跑一次</button><button class="button button-primary" id="create-button" type="button">确认并开始监控 <span>↗</span></button></div>`;
  if (monitor.assumptions?.length) {
    element.querySelector('.preview-grid, .rule-evidence').insertAdjacentHTML('afterend', '<div class="draft-assumptions"><strong>已为你采用的设置</strong><ul>' + monitor.assumptions.map((text) => '<li>' + escapeHtml(text) + '</li>').join('') + '</ul></div>');
  }
  if (monitor.missingSource) {
    element.querySelector('#rule-url').closest('label').classList.add('hidden');
    const logTarget = monitor.plan?.sourceType === 'log';
    element.querySelector('.preview-grid').insertAdjacentHTML('beforebegin', '<div class="draft-target"><label class="field-label" for="draft-url">' + (logTarget ? '要读取的日志文件' : '补上要关注的地址') + '</label><input id="draft-url" type="text" placeholder="' + (logTarget ? '例如 app.log' : '粘贴你平时访问的网址或服务地址') + '"><p class="field-help">方案已经拟好，补上目标后可直接试跑和创建。</p></div>');
  }
  updatePriorityVisibility(element, '#preview-targets');
  mountDraftNotification(monitor);
}

function updatePriorityVisibility(container, targetsSelector) {
  const targets = container.querySelector(targetsSelector);
  const priority = container.querySelector('.priority-field');
  if (targets && priority) priority.classList.toggle('hidden', !hasNtfyTarget(selectedIds(targets)));
}
function markPreviewChanged(event) {
  if (!event.target.matches('[data-plan-key], [data-plan-json], .source-fetch-mode, .source-fetch-proxy, .source-proxy-input, .source-proxy-id, [data-unified-key], .unified-json, .interval-unit, #rule-interval, #draft-url, #rule-url, #rule-keyword, #rule-mode, #rule-json-path, #rule-operator, #rule-expected')) return;
  const result = $('#preview-result');
  if (result && previewMonitor?.kind !== 'reminder') {
    result.className = 'preview-result';
    result.textContent = '方案已调整，可以再试跑一次确认结果。';
  }
}
$('#preview').addEventListener('rule-plan-updated', () => { renderRevisionDiff(); queueNotificationRefresh($('#preview .notification-editor')); });
$('#preview').addEventListener('input', (event) => { renderRevisionDiff(); markPreviewChanged(event); if (!event.target.closest('.notification-editor')) queueNotificationRefresh($('#preview .notification-editor')); });
$('#preview').addEventListener('change', (event) => { renderRevisionDiff(); updatePriorityVisibility($('#preview'), '#preview-targets'); toggleRepeatFields($('#preview'), 'rule'); markPreviewChanged(event); if (!event.target.closest('.notification-editor')) queueNotificationRefresh($('#preview .notification-editor')); });
document.addEventListener('change', (event) => {
  const editor = event.target.closest('.monitor-route');
  if (editor) {
    updatePriorityVisibility(editor, '.target-options'); toggleRepeatFields(editor, 'edit');
    const notification = editor.querySelector('.notification-editor');
    if (notification && !notification.contains(event.target)) queueNotificationRefresh(notification);
  }
});

document.addEventListener('input', event => {
  const editor = event.target.closest('.monitor-route');
  const notification = editor?.querySelector('.notification-editor');
  if (notification && !notification.contains(event.target)) queueNotificationRefresh(notification);
});

document.addEventListener('rule-plan-updated', event => {
  const notification = event.target.closest('.monitor-route')?.querySelector('.notification-editor');
  if (notification) queueNotificationRefresh(notification);
});

function collectPreviewRule() {
  const options = $('#preview-targets').querySelectorAll('input[type="checkbox"]');
  const chosen = options.length ? selectedIds($('#preview-targets')) : null;
  const webhookIds = chosen ?? activeHooks().map((hook) => hook.id);
  const rule = { ...previewMonitor, label: $('#rule-label').value.trim(), priority: hasNtfyTarget(webhookIds) ? priorityValue($('#rule-priority')) : null, webhookIds };
  const notificationRoot = $('#preview .notification-editor');
  if (notificationRoot) rule.notification = readNotification(notificationRoot);
  const problem = $('#preview .advanced-feedback');
  if (problem?.textContent) throw new Error(problem.textContent);
  if (rule.kind === 'reminder') {
    const time = new Date($('#rule-remind-at').value);
    if (!Number.isFinite(time.getTime())) throw new Error('请填写有效的提醒时间');
    rule.remindAt = $('#rule-remind-at').value === reminderInput(previewMonitor.remindAt) ? previewMonitor.remindAt : time.toISOString();
    rule.message = $('#rule-message').value.trim();
    rule.repeatMinutes = repeatMinutesFrom($('#preview'), 'rule');
    return rule;
  }
  rule.intervalMinutes = readInterval($('#preview'), '#rule-interval');
  if (usesNetworkSource(rule)) { rule.fetch = readSourceFetch($('#preview'), rule); const proxy = readSourceProxy($('#preview'), rule); if (proxy) rule.sourceProxy = proxy; else delete rule.sourceProxy; rule.sourceProxyId = readSourceProxyId($('#preview')); }
  if ($('#rule-url')) rule.url = ($('#draft-url') || $('#rule-url')).value.trim();
  if (rule.kind === 'unified') Object.assign(rule, readUnifiedRule($('#preview')));
  if (rule.kind === 'generated') { try { rule.plan = JSON.parse($('#rule-plan').value); } catch { throw new Error('监控逻辑不是有效 JSON'); } }
  if (rule.kind === 'dmit') { rule.triggerMode = $('#rule-trigger-mode').value; rule.description = rule.triggerMode === 'any-available' ? '第三方库存列表中，任意套餐有货时通知；首次检查如有货会立即通知' : '第三方库存列表中，套餐由无货变为有货时通知'; }
  if (rule.kind === 'json') { rule.jsonPath = $('#rule-json-path').value.trim(); rule.operator = $('#rule-operator').value; rule.expected = $('#rule-expected').value.trim(); rule.description = `${rule.jsonPath} ${$('#rule-operator').selectedOptions[0].textContent} ${rule.expected} 时通知`; }
  if (rule.kind === 'rss') { rule.keyword = $('#rule-keyword').value.trim(); rule.description = rule.keyword ? `出现标题包含「${rule.keyword}」的新条目时通知` : '出现新条目时通知'; }
  if (rule.kind === 'webpage') { rule.keyword = $('#rule-keyword').value.trim(); rule.mode = $('#rule-mode').value; rule.description = `页面${rule.mode === 'absent' ? '不再包含' : '出现'}「${rule.keyword}」时通知`; }
  return rule;
}

async function withButton(button, work) {
  if (pendingActions.has(button)) return;
  const group = ['save-button', 'ai-test-button', 'clear-ai-key-button'].includes(button.id) ? [...document.querySelectorAll('#settings-form button, #settings-form input')] : [];
  if (group.some((control) => pendingActions.has(control))) return;
  const operation = { epoch: workspaceEpoch, controls: group, disabled: group.map((control) => control.disabled) };
  group.forEach((control) => { control.disabled = true; });
  pendingActions.set(button, operation); stateSyncVersion++;
  button.disabled = true; button.setAttribute('aria-busy', 'true');
  try { await work(); } catch (error) { if (operation.epoch === workspaceEpoch && error.code !== 'STALE_OPERATION') toast(error.message, true); }
  finally {
    if (pendingActions.get(button) === operation) {
      pendingActions.delete(button); stateSyncVersion++;
      operation.controls.forEach((control, i) => { control.disabled = operation.disabled[i]; });
      button.disabled = false; button.removeAttribute('aria-busy');
      if (['parse-button', 'assistant-reply-button'].includes(button.id)) button.disabled = $('#assistant-dialog').dataset.status === 'generating';
      if (button.id === 'create-button' && previewMonitor) renderRevisionDiff();
    }
  }
}
async function withDrawerAction(button, work) {
  if (drawerAction) return;
  const controls = [...document.querySelectorAll('#webhook-drawer button, #webhook-drawer input, #webhook-drawer select')];
  const operation = { controls, disabled: controls.map((control) => control.disabled) };
  drawerAction = operation;
  controls.forEach((control) => { control.disabled = true; });
  $('#webhook-drawer').setAttribute('aria-busy', 'true');
  await withButton(button, work);
  if (drawerAction !== operation) return;
  drawerAction = null; controls.forEach((control, i) => { control.disabled = operation.disabled[i]; });
  $('#webhook-drawer').removeAttribute('aria-busy');
}

function showAuth() {
  workspacePoll?.abort(); workspaceTag = null; renderedMarkup = new WeakMap();
  workspaceEpoch++; stateSyncVersion++;
  for (const [button, operation] of pendingActions) { operation.controls.forEach((control, i) => { control.disabled = operation.disabled[i]; }); button.disabled = false; button.removeAttribute('aria-busy'); }
  pendingActions.clear();
  if (drawerAction) { drawerAction.controls.forEach((control, i) => { control.disabled = drawerAction.disabled[i]; }); drawerAction = null; }
  closeWebhookDrawer(true); $('#webhook-drawer').removeAttribute('aria-busy');
  for (const [button, timer] of emailTimers) { clearInterval(timer); button.disabled = false; button.textContent = '发送验证码'; }
  emailTimers.clear();
  for (const selector of ['#send-register-code', '#send-bind-code']) { $(selector).disabled = false; $(selector).textContent = '发送验证码'; }
  $('#recovery-code-screen').classList.add('hidden'); $('#recovery-code-value').textContent = '';
  draftHooks = []; editingMonitor = null;
  appState = { settings: { webhooks: [] }, monitors: [], events: [], logs: [], sentCount: 0 };
  for (const selector of ['#monitor-list', '#webhook-list', '#send-targets', '#log-list', '#activity-list']) { const node = $(selector); if (node) node.innerHTML = ''; }
  closeTaskEditor();
  if (typeof resetOrderUI === 'function') resetOrderUI();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  for (const inspection of document.querySelectorAll('.rule-dialog')) inspection.remove();
  setAuthMode('login');
  $('#auth-screen').classList.remove('hidden');
  $('.app-shell').classList.add('auth-hidden');
  previewMonitor = null;
  resetAssistant();
  $('#preview').classList.add('hidden');
  $('#preview').innerHTML = '';
  for (const selector of ['#source-proxy', '#source-proxy-name', '#source-test-url', '#ai-key', '#instruction', '#instruction-url', '#send-title', '#send-message', '#auth-recovery-code', '#auth-email-code', '#account-email-code']) $(selector).value = '';
  $('#source-proxy-type').value='shadowsocks'; $('#source-ss-method').value='aes-256-gcm'; resetSourceProxyFields();
  sourceSettingsEpoch += 1;
  releaseSourceAction(sourceAction);
  resetSourceResults();
  $('#source-proxy-status').textContent = ''; $('#source-proxy-list').replaceChildren(); delete $('#source-proxy-list').dataset.markup; $('#create-source-proxy-id').innerHTML='<option value="">手动填写</option>'; $('#create-source-proxy').disabled=false;
  $('#source-test-mode').value = 'http'; refreshChoices();
  $('#ai-test-result').textContent = '';
  $('#settings-dirty').textContent = '';
  for (const input of document.querySelectorAll('#email-password, #current-password, #new-password, #rotate-code-password')) input.value = '';
}

function showWorkspace(state) {
  workspacePoll?.abort(); workspaceTag = null;
  workspaceEpoch++; stateSyncVersion++;
  sourceSettingsEpoch += 1;
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
  const epoch = workspaceEpoch;
  button.disabled = true;
  api('/api/auth/email-code', 'POST', requestBody).then((result) => {
    let remaining = result.retryAfterSeconds || 60;
    status.textContent = '验证码已发送，请在 10 分钟内填写；请检查收件箱和垃圾邮件。';
    toast('验证码已发送');
    button.textContent = `${remaining} 秒后重发`;
    const timer = setInterval(() => {
      if (epoch !== workspaceEpoch) { clearInterval(timer); return; }
      remaining -= 1;
      button.textContent = remaining > 0 ? `${remaining} 秒后重发` : '发送验证码';
      if (remaining <= 0) { clearInterval(timer); emailTimers.delete(button); button.disabled = false; }
    }, 1000);
    emailTimers.set(button, timer);
  }).catch((error) => {
    if (epoch !== workspaceEpoch || error.code === 'STALE_OPERATION') return;
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
  try { await copyText($('#recovery-code-value').textContent); toast('恢复码已复制'); }
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

$('#logout-button').addEventListener('click', () => withButton($('#logout-button'), async () => {
  await api('/api/auth/logout', 'POST'); showAuth();
}));

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
$('#drawer-close').addEventListener('click', () => closeWebhookDrawer());
$('#drawer-backdrop').addEventListener('click', () => closeWebhookDrawer());
document.addEventListener('keydown', (event) => {
  const drawer = $('#webhook-drawer');
  if (drawer.classList.contains('hidden')) return;
  if (event.key === 'Escape') { closeWebhookDrawer(); return; }
  if (event.key === 'Tab') {
    const controls = [...drawer.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')].filter((item) => item.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
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
  try { await saveSettings(true, 'channels'); }
  catch (error) { if (error.code !== 'STALE_OPERATION') { draftHooks = previous; renderWebhooks(); } throw error; }
  closeWebhookDrawer(true);
  toast('渠道已保存');
  return hook.id;
}
$('#drawer-save').addEventListener('click', () => withDrawerAction($('#drawer-save'), saveDrawer));
$('#drawer-test').addEventListener('click', () => withDrawerAction($('#drawer-test'), async () => {
  const id = await saveDrawer();
  if (!id) return;
  const report = await api('/api/test-webhook', 'POST', { webhookId: id });
  appState = await api('/api/state');
  render(true);
  toast(report.failed.length ? report.failed[0].name + '：' + report.failed[0].error : '测试通知已发送', Boolean(report.failed.length));
}));
$('#drawer-delete').addEventListener('click', () => withDrawerAction($('#drawer-delete'), async () => {
  if (!editingHookDraft) return;
  const id = editingHookDraft.id;
  const usedBy = appState.monitors.filter((monitor) => monitor.webhookIds?.includes(id)).length;
  if (usedBy && !confirm('这个渠道被 ' + usedBy + ' 个任务使用。删除后这些任务的接收渠道会更新，继续吗？')) return;
  const previous = draftHooks.map((item) => ({ ...item }));
  draftHooks = draftHooks.filter((hook) => hook.id !== id);
  try { await saveSettings(true, 'channels'); }
  catch (error) { if (error.code !== 'STALE_OPERATION') { draftHooks = previous; renderWebhooks(); } throw error; }
  closeWebhookDrawer(true);
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
    $('#ai-test-log').classList.add('hidden');
    try {
      const report = await api('/api/ai/test', 'POST', { aiBaseUrl: $('#ai-base-url').value.trim(), aiModel: $('#ai-model').value.trim(), aiKey: $('#ai-key').value.trim() });
      result.textContent = `连接成功 · ${report.durationMs} ms`;
      result.className = 'success';
      $('#ai-test-log').classList.remove('hidden');
      api('/api/state').then((state) => { appState = state; render(); }).catch(() => {});
    } catch (error) {
      if (error.code === 'STALE_OPERATION') throw error;
      result.textContent = error.message + (error.requestId && error.code !== 'RADAR_CONNECTION_FAILED' ? '\n请求编号：' + error.requestId : '');
      result.className = 'error';
      $('#ai-test-log').classList.toggle('hidden', !error.code || error.code === 'RADAR_CONNECTION_FAILED');
      api('/api/state').then(state => { appState = state; render(); }).catch(() => {});
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
  $(selector).addEventListener('input', () => { aiInputRevision++; $('#ai-test-result').textContent = ''; $('#ai-test-result').className = ''; $('#ai-test-log').classList.add('hidden'); });
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
    resetAssistant(instruction, Boolean(editingMonitor));
    if (!editingMonitor) { previewMonitor = null; $('#preview').classList.add('hidden'); }
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
  if (editingMonitor) {
    resetAssistant('请协助我修改当前已创建的任务，保留未要求修改的设置。', true);
    addAssistantMessage('assistant', '本次对话已清空，当前修改草稿保留。可以继续告诉我想调整哪里。');
    return;
  }
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
  if (event.target.closest('#preview-check-button')) { testPreviewSource().catch((error) => toast(error.message, true)); return; }
  if (!event.target.closest('#create-button')) return;
  withButton($('#create-button'), async () => {
    try { await ensureSettings(); }
    catch (error) {
      $('#preview-result').className = 'preview-result error';
      $('#preview-result').textContent = error.message;
      addAssistantMessage('assistant', `规则已准备好，但设置需要处理：${error.message}。请检查通知渠道后再确认。`);
      location.hash = '#channels';
      return;
    }
    const rule = collectPreviewRule();
    if (rule.kind !== 'reminder' && !rule.url) { $('#preview-result').textContent = '粘贴要关注的地址，就可以创建。'; $('#draft-url')?.focus(); return; }
    if (editingMonitor) {
      const target = editingMonitor;
      try {
        appState = await api('/api/monitors/' + encodeURIComponent(target.id), 'PATCH', { rule, webhookIds: rule.webhookIds, expectedRevision: target.revision });
      } catch (error) {
        $('#preview-result').className = 'preview-result error';
        $('#preview-result').textContent = error.message;
        throw error;
      }
      cancelAIRevision();
      render(true);
      toast('原任务已更新' + (target.enabled ? '' : '，仍保持暂停'));
      return;
    }
    appState = await api('/api/monitors', 'POST', rule);
    const created = appState.monitors[0];
    previewMonitor = null;
    $('#preview').classList.add('hidden');
    resetAssistant();
    addAssistantMessage('assistant', created.kind === 'reminder' ? '提醒已创建，' + (created.repeatMinutes ? repeatLabel(created.repeatMinutes) + '，首次 ' : '将在 ') + reminderDate(created.remindAt) + '发送。' : '监控“' + created.label + '”已创建，之后会按规则自动检查。');
    assistantPhase('created');
    $('#instruction').value = '';
    $('#instruction-url').value = '';
    render(true);
    toast(created.kind === 'reminder' ? '提醒已创建，等待首次发送' : created.lastError ? '监控已创建，首次检查失败：' + created.lastError : '监控已创建，首次检查已完成', Boolean(created.lastError));
    location.hash = '#monitors';
  });
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || !button.closest('#monitor-list, #task-workspace')) return;
  const { id, action } = button.dataset;
  const monitor = appState.monitors.find((item) => item.id === id);
  if (!monitor) return;
  if (['rule-logs', 'rule-repair'].includes(action)) return;
  if (action === 'edit' || action === 'proxy') { openTaskEditor(monitor, action === 'proxy' ? 'source' : undefined); return; }
  if (action === 'refine') { try { startAIRevision(monitor); } catch (error) { toast(error.message, true); } return; }
  if (action === 'notification') { openNotificationEditor(monitor); return; }
  if (action === 'delete' && !confirm(`删除“${monitor.label}”？`)) return;
  withButton(button, async () => {
    const path = `/api/monitors/${encodeURIComponent(id)}`;
    if (action === 'save-rule') {
      const editor = $('#task-workspace .monitor-route');
      const update = readSavedRule(editor, monitor);
      appState = await api(path, 'PATCH', { ...update, expectedRevision: Number(editor.dataset.revision) });
      closeTaskEditor();
      toast('任务已更新');
    } else if (action === 'check') {
      appState = await api(`${path}/check`, 'POST');
      const updated = appState.monitors.find((item) => item.id === id);
      const check = appState.check;
      if (check.skipped) toast('任务正在检查，请稍后查看结果');
      else if (check.notDue && updated.kind === 'reminder') toast('尚未到提醒时间：' + reminderDate(updated.remindAt));
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
    render(true, action === 'save-rule' ? id : undefined);
  });
});

async function refreshWorkspace() {
  if (document.hidden || workspacePoll || $('.app-shell').classList.contains('auth-hidden') || sourceSettingsBusy || pendingActions.size) return;
  workspacePoll = new AbortController();
  const epoch = sourceSettingsEpoch, userId = appState.user?.id, version = stateSyncVersion, authEpoch = workspaceEpoch;
  const isCurrent = () => epoch === sourceSettingsEpoch && version === stateSyncVersion && !pendingActions.size && userId === appState.user?.id && !$('.app-shell').classList.contains('auth-hidden');
  const responseInfo = {};
  const etag = workspaceTag?.authEpoch === authEpoch && workspaceTag.userId === userId ? workspaceTag.etag : null;
  try {
    const state = await api('/api/state', 'GET', undefined, { etag, allowNotModified: true, responseInfo, signal: AbortSignal.any([workspacePoll.signal, AbortSignal.timeout(20000)]) });
    if (isCurrent()) {
      if (state) { appState = state; workspaceTag = { authEpoch, userId, etag: responseInfo.etag }; render(); }
      else refreshRelativeTimes();
    }
  } catch (error) { if (isCurrent() && error.message === '请先登录') showAuth(); }
  finally { workspacePoll = null; }
}

async function init() {
  window.addEventListener('pagehide', () => workspacePoll?.abort());
  document.addEventListener('visibilitychange', () => { if (document.hidden) workspacePoll?.abort(); });
  setInterval(refreshWorkspace, 30000);
  try {
    const status = await api('/api/auth/status');
    if (status.signupCodeRequired) $('#auth-screen').dataset.signupCodeRequired = '1';
    emailVerificationEnabled = Boolean(status.emailVerificationEnabled);
    setAuthMode(authMode);
    if (status.authenticated) showWorkspace(await api('/api/state'));
    else showAuth();

  } catch (error) { if (error.code === 'STALE_OPERATION') return; showAuth(); toast(`无法连接本地服务：${error.message}`, true); }
}
$('#send-priority-slot').innerHTML = priorityPicker('send-priority', null, true);
setAuthMode('login');
init();

let sourceSettingsBusy = false;
let sourceSettingsEpoch = 0;
let sourceAction = null;

function releaseSourceAction(operation) {
  if (!operation || sourceAction !== operation) return;
  sourceAction = null;
  sourceSettingsBusy = false;
  operation.controls.forEach((control, index) => { control.disabled = operation.disabled[index]; });
  operation.button.textContent = operation.label;
  $('#fetch-settings').setAttribute('aria-busy', 'false');
}

function resetSourceResults() {
  for (const selector of ['#source-connection-result', '#source-proxy-result']) {
    $(selector).textContent = '';
    $(selector).className = 'field-help';
  }
}

function sourceConnectionSummary(result = {}) {
  return '出口 IP：' + (result.ip || '未返回') + (Number.isFinite(result.durationMs) ? ' · ' + result.durationMs + ' ms' : '');
}

function updateSourceProxyFields() {
  const ss = $('#source-proxy-type').value === 'shadowsocks';
  $('#source-ss-fields').classList.toggle('hidden', !ss);
  $('#source-proxy-url-fields').classList.toggle('hidden', ss);
  const modern = $('#source-ss-method').value.startsWith('2022-');
  $('#source-ss-help').textContent = modern ? '填写服务器提供的 Base64 密钥，程序自动生成连接配置。加密方式须与服务器一致。' : '填写原始密码即可，程序自动生成连接配置。加密方式须与服务器一致。';
  $('#source-ss-password').placeholder = modern ? '填写服务器提供的 Base64 密钥' : '填写服务器提供的密码';
}
function resetSourceProxyFields() {
  for (const selector of ['#source-proxy', '#source-proxy-name', '#source-ss-server', '#source-ss-port', '#source-ss-password']) $(selector).value = '';
  $('#source-ss-method').value='aes-256-gcm';
  updateSourceProxyFields();
}
function readSourceProxyInput(status, requireCandidate = false) {
  const fail = (message, selector) => { status.textContent = message; status.className = 'field-help error'; $(selector).focus(); return null; };
  if ($('#source-proxy-type').value === 'url') {
    const proxyUrl = $('#source-proxy').value.trim();
    if (!proxyUrl && (requireCandidate || !appState.settings.hasSourceProxy)) return fail('请填写代理地址或 SS 分享链接。', '#source-proxy');
    return {proxyUrl};
  }
  const shadowsocks = {server:$('#source-ss-server').value.trim(),port:$('#source-ss-port').value.trim(),method:$('#source-ss-method').value,password:$('#source-ss-password').value};
  const started = shadowsocks.server || shadowsocks.port || shadowsocks.password || shadowsocks.method !== 'aes-256-gcm';
  if (!started && !requireCandidate && appState.settings.hasSourceProxy) return {proxyUrl:''};
  if (!shadowsocks.server) return fail('请填写 Shadowsocks 服务器 IP 或域名。', '#source-ss-server');
  if (!/^\d+$/.test(shadowsocks.port) || Number(shadowsocks.port) < 1 || Number(shadowsocks.port) > 65535) return fail('请填写 1–65535 范围内的服务器端口。', '#source-ss-port');
  if (!shadowsocks.password) return fail('请填写服务器提供的密码或密钥。', '#source-ss-password');
  return {shadowsocks};
}

function renderSourceSettings(reset = false) {
  const { hasSourceProxy, sourceProxyEndpoint, sourceProxyTest } = appState.settings;
  const profiles = appState.settings.sourceProxies || [];
  const list = $('#source-proxy-list');
  const markup = profiles.map(item=>'<div class="proxy-profile-row"><div><strong>'+escapeHtml(item.name)+'</strong><p class="field-help">'+escapeHtml(item.endpoint+(item.test?.ip?' · '+item.test.ip:''))+'</p></div><div class="proxy-profile-actions"><button type="button" class="button button-outline" data-proxy-use="'+escapeHtml(item.id)+'" '+(appState.settings.sourceProxyId===item.id?'disabled':'')+'>'+(appState.settings.sourceProxyId===item.id?'默认出口':'设为默认')+'</button><button type="button" class="button button-outline" data-proxy-test="'+escapeHtml(item.id)+'">测试</button><button type="button" class="button button-outline danger" data-proxy-delete="'+escapeHtml(item.id)+'">删除</button></div></div>').join('') || '<p class="field-help">尚未添加代理，可在下方连续添加。</p>';
  if (list.dataset.markup !== markup) { list.innerHTML=markup; list.dataset.markup=markup; }
  const selected = $('#create-source-proxy-id').value;
  const options = proxyProfileOptions(selected);
  if ($('#create-source-proxy-id').innerHTML !== options) { $('#create-source-proxy-id').innerHTML=options; $('#create-source-proxy-id').value=profiles.some(item=>item.id===selected)?selected:''; }
  $('#create-source-proxy').disabled=Boolean($('#create-source-proxy-id').value);
  const covered = appState.monitors.filter(monitor => usesNetworkSource(monitor) && (!monitor.fetch?.proxy || monitor.fetch.proxy === 'default')).length;
  const verified = sourceProxyTest?.ip ? ' · 验证时出口 IP：' + sourceProxyTest.ip : '';
  $('#source-proxy-status').textContent = hasSourceProxy ? '已启用 · ' + sourceProxyEndpoint + ' · ' + covered + ' 个网络监控任务使用此出口' + verified : '当前使用服务器出口 · 先验证代理，再应用到监控';
  $('#source-proxy-clear').classList.toggle('hidden', !hasSourceProxy);
  $('#source-proxy').placeholder = hasSourceProxy ? '留空可测试默认代理，输入新地址可新增' : 'ss://节点分享链接 或 http://主机:端口';
  if (reset) { $('#source-proxy-type').value='shadowsocks'; $('#source-ss-method').value='aes-256-gcm'; resetSourceProxyFields(); resetSourceResults(); }
}

async function withSourceAction(button, loadingLabel, work) {
  if (sourceSettingsBusy) return;
  const controls = [...document.querySelectorAll('#source-proxy-list button'), ...['#source-proxy-type', '#source-ss-method', '#source-ss-server', '#source-ss-port', '#source-ss-password', '#source-proxy', '#source-proxy-name', '#source-proxy-add', '#source-proxy-test', '#source-proxy-save', '#source-proxy-clear', '#source-target-test', '#source-test-url', '#source-test-mode'].map(selector => $(selector))];
  const disabled = controls.map(control => control.disabled);
  const epoch = ++sourceSettingsEpoch;
  const label = button.textContent;
  const operation = { controls, disabled, button, label };
  sourceAction = operation;
  sourceSettingsBusy = true;
  controls.forEach(control => { control.disabled = true; });
  button.textContent = loadingLabel;
  $('#fetch-settings').setAttribute('aria-busy', 'true');
  try { await work(() => epoch === sourceSettingsEpoch); }
  catch (error) { if (epoch === sourceSettingsEpoch) toast(error.message, true); }
  finally {
    releaseSourceAction(operation);
  }
}

for (const selector of ['#source-proxy', '#source-proxy-type', '#source-ss-method', '#source-ss-server', '#source-ss-port', '#source-ss-password']) {
  $(selector).addEventListener('input', resetSourceResults);
}
$('#source-proxy-type').addEventListener('change', updateSourceProxyFields);
$('#source-ss-method').addEventListener('change', updateSourceProxyFields);
updateSourceProxyFields();
for (const selector of ['#source-test-url', '#source-test-mode']) {
  $(selector).addEventListener('input', () => {
    $('#source-proxy-result').textContent = '';
    $('#source-proxy-result').className = 'field-help';
  });
}
$('#source-settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const status = $('#source-connection-result');
  const proxyInput = readSourceProxyInput(status);
  if (!proxyInput) return;
  withSourceAction($('#source-proxy-save'), '正在验证…', async (isCurrent) => {
    status.textContent = '正在验证代理连接，验证通过后应用到监控…';
    status.className = 'field-help';
    try {
      const state = await api('/api/source-proxy', 'PUT', { ...proxyInput, name:$('#source-proxy-name').value.trim(), applyAll: true });
      if (!isCurrent()) return;
      appState = state;
      resetSourceProxyFields();
      $('#source-proxy-result').textContent = '';
      render();
      status.textContent = '验证通过，已应用到账户默认出口 · ' + sourceConnectionSummary(state.settings.sourceProxyTest);
      status.className = 'field-help success';
      toast('代理验证通过，已应用到使用账户默认出口的网页与接口监控');
    } catch (error) {
      if (!isCurrent()) return;
      const uncertain = !error.status || error.status >= 500;
      const detail = error.code === 'SOURCE_CHECK_BUSY' ? '代理已验证，任务正在检查，本次暂未应用。'
        : error.code === 'PROXY_CONFIG_CHANGED' ? '代理配置已被其他操作更新，本次未应用。'
        : error.code === 'PROXY_TEST_BUSY' ? '已有代理测试正在进行，本次未应用。'
        : uncertain ? '未收到应用确认，请刷新页面确认当前代理配置。'
        : '代理验证未通过，本次未应用。';
      status.textContent = detail + '\n' + error.message;
      status.className = 'field-help error';
      if (error.status === 409 || uncertain) {
        try { const state = await api('/api/state'); if (isCurrent()) { appState = state; render(); } } catch { /* keep candidate and error for retry */ }
      }
      throw error;
    }
  });
});
$('#source-proxy-add').addEventListener('click',()=>{
  const status=$('#source-connection-result'),proxyInput=readSourceProxyInput(status,true); if(!proxyInput)return;
  const name=$('#source-proxy-name').value.trim();
  withSourceAction($('#source-proxy-add'),'正在验证…',async isCurrent=>{
    status.textContent='正在生成配置并验证连接…';status.className='field-help';
    try {
      const state=await api('/api/source-proxies','POST',{name,...proxyInput}); if(!isCurrent())return;
      appState=state; resetSourceProxyFields(); render();
      status.textContent='验证通过，代理已保存，可在列表中查看出口 IP。';status.className='field-help success';
      toast('代理已保存，可在列表或监控中选择');
    } catch(error) { if(isCurrent()){status.textContent='代理验证未通过，请核对参数后重试。\n'+error.message;status.className='field-help error';}throw error; }
  });
});
$('#source-proxy-list').addEventListener('click',event=>{
  const button=event.target.closest('[data-proxy-use],[data-proxy-delete],[data-proxy-test]'); if(!button)return;
  const id=button.dataset.proxyUse||button.dataset.proxyDelete||button.dataset.proxyTest;
  withSourceAction(button,'正在处理…',async isCurrent=>{
    if(button.dataset.proxyTest){const result=await api('/api/source-proxy/test','POST',{sourceProxyId:id});if(isCurrent()){ $('#source-connection-result').textContent='连接正常 · '+sourceConnectionSummary(result); $('#source-connection-result').className='field-help success';}return;}
    const state=button.dataset.proxyUse ? await api('/api/source-proxy','PUT',{sourceProxyId:id}) : await api('/api/source-proxies/'+encodeURIComponent(id),'DELETE');
    if(!isCurrent())return; appState=state; render(); toast(button.dataset.proxyUse?'已切换默认代理':'已删除列表条目，已有任务出口保留');
  });
});
$('#source-proxy-clear').addEventListener('click', () => {
  withSourceAction($('#source-proxy-clear'), '正在清除…', async (isCurrent) => {
    const state = await api('/api/source-proxy', 'DELETE');
    if (!isCurrent()) return;
    appState = state;
    resetSourceProxyFields();
    resetSourceResults();
    render();
    toast('已恢复服务器出口');
  });
});
$('#ai-test-log').addEventListener('click', () => {
  $('#activity .log-panel').scrollIntoView({ block: 'start' });
  $('#log-errors-only').checked = false;
  renderLogs();
});
$('#source-proxy-test').addEventListener('click', () => {
  const status = $('#source-connection-result');
  const proxyInput = readSourceProxyInput(status);
  if (!proxyInput) return;
  withSourceAction($('#source-proxy-test'), '正在测试…', async (isCurrent) => {
    status.textContent = '正在测试代理连接，无需填写目标网站…';
    status.className = 'field-help';
    try {
      const result = await api('/api/source-proxy/test', 'POST', proxyInput);
      if (!isCurrent()) return;
      status.textContent = '代理连接正常 · ' + sourceConnectionSummary(result) + (proxyInput.shadowsocks || proxyInput.proxyUrl ? '。\n点击“添加代理”保存到列表，也可选择“添加并设为默认”。' : '。\n本次仅测试，不更改代理配置。');
      status.className = 'field-help success';
    } catch (error) {
      if (!isCurrent()) return;
      status.textContent = '代理连接测试失败，本次未更改配置。\n' + error.message;
      status.className = 'field-help error';
      throw error;
    }
  });
});
$('#source-target-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const status = $('#source-proxy-result');
  const targetUrl = $('#source-test-url').value.trim();
  if (!targetUrl) {
    status.textContent = '请填写要测试的网站或接口地址；仅测试代理请使用上方按钮。';
    status.className = 'field-help error';
    $('#source-test-url').focus();
    return;
  }
  try {
    const url = new URL(targetUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error();
  } catch {
    status.textContent = '网站或接口地址需以 http:// 或 https:// 开头，例如 https://example.com。';
    status.className = 'field-help error';
    $('#source-test-url').focus();
    return;
  }
  const proxyInput = readSourceProxyInput(status);
  if (!proxyInput) return;
  const mode = $('#source-test-mode').value;
  withSourceAction($('#source-target-test'), '正在读取…', async (isCurrent) => {
    status.textContent = '正在读取目标网站…';
    status.className = 'field-help';
    try {
      const result = await api('/api/source-proxy/test', 'POST', { ...proxyInput, targetUrl, mode });
      if (!isCurrent()) return;
      status.textContent = '目标读取成功 · HTTP ' + result.status + ' · ' + result.durationMs + ' ms · ' + (result.method === 'browser' ? '浏览器' : '直接请求');
      status.className = 'field-help success';
    } catch (error) {
      if (!isCurrent()) return;
      status.textContent = '目标网站读取失败，已保存代理配置未更改；可先测试代理连接。\n' + error.message;
      status.className = 'field-help error';
      throw error;
    }
  });
});
document.addEventListener('change', (event) => {
  if (!event.target.matches('.source-fetch-proxy')) return;
  const root = event.target.closest('.monitor-route, .rule-editor');
  root?.querySelector('.source-custom-proxy')?.classList.toggle('hidden', event.target.value !== 'custom');
});
document.addEventListener('change',event=>{
  if(!event.target.matches('.source-proxy-id'))return;
  const panel=event.target.closest('.source-custom-proxy'), input=panel.querySelector('.source-proxy-input');
  input.value=''; input.disabled=Boolean(event.target.value);
  const status=panel.querySelector('.rule-proxy-result'); status.textContent='保存前会验证所选代理，原监控记录保留。';status.className='rule-proxy-result';
});
document.addEventListener('input', (event) => {
  if (!event.target.matches('.source-proxy-input')) return;
  const status = event.target.closest('.source-custom-proxy').querySelector('.rule-proxy-result');
  status.className = 'rule-proxy-result';
  status.textContent = '保存前会验证代理连通性；验证失败保留原设置。';
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-source-proxy-test]');
  if (!button) return;
  const panel = button.closest('.source-custom-proxy'), root = button.closest('.monitor-route, .rule-editor');
  const input = panel.querySelector('.source-proxy-input'), status = panel.querySelector('.rule-proxy-result');
  const monitorId = root?.dataset.id || editingMonitor?.id;
  const monitor = appState.monitors.find((item) => item.id === monitorId);
  const proxyUrl = input.value.trim() || (root?.classList.contains('rule-editor') ? previewMonitor?.sourceProxy : '');
  const sourceProxyId = panel.querySelector('.source-proxy-id')?.value;
  if (!proxyUrl && !sourceProxyId && !monitor?.hasSourceProxy) { status.textContent = '请先填入独立代理地址'; status.className = 'rule-proxy-result error'; input.focus(); return; }
  withButton(button, async () => {
    const epoch = workspaceEpoch;
    input.disabled = true;
    status.textContent = '正在验证连接与出口 IP…'; status.className = 'rule-proxy-result';
    try {
      const result = await api('/api/source-proxy/test', 'POST', { proxyUrl: proxyUrl || undefined, sourceProxyId, monitorId: proxyUrl || sourceProxyId ? undefined : monitorId });
      if (!panel.isConnected) return;
      status.textContent = '连接成功 · ' + sourceConnectionSummary(result);
      status.className = 'rule-proxy-result success';
    } catch (error) {
      if (error.code !== 'STALE_OPERATION' && panel.isConnected) { status.textContent = error.message; status.className = 'rule-proxy-result error'; }
      throw error;
    } finally { if (epoch === workspaceEpoch && input.isConnected) input.disabled = false; }
  });
});

function releaseElementPreview(id){if(id)void fetch('/api/element-preview',{method:'DELETE',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({previewId:id})}).catch(()=>{});}
