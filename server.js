import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DMIT_PRICING_URL, DMIT_STOCK_URL, inspectPage, isTransition, restockedItems } from './lib/monitor.js';
import { validateGeneratedPlan, inspectGenerated, transitionGenerated, describeGeneratedPlan } from './lib/generated.js';
import { validateLocalSource, inspectLog, inspectService, userLogDirectory } from './lib/sources.js';
import { WEBHOOK_FORMATS, createWebhookPayload, assertWebhookAccepted } from './lib/webhook.js';
import { createStore } from './lib/store.js';
import { createEmailCodeService } from './lib/email.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, '.data');
const logRoot = process.env.MONITOR_LOG_ROOT ? path.resolve(process.env.MONITOR_LOG_ROOT) : path.join(dataDir, 'monitor-logs');
const emailCodes = createEmailCodeService({ apiKey: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM, endpoint: process.env.RESEND_API_URL || undefined });
const store = createStore(dataDir, emailCodes);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const activeChecks = new Set();
if ((process.env.HTTP_PROXY || process.env.HTTPS_PROXY) && typeof http.setGlobalProxyFromEnv === 'function') {
  http.setGlobalProxyFromEnv({ ...process.env, NO_PROXY: [process.env.NO_PROXY, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',') });
}

const persist = () => store.persist();
const publicState = (user) => {
  const state = store.publicWorkspace(user);
  state.user.logDirectory = userLogDirectory(logRoot, user);
  if (!process.env.MONITOR_LOG_ROOT) fs.mkdirSync(state.user.logDirectory, { recursive: true });
  return state;
};

function addEvent(user, type, title, detail, monitorId = null) {
  user.events.unshift({ id: randomUUID(), type, title, detail, monitorId, at: new Date().toISOString() });
  user.events.length = Math.min(user.events.length, 100);
  persist();
}

function addLog(user, kind, status, detail, url, durationMs, monitorId = null, raw = null) {
  const displayUrl = kind === 'webhook' && url ? `${new URL(url).origin}/…` : url;
  user.logs.unshift({ id: randomUUID(), kind, status, detail: String(detail).slice(0, 500), url: displayUrl, durationMs, monitorId, raw, at: new Date().toISOString() });
  user.logs.length = Math.min(user.logs.length, 300);
  persist();
}

function urlOf(value, label) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch { throw new Error(`${label}不是有效地址`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${label}仅支持无账号信息的 HTTP 或 HTTPS 地址`);
  if (parsed.href.length > 2000) throw new Error(`${label}过长`);
  return parsed.href;
}

function sourceOf(value, sourceType = '') {
  const raw = String(value || '').trim();
  if (sourceType === 'log' || raw.startsWith('log:') || !raw.includes('://') && /\.log$/i.test(raw)) return validateLocalSource('log', raw);
  if (sourceType === 'service' || raw.toLowerCase().startsWith('tcp://')) {
    const local = validateLocalSource('service', raw);
    if (local) return local;
  }
  return urlOf(raw, '监控来源');
}

function validateWebhooks(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Webhook 地址最多添加 20 个');
  const ids = new Set();
  const urls = new Set();
  return value.map((item, index) => {
    const id = String(item.id || randomUUID());
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id) || ids.has(id)) throw new Error('Webhook 标识重复或无效');
    ids.add(id);
    const url = urlOf(item.url, `第 ${index + 1} 个 Webhook 地址`);
    if (urls.has(url)) throw new Error('同一个 Webhook 地址不能重复添加');
    urls.add(url);
    const format = item.format || 'auto';
    if (!WEBHOOK_FORMATS.includes(format)) throw new Error('不支持的 Webhook 格式');
    const priority = item.priority == null ? 3 : Number(item.priority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 5) throw new Error('ntfy 优先级必须在 1 到 5 之间');
    return { id, name: String(item.name || `Webhook ${index + 1}`).trim().slice(0, 40), url, enabled: item.enabled !== false, format, priority };
  });
}

function selectedWebhookIds(user, ids) {
  const active = user.settings.webhooks.filter((hook) => hook.enabled);
  const selected = ids == null ? active.map((hook) => hook.id) : ids;
  if (!Array.isArray(selected) || !selected.length) throw new Error('请至少选择一个接收渠道');
  const unique = [...new Set(selected.map(String))];
  if (unique.some((id) => !active.some((hook) => hook.id === id))) throw new Error('所选接收渠道不存在或已停用');
  return unique;
}

function validateMonitor(candidate, options = {}) {
  if (!candidate || !['dmit', 'dmit-product', 'webpage', 'json', 'rss', 'github', 'generated', 'reminder'].includes(candidate.kind)) throw new Error('无法识别监控类型');
  const minInterval = candidate.kind === 'generated' && ['service', 'log'].includes(candidate.plan?.sourceType) ? 1 : 5;
  const intervalMinutes = Math.max(minInterval, Math.min(1440, Number(candidate.intervalMinutes) || 5));
  const label = String(candidate.label || '未命名监控').trim().slice(0, 60);
  const description = String(candidate.description || '').trim().slice(0, 180);
  const severity = ['info', 'warning', 'critical'].includes(candidate.severity) ? candidate.severity : 'warning';
  if (candidate.kind === 'reminder') {
    const rawTime = String(candidate.remindAt || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(rawTime)) throw new Error('提醒时间需要包含日期、时刻和时区');
    const timestamp = Date.parse(rawTime);
    if (!Number.isFinite(timestamp) || timestamp <= Date.now() && !options.allowPastReminder) throw new Error('提醒时间已过，请提供未来的具体时间');
    const message = String(candidate.message || '').trim();
    if (!message || message.length > 2000) throw new Error('请告诉我到时提醒什么内容');
    return { kind: 'reminder', label, description: message.slice(0, 180), message, remindAt: new Date(timestamp).toISOString(), severity };
  }
  if (candidate.kind === 'dmit') return { kind: 'dmit', url: DMIT_STOCK_URL, label, description, intervalMinutes, triggerMode: candidate.triggerMode === 'any-available' ? 'any-available' : 'restock' };
  if (candidate.kind === 'generated') {
    const plan = validateGeneratedPlan(candidate.plan);
    const url = sourceOf(candidate.url, plan.sourceType);
    if (plan.sourceType === 'log' && !url.startsWith('log:') || plan.sourceType === 'service' && !url.startsWith('tcp://') && !/^https?:\/\//.test(url) || !['log', 'service'].includes(plan.sourceType) && !/^https?:\/\//.test(url)) throw new Error('来源与监控规则类型不匹配');
    return { kind: 'generated', url, label, description: describeGeneratedPlan(plan), intervalMinutes, severity, plan };
  }
  const url = urlOf(candidate.url, '监控地址');
  if (candidate.kind === 'dmit-product') {
    const parsed = new URL(url);
    if (!/(^|\.)dmit\.io$/i.test(parsed.hostname) || !/^\/(cart|aff)\.php$/i.test(parsed.pathname)) throw new Error('DMIT 套餐监控需要官方购买链接');
    return { kind: 'dmit-product', url, label, description, intervalMinutes };
  }
  if (candidate.kind === 'github') {
    if (!/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(url)) throw new Error('GitHub Release 地址无效');
    return { kind: 'github', url, label, description, intervalMinutes };
  }
  if (candidate.kind === 'rss') return { kind: 'rss', url, label, description, intervalMinutes, keyword: String(candidate.keyword || '').trim().slice(0, 80) };
  if (candidate.kind === 'json') {
    const jsonPath = String(candidate.jsonPath || '').trim();
    if (!/^[\w-]+(?:\.[\w-]+)*$/.test(jsonPath) || jsonPath.length > 120) throw new Error('JSON 字段路径无效，请使用 a.b.c 格式');
    const operator = String(candidate.operator || 'equals');
    if (!['equals', 'notEquals', 'contains', 'gt', 'gte', 'lt', 'lte'].includes(operator)) throw new Error('JSON 比较方式无效');
    const expected = String(candidate.expected ?? '').trim();
    if (!expected || expected.length > 120) throw new Error('请填写 JSON 比较值');
    return { kind: 'json', url, label, description, intervalMinutes, jsonPath, operator, expected };
  }
  const keyword = String(candidate.keyword || '').trim();
  if (keyword.length < 2 || keyword.length > 80) throw new Error('监控文字长度需要在 2 到 80 字之间');
  return { kind: 'webpage', url, label, description, intervalMinutes, keyword, mode: candidate.mode === 'absent' ? 'absent' : 'contains' };
}

async function readLimited(response, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('响应内容过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchText(url, options = {}) {
  let response;
  try { response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(options.timeout || 15000), ...options }); }
  catch (error) {
    const failure = new Error(`连接失败：${error.cause?.code || error.name || '网络错误'}${error.cause?.message ? ` · ${error.cause.message}` : ''}`);
    failure.networkCode = error.cause?.code || error.name || '网络错误';
    failure.networkCause = error.cause?.message || '';
    throw failure;
  }
  options.onResponse?.(response.status);
  const body = await readLimited(response, options.maxBytes || 2_000_000);
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}${body ? ` · ${body.replace(/<[^>]+>/g, ' ').slice(0, 100)}` : ''}`);
    error.responseStatus = response.status;
    error.responseBody = body.slice(0, 12000);
    throw error;
  }
  return body;
}

async function deliver(user, payload, ids, { includeDisabled = false } = {}) {
  const targets = user.settings.webhooks.filter((hook) => ids.includes(hook.id) && (hook.enabled || includeDisabled));
  if (!targets.length) return { sent: [], failed: [] };
  const results = await Promise.allSettled(targets.map(async (hook) => {
    const started = Date.now();
    const formatted = createWebhookPayload(hook, payload);
    let status;
    try {
      const responseText = await fetchText(hook.url, {
        method: 'POST', headers: formatted.headers || { 'content-type': 'application/json; charset=utf-8' }, body: typeof formatted.body === 'string' ? formatted.body : JSON.stringify(formatted.body), maxBytes: 100_000,
        onResponse: (code) => { status = code; }
      });
      assertWebhookAccepted(formatted.format, responseText);
      addLog(user, 'webhook', 'success', `${hook.name} · HTTP ${status}`, hook.url, Date.now() - started, payload.monitorId);
    } catch (error) {
      addLog(user, 'webhook', 'error', `${hook.name} · ${error.message}`, hook.url, Date.now() - started, payload.monitorId);
      throw error;
    }
  }));
  const sent = [];
  const failed = [];
  results.forEach((result, index) => {
    const hook = targets[index];
    if (result.status === 'fulfilled') sent.push({ id: hook.id, name: hook.name });
    else failed.push({ id: hook.id, name: hook.name, error: result.reason?.message || '发送失败' });
  });
  user.sentCount += sent.length;
  persist();
  return { sent, failed };
}

async function flushPending(user, monitor) {
  let sentCount = 0;
  let failedCount = 0;
  for (const pending of monitor.pendingNotifications) {
    const report = await deliver(user, pending.payload, pending.remainingIds);
    sentCount += report.sent.length;
    failedCount += report.failed.length;
    const sentIds = new Set(report.sent.map((hook) => hook.id));
    pending.remainingIds = pending.remainingIds.filter((id) => !sentIds.has(id));
    if (report.sent.length) addEvent(user, 'success', monitor.kind === 'reminder' ? '提醒已发送' : '监控通知已发送', `${monitor.label} → ${report.sent.map((hook) => hook.name).join('、')}`, monitor.id);
    if (report.failed.length) addEvent(user, 'error', '通知发送失败，稍后重试', report.failed.map((hook) => `${hook.name}：${hook.error}`).join('；'), monitor.id);
  }
  monitor.pendingNotifications = monitor.pendingNotifications.filter((pending) => pending.remainingIds.length);
  persist();
  return { sentCount, failedCount };
}

async function checkReminder(user, reminder) {
  if (activeChecks.has(reminder.id)) return { checked: false, skipped: true };
  if (reminder.completedAt || Date.parse(reminder.remindAt) > Date.now()) return { checked: false, notDue: true };
  activeChecks.add(reminder.id);
  try {
    if (!reminder.firedAt) {
      reminder.firedAt = new Date().toISOString();
      reminder.pendingNotifications.push({
        id: randomUUID(),
        payload: { event: 'reminder.due', title: reminder.label, message: reminder.message, monitorId: reminder.id, priority: reminder.priority, severity: reminder.severity },
        remainingIds: [...reminder.webhookIds]
      });
      persist();
    }
    const report = await flushPending(user, reminder);
    reminder.lastCheckAt = new Date().toISOString();
    if (!reminder.pendingNotifications.length) {
      reminder.completedAt = reminder.lastCheckAt;
      reminder.lastResult = '提醒已发送';
      reminder.lastError = '';
      addLog(user, 'reminder', 'success', reminder.label + ' · 已发送', null, 0, reminder.id);
    } else {
      reminder.lastError = '提醒已到时间，部分渠道发送失败或停用，将重试';
      addLog(user, 'reminder', 'error', reminder.label + ' · ' + reminder.lastError, null, 0, reminder.id);
    }
    persist();
    return { checked: true, triggered: true, sentCount: report.sentCount, failedCount: report.failedCount, pendingCount: reminder.pendingNotifications.length };
  } catch (error) {
    reminder.lastCheckAt = new Date().toISOString();
    reminder.lastError = error.message;
    addLog(user, 'reminder', 'error', reminder.label + ' · ' + error.message, null, 0, reminder.id);
    return { checked: false, error: error.message };
  } finally {
    activeChecks.delete(reminder.id);
  }
}

function currentStateMatches(monitor, current) {
  if (monitor.kind === 'dmit') return monitor.triggerMode === 'any-available' ? current.available > 0 : null;
  if (['webpage', 'json'].includes(monitor.kind)) return current.matched === true;
  if (monitor.kind !== 'generated') return null;
  if (monitor.plan.sourceType === 'log' || ['changed', 'item-transition', 'new-item'].includes(monitor.plan.mode)) return null;
  if (monitor.plan.sourceType === 'service' && monitor.plan.mode === 'available') return null;
  if (monitor.plan.sourceType === 'service' && monitor.plan.mode === 'unavailable') return current.matched === true && (current.consecutiveFailures || 0) >= (monitor.plan.failureThreshold || 1);
  return current.matched === true;
}

async function checkMonitor(user, monitor, { manual = false } = {}) {
  if (monitor.kind === 'reminder') return checkReminder(user, monitor);
  if (activeChecks.has(monitor.id)) return { checked: false, skipped: true };
  activeChecks.add(monitor.id);
  const started = Date.now();
  const hadPending = Boolean(monitor.pendingNotifications.length);
  let sentCount = 0;
  let failedCount = 0;
  let responseStatus;
  let responseSample = '';
  try {
    const retried = await flushPending(user, monitor);
    sentCount += retried.sentCount;
    failedCount += retried.failedCount;
    let current;
    if (monitor.kind === 'generated' && monitor.plan.sourceType === 'service') {
      current = await inspectService(monitor.url, monitor.plan);
      responseStatus = current.httpStatus;
    } else if (monitor.kind === 'generated' && monitor.plan.sourceType === 'log') {
      current = inspectLog(logRoot, user, monitor, monitor.snapshot);
    } else {
      const expectsJson = ['dmit', 'json', 'github'].includes(monitor.kind) || monitor.kind === 'generated' && monitor.plan.sourceType === 'json';
      const html = await fetchText(monitor.url, { headers: { 'user-agent': 'WebhookRadar/2.0', accept: expectsJson ? 'application/json' : '*/*' }, onResponse: (code) => { responseStatus = code; } });
      responseSample = html.slice(0, 4000);
      current = monitor.kind === 'generated' ? inspectGenerated(monitor.plan, html) : inspectPage(monitor, html);
    }
    const transitioned = monitor.kind === 'generated' ? transitionGenerated(monitor.plan, monitor.snapshot, current) : isTransition(monitor, monitor.snapshot, current);
    const conditionSatisfied = currentStateMatches(monitor, current);
    const triggered = transitioned || manual && conditionSatisfied === true && !hadPending;
    if (triggered) {
      if (!monitor.webhookIds.length) {
        monitor.lastError = '没有接收渠道，请先为任务选择 Webhook';
        monitor.lastCheckAt = new Date().toISOString();
        persist();
        return { checked: true, triggered, conditionSatisfied, sentCount, failedCount };
      }
      const message = monitor.kind === 'dmit'
        ? monitor.triggerMode === 'any-available'
          ? `DMIT 库存列表检测到有货：${Object.values(current.items).filter((item) => item.status === 'available').map((item) => item.name).join('、')}。请以官方购买页为准：${DMIT_PRICING_URL}`
          : `DMIT 库存列表检测到补货：${restockedItems(monitor.snapshot, current).map((item) => item.name).join('、')}。请以官方购买页为准：${DMIT_PRICING_URL}`
        : monitor.kind === 'dmit-product' ? '指定的 DMIT 套餐购买页已从缺货变为可购买。'
        : monitor.kind === 'rss' ? `订阅源出现新条目：${current.entries.filter((entry) => !monitor.snapshot.entries.some((old) => old.link === entry.link) && (!monitor.keyword || entry.title.includes(monitor.keyword))).map((entry) => entry.title).slice(0, 3).join('、')}`
        : monitor.kind === 'github' ? `发布了新版本 ${current.tag}：${current.link}`
        : monitor.kind === 'generated' ? `${monitor.description}。当前结果：${current.summary}`
        : monitor.description || current.summary;
      monitor.pendingNotifications.push({
        id: randomUUID(),
        payload: { event: 'monitor.triggered', title: `${monitor.label} · 条件已满足`, message, url: monitor.url, monitorId: monitor.id, priority: monitor.priority, severity: monitor.severity || 'warning' },
        remainingIds: [...monitor.webhookIds]
      });
      persist();
      const delivery = await flushPending(user, monitor);
      sentCount += delivery.sentCount;
      failedCount += delivery.failedCount;
    }
    monitor.snapshot = current;
    monitor.lastCheckAt = new Date().toISOString();
    monitor.lastResult = current.summary;
    addLog(user, 'monitor', 'success', `${monitor.label} · ${responseStatus ? `HTTP ${responseStatus} · ` : ''}${current.summary}`, monitor.url, Date.now() - started, monitor.id);
    const hasActiveRecipient = monitor.webhookIds.some((id) => user.settings.webhooks.some((hook) => hook.id === id && hook.enabled));
    monitor.lastError = monitor.pendingNotifications.length ? '有通知待发送，将在下次检查时重试' : hasActiveRecipient ? '' : '接收渠道均已停用，请启用至少一个渠道';
    if (!monitor.baselined) {
      monitor.baselined = true;
      addEvent(user, 'info', '监控基线已建立', `${monitor.label} · ${current.summary}`, monitor.id);
    }
    persist();
    return { checked: true, triggered, conditionSatisfied, sentCount, failedCount };
  } catch (error) {
    monitor.lastCheckAt = new Date().toISOString();
    monitor.lastError = error.message;
    addLog(user, 'monitor', 'error', `${monitor.label} · ${error.message}`, monitor.url, Date.now() - started, monitor.id, {
      requestUrl: monitor.url, httpStatus: error.responseStatus || responseStatus || null,
      networkCode: error.networkCode || null, networkCause: error.networkCause || null,
      responseBody: error.responseBody || responseSample || null, validation: error.message
    });
    addEvent(user, 'error', '检查失败', `${monitor.label} · ${error.message}`, monitor.id);
    return { checked: false, error: error.message };
  } finally {
    activeChecks.delete(monitor.id);
  }
}

function aiEndpoint(baseUrl) {
  const url = new URL(urlOf(baseUrl, 'AI API 地址'));
  if (!url.pathname.endsWith('/chat/completions')) url.pathname = `${url.pathname.replace(/\/$/, '')}/chat/completions`;
  return url.href;
}

function instructionUrl(input) {
  return input.match(/tcp:\/\/(?:\[[^\]]+\]|[a-z0-9.-]+):\d{1,5}/i)?.[0] || input.match(/https?:\/\/[^\s<>"'“”‘’，。；、（）()]+/i)?.[0] || input.match(/\blog:[a-z0-9._/-]+/i)?.[0] || '';
}

function needMoreInfo(questions) {
  const list = (Array.isArray(questions) ? questions : [questions]).map((item) => String(item || '').trim().slice(0, 180)).filter(Boolean).slice(0, 3);
  return { status: 'need_more_info', questions: list.length ? list : ['请补充要监控的目标地址，以及希望在什么情况下收到通知。'] };
}

function conversationTurns(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error('对话内容过长，请重新描述监控需求');
  return value.map((turn) => {
    const role = turn?.role;
    const content = String(turn?.content || '').trim();
    if (!['user', 'assistant'].includes(role) || !content || content.length > 2000) throw new Error('对话内容无效');
    return { role, content };
  });
}

function invalidAiRule(message) {
  const error = new Error(message);
  error.repairable = true;
  throw error;
}

function missingRuleQuestion(error, plan) {
  const detail = String(error.message || '');
  if (/来源|地址/.test(detail)) return '请告诉我从哪里查看这个目标；可以贴网址，或说明要读的本机日志文件名。';
  if (/字段|列表路径|比较值/.test(detail)) return '什么业务情况算需要提醒？可以举个例子；如果方便，也可以贴一小段接口返回的样例。';
  if (/监控文字|日志关键词/.test(detail)) return plan?.sourceType === 'log' ? '新日志里出现哪句话时提醒？直接复制那句话即可。' : '页面出现或消失哪句话时提醒？直接复制那句话即可。';
  if (/阈值/.test(detail)) return '多慢算异常？例如响应超过 3 秒。';
  return null;
}

async function parseInstructionAttempt(user, instruction, sourceUrlInput, trace, conversationInput = [], repairFeedback = '', timeZoneInput = '') {
  const input = String(instruction || '').trim();
  trace.instruction = input;
  if (!input || input.length > 2000) throw new Error('指令长度需要在 1 到 2000 字之间');
  const turns = conversationTurns(conversationInput);
  trace.conversation = JSON.stringify(turns).slice(0, 12000);
  const userTurns = [input, ...turns.filter((turn) => turn.role === 'user').map((turn) => turn.content)];
  const fullInput = userTurns.join('\n');
  const sourceInput = String(sourceUrlInput || '').trim();
  let explicitSourceUrl = '';
  try { if (sourceInput) explicitSourceUrl = sourceOf(sourceInput); } catch { /* ask for a corrected source after AI analysis */ }
  const followupUrl = turns.filter((turn) => turn.role === 'user').slice().reverse().map((turn) => instructionUrl(turn.content)).find(Boolean) || '';
  const sourceUrl = followupUrl || explicitSourceUrl || instructionUrl(input) || '';
  const fixedSourceUrl = explicitSourceUrl && !followupUrl;
  trace.sourceUrl = sourceUrl || sourceInput;
  trace.sourceMode = followupUrl ? '从补充信息提取' : fixedSourceUrl ? '单独填写' : sourceInput ? '单独填写的地址无效' : sourceUrl ? '从指令提取' : '未提供';
  if (!user.settings.aiKey) throw new Error('按需生成监控逻辑需要先在设置中填写 AI API Key');
  if (!user.settings.aiModel) throw new Error('请先填写 AI 模型名称');
  const dmit = /\bdmit\b/i.test(fullInput);
  let timeZone = String(timeZoneInput || '').slice(0, 80);
  try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch { timeZone = 'Asia/Shanghai'; }
  if (!timeZone) timeZone = 'Asia/Shanghai';
  trace.timeZone = timeZone;
  const endpoint = aiEndpoint(user.settings.aiBaseUrl || 'https://api.openai.com/v1');
  trace.model = user.settings.aiModel;
  trace.apiEndpoint = new URL(endpoint).origin + new URL(endpoint).pathname;
  const aiRequest = {
      model: user.settings.aiModel,
      messages: [
        { role: 'system', content: `你是监控与提醒助手。结合本次对话判断任务是监控还是一次性定时提醒，并生成可执行规则。仅输出 JSON，不要 Markdown。信息不足时返回 {"status":"need_more_info","questions":["只问缺失的关键信息"]}，最多 3 个简短问题。监控类信息充足时返回 {"status":"ready","url":"真实来源","label":"任务名称","intervalMinutes":5,"severity":"warning","plan":{}}。默认每 5 分钟检查，告警级别 warning；用户未要求其他频率或级别时不要为此提问。通知渠道由界面选择。监控来源不能用 auto、unknown 或臆造地址。监控类顶层字段：url,label,intervalMinutes,severity,plan。plan 必填 sourceType=json/html/rss，mode、initial=baseline/notify。json 可用 mode=compare：path,operator,expected；mode=changed：path，字段值变化时通知；mode=any：path 指向数组，filters 是 [{path,operator,expected}]，全部满足的条目数大于 0 时触发；mode=item-transition：path 指向数组、filters、idPath、statePath、fromValues、toValues。html 可用 mode=contains/absent 和 keyword。rss 可用 mode=new-item 和可选 keyword。operator 可用 equals/notEquals/contains/in/gt/gte/lt/lte；in 的 expected 必须为数组。initial=notify 表示首次检查条件满足时立即通知，baseline 表示首次只记录状态。用户说“任意有货”“只要有货”时，应使用条件匹配和 initial=notify，不得生成从无货到有货的状态变化规则。用户说“补货”且没有“任意有货”时，使用 item-transition、initial=baseline。JSON 列表条件示例：{ "sourceType":"json", "mode":"any", "initial":"notify", "path":"products", "filters":[{"path":"status","operator":"in","expected":["有货","available","in stock"]}] }。已知 DMIT 第三方库存数据地址：${DMIT_STOCK_URL}，返回 JSON {ok,products:[{provider,product_key,name,status,stale,last_check_at}]}，有货状态包括“有货”“available”“in stock”，缺货包括“无货”“缺货”“out of stock”。GitHub 公开仓库的最新 Release 数据地址为 https://api.github.com/repos/OWNER/REPO/releases/latest，tag_name 字段改变表示新版；只有用户明确给出 github.com/OWNER/REPO 时可转换为对应 API 地址。如用户给出了其他 URL，url 必须完全使用该 URL；仅在用户明确提到 DMIT 且未给 URL 时可使用上述 DMIT 地址。不得臆造来源、字段或关键词；监控缺少实际地址、字段或触发条件时应返回 need_more_info 和具体问题。一次性提醒无需这些监控字段，按后续要求生成。` },
        { role: 'system', content: '如果使用 DMIT 第三方库存来源，plan.path 必须为 products；filters 必须包括 provider equals "dmit"、stale equals 0、last_check_at withinMinutes 120。任意有货模式还必须筛选 status in ["有货","available","in stock"]；补货模式使用 item-transition，idPath=product_key、statePath=status、fromValues=["无货","缺货","out of stock"]、toValues=["有货","available","in stock"]，且不要在 filters 中筛选 status。' },
        { role: 'system', content: '来源类型除上文 json/html/rss 外，还支持 service/log。HTTP 服务或 TCP 端口的可用性使用 plan.sourceType="service"，mode="unavailable"（故障时）、"available"（恢复可用时）或 "slow"（响应时间超过 thresholdMs 毫秒）；url 使用 http(s):// 或 tcp://主机:端口。本地日志使用 plan.sourceType="log"，mode="new-line"，keyword 为新日志行要包含的文字，可选 caseSensitive；url 使用 log:相对路径，例如 log:app.log。日志默认 initial="baseline"，只检查创建后新增的行；用户明确要求现有日志也触发才用 initial="notify"。服务和日志 intervalMinutes 可为 1 到 1440，默认 5。服务不可用监控如要求连续失败 N 次才告警，使用 plan.failureThreshold=N（1 到 10），默认 1。当前只支持 HTTP 或 TCP 可用性，不支持 ICMP Ping；缺少主机端口或健康检查地址时请追问。不得输出脚本、命令或未获用户提供的文件路径。' },
        { role: 'system', content: '追问时只说用户能理解的业务问题，不要求用户填写 sourceType、metric、path、字段名、表达式等技术参数。用户给出业务条件后，优先据此推断；确实需要了解接口结构时，邀请用户粘贴一小段返回样例。认真整合最新回复，不得重复询问已经回答的问题。每轮最多问两个最关键的问题，不要机械复述原话。若最新回复是在问你为什么需要某项信息、能否实现某种方式或规则如何工作，先直接回答，再返回 {"status":"answer","message":"简短、具体的回答，可在末尾提出一个必要的业务问题"}；不要重发上一轮提问，也不要假装规则已创建。' },        { role: 'system', content: '当前时刻：' + new Date().toISOString() + '（UTC）；用户时区：' + timeZone + '。如果用户只要求在某个时间提醒，不需要监控来源。此类请求输出 {"status":"ready","kind":"reminder","label":"简短标题","message":"到时发送的具体提醒内容","remindAt":"包含时区偏移的 ISO 8601 日期时间","severity":"warning"}，不要输出 url 或 plan。必须明确未来的日期和时刻；未给时刻或日期有歧义时返回 need_more_info 追问。按用户时区解释相对日期和时间，预览由用户确认。普通监控仍按前述规则生成。不要把提醒误判成网页监控。' },
        { role: 'system', content: fixedSourceUrl ? `用户已单独填写监控来源地址：${sourceUrl}。输出的 url 必须与此地址完全一致。` : sourceInput && !followupUrl ? `用户填写的来源地址“${sourceInput}”无法识别。请根据对话中的后续地址修正；仍不明确就追问。` : '上文要求使用用户提供的 URL，指真实网址部分。如果网址后紧贴中文指令文字，辨别网址和自然语言的边界；不要把“存在”“包含”“通知”等句子当作网址路径。' },
        ...(repairFeedback ? [{ role: 'system', content: `上次生成的规则未通过校验：${repairFeedback}。请根据用户已提供的信息修正并重新输出 JSON；仅当确实缺少用户才能提供的信息时才返回 need_more_info。` }] : []),
        { role: 'user', content: input },
        ...turns
      ]
    };
  trace.aiRequest = JSON.stringify(aiRequest).slice(0, 16000);
  const text = await fetchText(endpoint, {
    method: 'POST', timeout: 20000, maxBytes: 500_000,
    headers: { authorization: `Bearer ${user.settings.aiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(aiRequest)
  });
  trace.aiResponse = text.slice(0, 12000);
  if (text.length > 12000) trace.aiResponseTruncated = true;
  let parsed;
  try {
    const result = JSON.parse(text);
    const content = String(result.choices?.[0]?.message?.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    parsed = JSON.parse(content);
  } catch { const error = new Error('AI 返回内容无法解析'); error.repairable = true; throw error; }
  if (parsed?.status === 'answer') {
    const message = String(parsed.message || '').trim().slice(0, 1200);
    if (message) return { status: 'answer', message };
    return needMoreInfo(['请再告诉我你想了解的地方。']);
  }
  if (parsed?.status === 'need_more_info') {
    const followup = needMoreInfo(parsed.questions || parsed.message);
    const lastQuestion = turns.filter((turn) => turn.role === 'assistant').at(-1)?.content || '';
    if (lastQuestion && followup.questions.every((question) => lastQuestion.includes(question))) {
      const error = new Error('AI 重复追问了用户已经回答的问题');
      error.repairable = true;
      error.question = '我可能没理解刚才的补充。可以换一种说法，举一个触发提醒的例子吗？';
      throw error;
    }
    return followup;
  }
  if (parsed?.error) {
    if (/补充|提供|缺少|不明确|不清楚/.test(String(parsed.error))) return needMoreInfo(parsed.error);
    throw new Error(String(parsed.error));
  }
  const output = parsed?.status === 'ready' && parsed.monitor ? parsed.monitor : parsed;
  if (!output || typeof output !== 'object' || Array.isArray(output)) { const error = new Error('AI 未返回有效规则'); error.repairable = true; throw error; }
  if (output.kind === 'reminder' || output.remindAt) {
    try { return { status: 'ready', monitor: validateMonitor({ ...output, kind: 'reminder' }), parser: 'ai', sourceNote: '' }; }
    catch (error) {
      if (/提醒时间|提醒什么/.test(error.message)) return needMoreInfo([error.message]);
      error.repairable = true;
      throw error;
    }
  }
  if (!sourceUrl && !dmit) return needMoreInfo(['请提供实际监控地址，例如健康检查接口、网页、tcp://主机:端口或账户日志文件 log:文件名。']);
  const expectedUrl = sourceUrl || DMIT_STOCK_URL;
  let expected;
  try { expected = sourceOf(expectedUrl); }
  catch { return needMoreInfo(['请确认监控来源的完整地址；目前提供的地址无法识别。']); }
  const allowedUrls = [expected];
  const github = sourceUrl?.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)/i);
  if (github) allowedUrls.push('https://api.github.com/repos/' + github[1] + '/' + github[2] + '/releases/latest');
  let returnedUrl = '';
  try { returnedUrl = sourceOf(output.url, output.plan?.sourceType); } catch { /* use the user-provided source below */ }
  trace.aiReturnedUrl = returnedUrl || String(output.url || '');
  let sourceNote = '';
  if (!returnedUrl) {
    output.url = expected;
    sourceNote = '已使用你提供的监控来源。';
  } else if (allowedUrls.includes(returnedUrl)) {
    output.url = returnedUrl;
  } else {
    let suffix = '';
    if (!fixedSourceUrl && sourceUrl?.startsWith('http') && expected.startsWith(returnedUrl)) {
      try { suffix = decodeURIComponent(expected.slice(returnedUrl.length)); } catch { /* retain strict source matching */ }
    }
    if (/^[\p{Script=Han}]/u.test(suffix) && /(?:存在|包含|出现|通知|这两个字|关键词|监控|检测)/.test(suffix)) {
      output.url = returnedUrl;
      sourceNote = '网址与中文指令连在一起，已识别真实来源地址；请核对下方预览。';
    } else {
      output.url = expected;
      sourceNote = 'AI 给出的地址与需求不同，已使用你提供的来源；请核对预览。';
    }
    trace.sourceInterpretation = sourceNote;
  }
  if (!fixedSourceUrl && sourceUrl?.startsWith('http') && output.url === expected) {
    let decodedPath = '';
    try { decodedPath = decodeURIComponent(new URL(expected).pathname); } catch { /* URL was already validated */ }
    if (/(?:存在|包含|出现).*(?:通知|这两个字)/.test(decodedPath)) return needMoreInfo(['请确认真实网页地址。网址后面的中文描述可能被当成了路径。']);
  }
  let candidate;
  try { candidate = validateMonitor({ ...output, kind: 'generated' }); }
  catch (error) {
    const question = missingRuleQuestion(error, output.plan);
    error.repairable = true;
    error.question = question;
    throw error;
  }
  if (dmit && !sourceUrl) {
    const filters = candidate.plan.filters || [];
    const has = (field, operator, value) => filters.some((filter) => filter.path === field && filter.operator === operator && (value === undefined || String(filter.expected) === String(value)));
    if (candidate.plan.sourceType !== 'json' || candidate.plan.path !== 'products' || !has('provider', 'equals', 'dmit') || !has('stale', 'equals', 0) || !filters.some((filter) => filter.path === 'last_check_at' && filter.operator === 'withinMinutes' && Number(filter.expected) <= 120)) invalidAiRule('AI 未正确生成 DMIT 来源和时效筛选，请重新生成');
    if (candidate.plan.mode === 'any' && !filters.some((filter) => filter.path === 'status' && filter.operator === 'in' && filter.expected.some((value) => ['有货', 'available', 'in stock'].includes(String(value).toLowerCase())))) invalidAiRule('AI 未正确生成有货状态筛选，请重新生成');
    if (candidate.plan.mode === 'item-transition' && (candidate.plan.idPath !== 'product_key' || candidate.plan.statePath !== 'status')) invalidAiRule('AI 未正确生成补货状态字段，请重新生成');
  }
  const triggerIntent = userTurns.slice().reverse().find((turn) => /任意有货|只要有货|当前有货|有货就通知|补货|恢复供货|重新有货/.test(turn)) || fullInput;
  const anyAvailable = /任意有货|只要有货|当前有货|有货就通知/.test(triggerIntent);
  if (dmit && !sourceUrl && anyAvailable && (candidate.plan.mode !== 'any' || candidate.plan.initial !== 'notify')) invalidAiRule('AI 没有按“任意有货”生成规则，请调整指令后重试');
  if (dmit && !sourceUrl && !anyAvailable && /补货|恢复供货|重新有货/.test(triggerIntent) && (candidate.plan.mode !== 'item-transition' || candidate.plan.initial !== 'baseline')) invalidAiRule('AI 没有按“补货变化”生成规则，请调整指令后重试');
  trace.validatedUrl = candidate.url;
  return { status: 'ready', monitor: candidate, parser: 'ai', sourceNote };
}

async function parseInstruction(user, instruction, sourceUrlInput, trace, conversationInput = [], timeZone = '') {
  try { return await parseInstructionAttempt(user, instruction, sourceUrlInput, trace, conversationInput, '', timeZone); }
  catch (error) {
    if (!error.repairable) throw error;
    trace.firstModelError = error.message;
    trace.firstModelResponse = trace.aiResponse || '';
    try { return await parseInstructionAttempt(user, instruction, sourceUrlInput, trace, conversationInput, error.message, timeZone); }
    catch (retryError) {
      if (retryError.question) return needMoreInfo([retryError.question]);
      throw retryError;
    }
  }
}

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 40_000) throw new Error('请求内容过大');
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('JSON 格式错误'); }
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const loginAttempts = new Map();
function loginGuard(request) {
  const key = request.socket.remoteAddress || 'unknown';
  const recent = (loginAttempts.get(key) || []).filter((at) => Date.now() - at < 15 * 60_000);
  if (recent.length >= 20) throw new Error('登录尝试过多，请稍后再试');
  recent.push(Date.now()); loginAttempts.set(key, recent);
}
setInterval(() => {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [address, attempts] of loginAttempts) {
    const recent = attempts.filter((at) => at > cutoff);
    if (recent.length) loginAttempts.set(address, recent);
    else loginAttempts.delete(address);
  }
}, 15 * 60_000).unref();

async function handler(request, response) {
  try {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (pathname.startsWith('/api/')) {
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host) return sendJson(response, 403, { error: '跨站请求被拒绝' });
      if (request.method === 'POST' && pathname === '/api/auth/register') {
        loginGuard(request);
        const body = await readJson(request);
        const { user, recoveryCode } = store.register(body.username, body.password, body.inviteCode, body.email, body.emailCode);
        return sendJson(response, 201, { ...publicState(user), recoveryCode }, { 'set-cookie': store.issueCookie(user) });
      }
      if (request.method === 'POST' && pathname === '/api/auth/email-code') {
        loginGuard(request);
        const body = await readJson(request);
        if (body.purpose === 'register') {
          await store.requestRegistrationEmailCode(body.username, body.inviteCode, body.email);
          return sendJson(response, 200, { sent: true, expiresInSeconds: 600, retryAfterSeconds: 60 });
        }
        if (body.purpose === 'bind') {
          const account = store.userFromRequest(request);
          if (!account) return sendJson(response, 401, { error: '请先登录' });
          await store.requestBindEmailCode(account, body.password, body.email);
          return sendJson(response, 200, { sent: true, expiresInSeconds: 600, retryAfterSeconds: 60 });
        }
        throw new Error('不支持的验证码用途');
      }
      if (request.method === 'POST' && pathname === '/api/auth/login') {
        loginGuard(request);
        const body = await readJson(request);
        const user = store.verifyLogin(body.username, body.password);
        if (!user) return sendJson(response, 401, { error: '用户名或密码错误' });
        return sendJson(response, 200, publicState(user), { 'set-cookie': store.issueCookie(user) });
      }
      if (request.method === 'POST' && pathname === '/api/auth/recover') {
        loginGuard(request);
        const body = await readJson(request);
        const recovered = store.recoverPassword(body.username, body.recoveryCode, body.newPassword);
        if (!recovered) return sendJson(response, 401, { error: '用户名或恢复码不正确' });
        return sendJson(response, 200, { ...publicState(recovered.user), recoveryCode: recovered.recoveryCode }, { 'set-cookie': store.issueCookie(recovered.user) });
      }
      const user = store.userFromRequest(request);
      if (request.method === 'GET' && pathname === '/api/auth/status') return sendJson(response, 200, { authenticated: Boolean(user), user: user ? { id: user.id, username: user.username, email: user.email || '' } : null, emailVerificationEnabled: emailCodes.enabled, signupCodeRequired: Boolean(process.env.SIGNUP_CODE) });
      if (!user) return sendJson(response, 401, { error: '请先登录' });
      if (request.method === 'POST' && pathname === '/api/auth/logout') return sendJson(response, 200, { ok: true }, { 'set-cookie': store.clearCookie() });
      if (request.method === 'POST' && pathname === '/api/auth/change-password') {
        const body = await readJson(request);
        store.changePassword(user, body.currentPassword, body.newPassword);
        return sendJson(response, 200, { ok: true }, { 'set-cookie': store.issueCookie(user) });
      }
      if (request.method === 'PUT' && pathname === '/api/auth/profile') {
        const body = await readJson(request);
        store.updateEmail(user, body.password, body.email, body.emailCode);
        return sendJson(response, 200, publicState(user));
      }
      if (request.method === 'POST' && pathname === '/api/auth/recovery-code/rotate') {
        const body = await readJson(request);
        const recoveryCode = store.rotateRecoveryCode(user, body.password);
        return sendJson(response, 200, { recoveryCode });
      }
      if (request.method === 'GET' && pathname === '/api/state') return sendJson(response, 200, publicState(user));
      if (request.method === 'GET' && pathname === '/api/logs') return sendJson(response, 200, { logs: user.logs.slice(0, 300) });
      if (request.method === 'DELETE' && pathname === '/api/ai/key') {
        user.settings.aiKey = '';
        persist();
        return sendJson(response, 200, publicState(user));
      }
      if (request.method === 'POST' && pathname === '/api/ai/test') {
        const body = await readJson(request);
        const baseUrl = body.aiBaseUrl ? urlOf(body.aiBaseUrl, 'AI API 地址') : user.settings.aiBaseUrl;
        const model = String(body.aiModel || user.settings.aiModel || '').trim();
        const key = String(body.aiKey || user.settings.aiKey || '').trim();
        if (!model) throw new Error('请先填写模型名称');
        if (model.length > 100) throw new Error('模型名称不能超过 100 个字符');
        if (!key) throw new Error('请先填写 API Key');
        if (key.length > 500) throw new Error('API Key 过长');
        const endpoint = aiEndpoint(baseUrl || 'https://api.openai.com/v1');
        const started = Date.now();
        try {
          const raw = await fetchText(endpoint, { method: 'POST', timeout: 20000, maxBytes: 100_000,
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model, messages: [{ role: 'user', content: '回复 OK' }] }) });
          let result;
          try { result = JSON.parse(raw); } catch { throw new Error('API 返回的不是 JSON'); }
          if (!Array.isArray(result.choices) || !result.choices[0]?.message) throw new Error('API 响应缺少 Chat Completions 结果');
          addLog(user, 'ai-test', 'success', `AI 连接成功 · ${model}`, new URL(endpoint).origin, Date.now() - started);
          return sendJson(response, 200, { ok: true, model, durationMs: Date.now() - started });
        } catch (error) {
          const safeError = new Error(String(error.message).replaceAll(key, '[已隐藏的 API Key]'));
          addLog(user, 'ai-test', 'error', safeError.message, new URL(endpoint).origin, Date.now() - started);
          throw safeError;
        }
      }
      if (request.method === 'PUT' && pathname === '/api/settings') {
        const body = await readJson(request);
        const webhooks = validateWebhooks(body.webhooks ?? user.settings.webhooks);
        const aiBaseUrl = body.aiBaseUrl ? urlOf(body.aiBaseUrl, 'AI API 地址') : 'https://api.openai.com/v1';
        const aiModel = String(body.aiModel || '').trim().slice(0, 100);
        const aiKey = body.aiKey ? String(body.aiKey).trim().slice(0, 500) : user.settings.aiKey;
        user.settings = { webhooks, aiBaseUrl, aiModel, aiKey };
        const keptIds = new Set(webhooks.map((hook) => hook.id));
        for (const monitor of user.monitors) {
          monitor.webhookIds = monitor.webhookIds.filter((id) => keptIds.has(id));
          for (const pending of monitor.pendingNotifications) pending.remainingIds = pending.remainingIds.filter((id) => keptIds.has(id));
          monitor.pendingNotifications = monitor.pendingNotifications.filter((pending) => pending.remainingIds.length);
          if (!monitor.webhookIds.length) {
            monitor.enabled = false;
            monitor.lastError = '没有接收渠道，请重新选择 Webhook';
          } else if (!monitor.webhookIds.some((id) => webhooks.some((hook) => hook.id === id && hook.enabled))) {
            monitor.lastError = '接收渠道均已停用，请启用至少一个渠道';
          } else if (/^(没有接收渠道|接收渠道均已停用)/.test(monitor.lastError || '')) {
            monitor.lastError = '';
          }
        }
        persist();
        return sendJson(response, 200, publicState(user));
      }
      if (request.method === 'POST' && pathname === '/api/parse') {
        const body = await readJson(request);
        const started = Date.now();
        const trace = {};
        const safeTrace = () => Object.fromEntries(Object.entries(trace).map(([name, value]) => [name, typeof value === 'string' && user.settings.aiKey ? value.replaceAll(user.settings.aiKey, '[已隐藏的 API Key]') : value]));
        try {
          const parsed = await parseInstruction(user, body.instruction, body.sourceUrl, trace, body.conversation, body.timeZone);
          if (parsed.status === 'answer') {
            trace.validation = '已回答用户问题';
            addLog(user, 'parse', 'success', 'AI 已回答本轮问题，等待用户继续', null, Date.now() - started, null, safeTrace());
            return sendJson(response, 200, parsed);
          }
          if (parsed.status === 'need_more_info') {
            trace.validation = '需要补充信息';
            addLog(user, 'parse', 'success', `AI 需要补充信息：${parsed.questions.join('；')}`, null, Date.now() - started, null, safeTrace());
            return sendJson(response, 200, parsed);
          }
          trace.validation = '通过';
          addLog(user, 'parse', 'success', `AI 解析生成 ${parsed.monitor.kind} 规则`, null, Date.now() - started, null, safeTrace());
          return sendJson(response, 200, parsed);
        } catch (error) {
          if (error.responseStatus) trace.httpStatus = error.responseStatus;
          if (error.responseBody) trace.aiResponse = error.responseBody;
          if (error.networkCode) trace.networkCode = error.networkCode;
          if (error.networkCause) trace.networkCause = error.networkCause;
          const safeError = new Error(user.settings.aiKey ? String(error.message).replaceAll(user.settings.aiKey, '[已隐藏的 API Key]') : String(error.message));
          trace.validation = safeError.message;
          addLog(user, 'parse', 'error', safeError.message, null, Date.now() - started, null, safeTrace());
          throw safeError;
        }
      }
      if (request.method === 'POST' && pathname === '/api/preview-check') {
        const spec = validateMonitor(await readJson(request));
        const started = Date.now();
        let status;
        let responseSample = '';
        try {
          let result;
          if (spec.kind === 'generated' && spec.plan.sourceType === 'service') {
            result = await inspectService(spec.url, spec.plan);
            status = result.httpStatus;
          } else if (spec.kind === 'generated' && spec.plan.sourceType === 'log') result = inspectLog(logRoot, user, spec, null, true);
          else {
            const expectsJson = ['dmit', 'json', 'github'].includes(spec.kind) || spec.kind === 'generated' && spec.plan.sourceType === 'json';
            const body = await fetchText(spec.url, { headers: { 'user-agent': 'WebhookRadar/2.0', accept: expectsJson ? 'application/json' : '*/*' }, onResponse: (code) => { status = code; } });
            responseSample = body.slice(0, 4000);
            result = spec.kind === 'generated' ? inspectGenerated(spec.plan, body) : inspectPage(spec, body);
          }
          addLog(user, 'preview', 'success', `来源测试 · ${status ? `HTTP ${status} · ` : ''}${result.summary}`, spec.url, Date.now() - started);
          return sendJson(response, 200, { status: status || null, healthy: result.healthy, summary: result.summary });
        } catch (error) {
          addLog(user, 'preview', 'error', `来源测试 · ${error.message}`, spec.url, Date.now() - started, null, {
            requestUrl: spec.url, httpStatus: error.responseStatus || status || null,
            networkCode: error.networkCode || null, networkCause: error.networkCause || null,
            responseBody: error.responseBody || responseSample || null, validation: error.message
          });
          throw error;
        }
      }
      if (request.method === 'POST' && pathname === '/api/send') {
        const body = await readJson(request);
        const title = String(body.title || '').trim().slice(0, 120);
        const message = String(body.message || '').trim().slice(0, 2000);
        if (!title || !message) throw new Error('请填写通知标题和内容');
        const priority = body.priority == null || body.priority === '' ? null : Number(body.priority);
        if (priority != null && (!Number.isInteger(priority) || priority < 1 || priority > 5)) throw new Error('ntfy 优先级必须在 1 到 5 之间');
        const report = await deliver(user, { event: 'manual', title, message, priority }, selectedWebhookIds(user, body.webhookIds));
        if (report.sent.length) addEvent(user, 'success', '手动通知已发送', `${title} → ${report.sent.map((hook) => hook.name).join('、')}`);
        if (report.failed.length) addEvent(user, 'error', '部分渠道发送失败', report.failed.map((hook) => `${hook.name}：${hook.error}`).join('；'));
        return sendJson(response, 200, report);
      }
      if (request.method === 'POST' && pathname === '/api/test-webhook') {
        const body = await readJson(request);
        const ids = body.webhookId ? [String(body.webhookId)] : selectedWebhookIds(user);
        if (ids.some((id) => !user.settings.webhooks.some((hook) => hook.id === id))) throw new Error('测试渠道不存在，请先保存设置');
        const report = await deliver(user, { event: 'test', title: 'Webhook Radar 测试通知', message: '连接成功，之后的监控提醒将发送到这里。' }, ids, { includeDisabled: true });
        if (report.sent.length) addEvent(user, 'success', '测试通知已发送', report.sent.map((hook) => hook.name).join('、'));
        if (report.failed.length) addEvent(user, 'error', '渠道测试失败', report.failed.map((hook) => `${hook.name}：${hook.error}`).join('；'));
        return sendJson(response, 200, report);
      }
      if (request.method === 'POST' && pathname === '/api/monitors') {
        const body = await readJson(request);
        const spec = validateMonitor(body);
        const webhookIds = selectedWebhookIds(user, body.webhookIds);
        if (user.monitors.length >= 100) throw new Error('每个账户最多创建 100 个监控任务');
        const priority = body.priority == null || body.priority === '' ? null : Number(body.priority);
        if (priority != null && (!Number.isInteger(priority) || priority < 1 || priority > 5)) throw new Error('ntfy 优先级必须在 1 到 5 之间');
        const monitor = { ...spec, priority, webhookIds, pendingNotifications: [], id: randomUUID(), enabled: true, createdAt: new Date().toISOString(), baselined: false, snapshot: null, lastCheckAt: null, lastResult: '', lastError: '' };
        user.monitors.unshift(monitor);
        persist();
        if (monitor.kind !== 'reminder') await checkMonitor(user, monitor);
        return sendJson(response, 201, { status: 'created', ...publicState(user) });
      }
      const match = pathname.match(/^\/api\/monitors\/([^/]+)(?:\/(check))?$/);
      if (match) {
        const monitor = user.monitors.find((item) => item.id === match[1]);
        if (!monitor) return sendJson(response, 404, { error: '监控任务不存在' });
        if (request.method === 'POST' && match[2] === 'check') {
          const outcome = await checkMonitor(user, monitor, { manual: true });
          return sendJson(response, 200, { ...publicState(user), check: { ...outcome, pendingCount: monitor.pendingNotifications.length } });
        }
        if (request.method === 'PATCH' && !match[2]) {
          const body = await readJson(request);
          let resetBaseline = false;
          if (body.rule) {
            const unchangedReminderTime = monitor.kind === 'reminder' && Date.parse(body.rule.remindAt || monitor.remindAt) === Date.parse(monitor.remindAt);
            const next = validateMonitor({ ...monitor, ...body.rule, kind: monitor.kind }, { allowPastReminder: unchangedReminderTime });
            if (body.rule.priority !== undefined) {
              next.priority = body.rule.priority === '' || body.rule.priority == null ? null : Number(body.rule.priority);
              if (next.priority != null && (!Number.isInteger(next.priority) || next.priority < 1 || next.priority > 5)) throw new Error('ntfy 优先级必须在 1 到 5 之间');
            }
            if (monitor.kind === 'reminder' && next.remindAt !== monitor.remindAt) {
              monitor.firedAt = null;
              monitor.completedAt = null;
              monitor.pendingNotifications = [];
              monitor.lastCheckAt = null;
              monitor.lastError = '';
              monitor.lastResult = '';
              monitor.enabled = true;
            }
            resetBaseline = monitor.kind !== 'reminder' && (['url', 'keyword', 'mode', 'triggerMode', 'jsonPath', 'operator', 'expected'].some((key) => next[key] !== monitor[key]) || JSON.stringify(next.plan) !== JSON.stringify(monitor.plan));
            Object.assign(monitor, next);
            if (resetBaseline) {
              monitor.snapshot = null;
              monitor.baselined = false;
              monitor.lastCheckAt = null;
              monitor.lastResult = '';
              monitor.pendingNotifications = [];
              monitor.lastError = '';
            }
          }
          if (body.webhookIds !== undefined) {
            monitor.webhookIds = selectedWebhookIds(user, body.webhookIds);
            const selected = new Set(monitor.webhookIds);
            for (const pending of monitor.pendingNotifications) pending.remainingIds = pending.remainingIds.filter((id) => selected.has(id));
            monitor.pendingNotifications = monitor.pendingNotifications.filter((pending) => pending.remainingIds.length);
          }
          if (body.enabled !== undefined) {
            if (body.enabled && monitor.kind === 'reminder' && monitor.completedAt) throw new Error('已完成的提醒请先设置新的时间');
            if (body.enabled) selectedWebhookIds(user, monitor.webhookIds);
            monitor.enabled = Boolean(body.enabled);
          }
          if (/^(没有接收渠道|接收渠道均已停用)/.test(monitor.lastError || '')) monitor.lastError = '';
          persist();
          if (resetBaseline && monitor.enabled) await checkMonitor(user, monitor);
          return sendJson(response, 200, publicState(user));
        }
        if (request.method === 'DELETE' && !match[2]) {
          user.monitors = user.monitors.filter((item) => item.id !== monitor.id);
          persist();
          return sendJson(response, 200, publicState(user));
        }
      }
      return sendJson(response, 404, { error: '接口不存在' });
    }
    if (request.method !== 'GET') return sendJson(response, 405, { error: '不支持的请求方法' });
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!['index.html', 'app.js', 'style.css', 'extra.css', 'spatial.css', 'premium.css'].includes(filename)) return sendJson(response, 404, { error: '页面不存在' });
    const file = path.join(root, 'public', filename);
    response.writeHead(200, { 'content-type': contentTypes[path.extname(file)], 'content-security-policy': "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'" });
    fs.createReadStream(file).pipe(response);
  } catch (error) {
    sendJson(response, 400, { error: error.message || '请求失败' });
  }
}

const server = http.createServer(handler);
server.listen(port, host, () => console.log(`Webhook Radar: http://${host}:${port}`));
const maxScheduledChecks = 16;
setInterval(() => {
  const now = Date.now();
  for (const user of store.state.users) for (const monitor of user.monitors) {
    if (activeChecks.size >= maxScheduledChecks) return;
    const lastCheck = Date.parse(monitor.lastCheckAt);
    if (monitor.kind !== 'reminder' && monitor.enabled && (!Number.isFinite(lastCheck) || now - lastCheck >= monitor.intervalMinutes * 60_000)) checkMonitor(user, monitor);
  }
}, 20_000).unref();

setInterval(() => {
  const now = Date.now();
  for (const user of store.state.users) for (const reminder of user.monitors) {
    if (activeChecks.size >= maxScheduledChecks) return;
    if (reminder.kind !== 'reminder' || !reminder.enabled || reminder.completedAt) continue;
    const lastCheck = Date.parse(reminder.lastCheckAt);
    if (Date.parse(reminder.remindAt) <= now && (!Number.isFinite(lastCheck) || now - lastCheck >= 60_000)) checkReminder(user, reminder);
  }
}, 1000).unref();
