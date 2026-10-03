import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DMIT_PRICING_URL, DMIT_STOCK_URL, inspectPage, isTransition } from './lib/monitor.js';
import { validateGeneratedPlan, inspectGenerated, transitionGenerated, describeGeneratedPlan } from './lib/generated.js';
import { validateLocalSource, inspectLog, inspectService, userLogDirectory } from './lib/sources.js';
import { WEBHOOK_FORMATS, createWebhookPayload, assertWebhookAccepted } from './lib/webhook.js';
import { validateNotification, renderNotification, notificationSample } from './lib/notification.js';
import { assistantMessages } from './lib/assistant.js';
import { createStore } from './lib/store.js';
import { createEmailCodeService } from './lib/email.js';
import { createSourceFetcher, validateFetchOptions } from './lib/source-fetch.js';
import { createBrowserSource } from './lib/browser-source.js';
import { validateSourceProxy, proxyEndpoint, redactProxy } from './lib/source-proxy.js';
import { createShadowsocksBridge } from './lib/shadowsocks.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, '.data');
const logRoot = process.env.MONITOR_LOG_ROOT ? path.resolve(process.env.MONITOR_LOG_ROOT) : path.join(dataDir, 'monitor-logs');
const emailCodes = createEmailCodeService({ apiKey: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM, endpoint: process.env.RESEND_API_URL || undefined });
const store = createStore(dataDir, emailCodes);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const activeChecks = new Set();
const sourceCheckCache = new Map();
const notificationPreviews = new Map();
const readSource = createSourceFetcher({ browserFetch: createBrowserSource({ dataDir }), browserEnabled: process.env.MONITOR_BROWSER_ENABLED !== '0' });
const withSourceProxy = createShadowsocksBridge({ dataDir });
function redactData(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => redactData(item, redact));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactData(item, redact)]));
  return value;
}
async function fetchSource(url, options = {}) {
  return withSourceProxy(options.proxyUrl, async (proxyUrl, proxyIdentity) => {
    try {
      const result = await readSource(url, { ...options, proxyUrl, proxyIdentity });
      if (proxyIdentity) result.metadata.proxyType = 'shadowsocks';
      return result;
    } catch (error) {
      if (proxyIdentity) {
        error.message = redactProxy(error.message, options.proxyUrl);
        error.fetchDetails = redactData({ ...error.fetchDetails, proxyType: 'shadowsocks' }, text => redactProxy(text, options.proxyUrl));
      }
      throw error;
    }
  });
}
function sourceOptions(user, monitor = {}) {
  const options = validateFetchOptions(monitor.fetch);
  return { userId: user.id, mode: options.mode, direct: options.proxy === 'direct', proxyUrl: options.proxy === 'direct' ? '' : user.settings.sourceProxy || '' };
}
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
  const notification = validateNotification(candidate?.notification);
  if (!candidate || !['dmit', 'dmit-product', 'webpage', 'json', 'rss', 'github', 'generated', 'reminder'].includes(candidate.kind)) throw new Error('无法识别监控类型');
  const fetchOptions = validateFetchOptions(candidate.fetch);
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
    const repeatMinutes = candidate.repeatMinutes == null || candidate.repeatMinutes === '' ? 0 : Number(candidate.repeatMinutes);
    if (!Number.isInteger(repeatMinutes) || repeatMinutes < 0 || repeatMinutes > 525600) throw new Error('重复间隔需为 1 到 525600 分钟，或选择仅提醒一次');
    return { notification, kind: 'reminder', label, description: message.slice(0, 180), message, remindAt: new Date(timestamp).toISOString(), repeatMinutes, severity };
  }
  if (candidate.kind === 'dmit') return { notification, fetch: fetchOptions, kind: 'dmit', url: DMIT_STOCK_URL, label, description, intervalMinutes, triggerMode: candidate.triggerMode === 'any-available' ? 'any-available' : 'restock' };
  if (candidate.kind === 'generated') {
    const plan = validateGeneratedPlan(candidate.plan);
    const url = options.allowMissingSource && !candidate.url ? '' : sourceOf(candidate.url, plan.sourceType);
    if (url && (plan.sourceType === 'log' && !url.startsWith('log:') || plan.sourceType === 'service' && !url.startsWith('tcp://') && !/^https?:\/\//.test(url) || !['log', 'service'].includes(plan.sourceType) && !/^https?:\/\//.test(url))) throw new Error('来源与监控规则类型不匹配');
    return { notification, fetch: fetchOptions, kind: 'generated', url, label, description: describeGeneratedPlan(plan), intervalMinutes, severity, plan };
  }
  const url = urlOf(candidate.url, '监控地址');
  if (candidate.kind === 'dmit-product') {
    const parsed = new URL(url);
    if (!/(^|\.)dmit\.io$/i.test(parsed.hostname) || !/^\/(cart|aff)\.php$/i.test(parsed.pathname)) throw new Error('DMIT 套餐监控需要官方购买链接');
    return { notification, fetch: fetchOptions, kind: 'dmit-product', url, label, description, intervalMinutes };
  }
  if (candidate.kind === 'github') {
    if (!/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(url)) throw new Error('GitHub Release 地址无效');
    return { notification, fetch: fetchOptions, kind: 'github', url, label, description, intervalMinutes };
  }
  if (candidate.kind === 'rss') return { notification, fetch: fetchOptions, kind: 'rss', url, label, description, intervalMinutes, keyword: String(candidate.keyword || '').trim().slice(0, 80) };
  if (candidate.kind === 'json') {
    const jsonPath = String(candidate.jsonPath || '').trim();
    if (!/^[\w-]+(?:\.[\w-]+)*$/.test(jsonPath) || jsonPath.length > 120) throw new Error('JSON 字段路径无效，请使用 a.b.c 格式');
    const operator = String(candidate.operator || 'equals');
    if (!['equals', 'notEquals', 'contains', 'gt', 'gte', 'lt', 'lte'].includes(operator)) throw new Error('JSON 比较方式无效');
    const expected = String(candidate.expected ?? '').trim();
    if (!expected || expected.length > 120) throw new Error('请填写 JSON 比较值');
    return { notification, fetch: fetchOptions, kind: 'json', url, label, description, intervalMinutes, jsonPath, operator, expected };
  }
  const keyword = String(candidate.keyword || '').trim();
  if (keyword.length < 2 || keyword.length > 80) throw new Error('监控文字长度需要在 2 到 80 字之间');
  return { notification, fetch: fetchOptions, kind: 'webpage', url, label, description, intervalMinutes, keyword, mode: candidate.mode === 'absent' ? 'absent' : 'contains' };
}

function previewSourceSignature(monitor) {
  return JSON.stringify([monitor.kind, monitor.url, monitor.plan, monitor.keyword, monitor.mode, monitor.jsonPath, monitor.operator, monitor.expected, monitor.triggerMode, validateFetchOptions(monitor.fetch)]);
}

function buildNotificationPreview(user, monitor, observed = null) {
  const now = Date.now();
  for (const [id, entry] of notificationPreviews) if (entry.expiresAt <= now) notificationPreviews.delete(id);
  const own = [...notificationPreviews].filter(([, entry]) => entry.userId === user.id);
  while (own.length >= 20) notificationPreviews.delete(own.shift()[0]);
  while (notificationPreviews.size >= 200) notificationPreviews.delete(notificationPreviews.keys().next().value);
  const sample = notificationSample(monitor, observed);
  const payload = renderNotification(monitor, sample.current);
  const simulation = { ...payload, event: 'monitor.simulation', title: '【模拟】' + payload.title };
  const requestedIds = monitor.webhookIds ?? user.settings.webhooks.filter((hook) => hook.enabled).map((hook) => hook.id);
  if (!Array.isArray(requestedIds)) throw new Error('通知渠道格式无效');
  const hooks = user.settings.webhooks.filter((hook) => hook.enabled && requestedIds.includes(hook.id));
  const channels = hooks.map((hook) => {
    try {
      const actual = createWebhookPayload(hook, payload);
      const simulated = createWebhookPayload(hook, simulation);
      return { id: hook.id, name: hook.name, format: actual.format, body: actual.body, headers: actual.headers || {}, simulationBody: simulated.body };
    } catch (error) { return { id: hook.id, name: hook.name, error: error.message }; }
  });
  const id = randomUUID();
  const expiresAt = now + 10 * 60_000;
  notificationPreviews.set(id, {
    userId: user.id, monitorId: monitor.id || null, payload: simulation, observed,
    sourceSignature: previewSourceSignature(monitor), expiresAt,
    hooks: hooks.map((hook) => ({ id: hook.id, signature: JSON.stringify(hook) }))
  });
  return { id, expiresAt: new Date(expiresAt).toISOString(), payload, basis: sample.basis, note: sample.note,
    simulationTitle: simulation.title, channels, canSend: hooks.length > 0 && channels.every((channel) => !channel.error) };
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
  let body;
  try { body = await readLimited(response, options.maxBytes || 2_000_000); }
  catch (error) {
    error.responseStatus = response.status;
    error.networkCode = error.cause?.code || error.name;
    error.networkCause = error.cause?.message || error.message;
    throw error;
  }
  options.onBody?.(body);
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
      addLog(user, 'webhook', 'success', `${hook.name} · HTTP ${status}`, hook.url, Date.now() - started, payload.monitorId, { notification: JSON.stringify(payload), format: formatted.format });
    } catch (error) {
      addLog(user, 'webhook', 'error', `${hook.name} · ${error.message}`, hook.url, Date.now() - started, payload.monitorId, { notification: JSON.stringify(payload), format: formatted.format, httpStatus: status || error.responseStatus || null, responseBody: error.responseBody || null });
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

function nextRecurringTime(dueAt, repeatMinutes, now = Date.now()) {
  const interval = repeatMinutes * 60_000;
  const due = Date.parse(dueAt);
  return new Date(due + Math.max(1, Math.floor((now - due) / interval) + 1) * interval).toISOString();
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
        payload: renderNotification(reminder),
        remainingIds: [...reminder.webhookIds]
      });
      persist();
    }
    const report = await flushPending(user, reminder);
    reminder.lastCheckAt = new Date().toISOString();
    if (!reminder.pendingNotifications.length) {
      reminder.lastSentAt = reminder.lastCheckAt;
      if (reminder.repeatMinutes) {
        reminder.remindAt = nextRecurringTime(reminder.remindAt, reminder.repeatMinutes);
        reminder.firedAt = null;
        reminder.completedAt = null;
        reminder.lastResult = '提醒已发送；下次 ' + reminder.remindAt;
      } else {
        reminder.completedAt = reminder.lastCheckAt;
        reminder.lastResult = '提醒已发送';
      }
      reminder.lastError = '';
      addLog(user, 'reminder', 'success', reminder.label + ' · 已发送' + (reminder.repeatMinutes ? '；下次 ' + reminder.remindAt : ''), null, 0, reminder.id);
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
  if (!manual && Date.parse(monitor.sourceRetryAt) > Date.now()) return { checked: false, skipped: true, retryAt: monitor.sourceRetryAt };
  if (activeChecks.has(monitor.id)) return { checked: false, skipped: true };
  activeChecks.add(monitor.id);
  const started = Date.now();
  const hadPending = Boolean(monitor.pendingNotifications.length);
  let sentCount = 0;
  let failedCount = 0;
  let responseStatus;
  let responseSample = '';
  let fetchDetails;
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
      const source = await fetchSource(monitor.url, { ...sourceOptions(user, monitor), expectsJson });
      const html = source.body;
      responseStatus = source.status;
      fetchDetails = source.metadata;
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
      monitor.pendingNotifications.push({
        id: randomUUID(),
        payload: renderNotification(monitor, current, monitor.snapshot),
        remainingIds: [...monitor.webhookIds]
      });
      persist();
      const delivery = await flushPending(user, monitor);
      sentCount += delivery.sentCount;
      failedCount += delivery.failedCount;
    }
    monitor.sourceFailures = 0;
    monitor.sourceRetryAt = null;
    monitor.lastSourceError = '';
    if (fetchDetails) monitor.lastFetch = { method: fetchDetails.method, route: fetchDetails.route, at: new Date().toISOString() };
    monitor.snapshot = current;
    monitor.lastCheckAt = new Date().toISOString();
    monitor.lastResult = current.summary;
    addLog(user, 'monitor', 'success', `${monitor.label} · ${responseStatus ? `HTTP ${responseStatus} · ` : ''}${current.summary}`, monitor.url, Date.now() - started, monitor.id, fetchDetails ? { fetch: fetchDetails } : null);
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
    if (error.code?.startsWith('SOURCE_')) {
      monitor.sourceFailures = Math.min(20, (monitor.sourceFailures || 0) + 1);
      monitor.lastSourceError = error.code;
      const delay = error.code === 'SOURCE_CHALLENGE' ? Math.min(15 * 60_000, 60_000 * 2 ** (monitor.sourceFailures - 1)) : Math.max(monitor.intervalMinutes * 60_000, error.fetchDetails?.retryAfterMs || 0);
      monitor.sourceRetryAt = new Date(Date.now() + delay).toISOString();
    }
    addLog(user, 'monitor', 'error', `${monitor.label} · ${error.message}`, monitor.url, Date.now() - started, monitor.id, {
      errorCode: error.code || null, fetch: error.fetchDetails || fetchDetails || null, retryAt: monitor.sourceRetryAt || null,
      requestUrl: monitor.url, httpStatus: error.responseStatus || responseStatus || null,
      networkCode: error.networkCode || null, networkCause: error.networkCause || null,
      responseBody: error.responseBody || responseSample || null, validation: error.message
    });
    addEvent(user, 'error', '检查失败', `${monitor.label} · ${error.message}`, monitor.id);
    return { checked: false, error: error.message, errorCode: error.code || null, retryAt: monitor.sourceRetryAt || null };
  } finally {
    activeChecks.delete(monitor.id);
  }
}

function aiEndpoint(baseUrl) {
  const url = new URL(urlOf(baseUrl, 'AI API 地址'));
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.href;
}

function instructionUrl(input) {
  return input.match(/tcp:\/\/(?:\[[^\]]+\]|[a-z0-9.-]+):\d{1,5}/i)?.[0] || input.match(/https?:\/\/[^\s<>"'“”‘’，。；、（）()]+/i)?.[0] || input.match(/\blog:[a-z0-9._/-]+/i)?.[0] || '';
}

function needMoreInfo(questions) {
  const list = (Array.isArray(questions) ? questions : [questions]).map((item) => String(item || '').trim().slice(0, 180)).filter(Boolean).slice(0, 1);
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

function draftPresentation(parsed) {
  return {
    message: String(parsed.explanation || (parsed.kind === 'reminder' || parsed.remindAt ? '' : parsed.message) || '').trim().slice(0, 1200),
    assumptions: (Array.isArray(parsed.assumptions) ? parsed.assumptions : [])
      .map((item) => String(item || '').trim().slice(0, 180)).filter(Boolean).slice(0, 4)
  };
}

async function checkSourceConnection(user, source) {
  if (!source) return '';
  const cacheKey = user.id + ':' + source + ':' + (user.settings.sourceProxy ? 'proxy' : 'server');
  const cached = sourceCheckCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 30_000) return cached.summary;
  let summary;
  try {
    const normalized = sourceOf(source);
    if (normalized.startsWith('log:')) {
      inspectLog(logRoot, user, { url: normalized, plan: { keyword: '', initial: 'baseline' } }, null, true);
      summary = '已尝试读取：账户日志文件可访问。文件内容未发送给 AI。';
    } else if (normalized.startsWith('tcp://')) {
      const result = await inspectService(normalized, { mode: 'unavailable' });
      summary = '已尝试连接：' + result.summary;
    } else {
      const result = await fetchSource(normalized, sourceOptions(user));
      const type = (result.headers['content-type'] || '类型未知').split(';')[0].slice(0, 60);
      summary = '已尝试读取：HTTP ' + result.status + ' · ' + (result.metadata.method === 'browser' ? '浏览器' : '直接请求') + ' · ' + type + '。响应内容未发送给 AI。';
    }
  } catch (error) {
    summary = '已尝试读取，但连接失败：' + String(error.cause?.code || error.message || '未知错误').slice(0, 160);
  }
  sourceCheckCache.set(cacheKey, { at: Date.now(), summary });
  if (sourceCheckCache.size > 64) sourceCheckCache.delete(sourceCheckCache.keys().next().value);
  return summary;
}
async function parseInstructionAttempt(user, instruction, sourceUrlInput, trace, conversationInput = [], repairFeedback = '', timeZoneInput = '', draftInput = null) {
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
  if (sourceUrl && (sourceInput || !/提醒我|每隔.{0,20}提醒|每天.{0,20}提醒/.test(fullInput))) trace.sourceCheck = await checkSourceConnection(user, sourceUrl);
  const dmit = /\bdmit\b/i.test(fullInput);
  let timeZone = String(timeZoneInput || '').slice(0, 80);
  try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch { timeZone = 'Asia/Shanghai'; }
  if (!timeZone) timeZone = 'Asia/Shanghai';
  trace.timeZone = timeZone;
  const endpoint = aiEndpoint(user.settings.aiBaseUrl || 'https://api.openai.com/v1');
  trace.model = user.settings.aiModel;
  trace.apiEndpoint = new URL(endpoint).origin + new URL(endpoint).pathname;
  let draft = null;
  try { if (draftInput) draft = validateMonitor(draftInput, { allowMissingSource: true, allowPastReminder: true }); } catch { /* the latest user instruction can repair an incomplete draft */ }
  const aiRequest = {
      model: user.settings.aiModel,
      messages: assistantMessages({ timeZone, sourceUrl, sourceInput, fixedSourceUrl, draft, instruction: input, turns, repairFeedback })
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
    if (!repairFeedback && (sourceUrl || followup.questions.some((question) => /周期|频率|阈值|字段|sourceType|metric|path|表达式/i.test(question)))) {
      const error = new Error('请先尝试生成可确认方案（目标地址可在草稿中补充），采用合理默认值并在 assumptions 中说明；不要把可推断的参数交给用户。只有确实无法决定业务含义时，才问一个通俗问题。原提问：' + followup.questions.join('；'));
      error.repairable = true;
      throw error;
    }
    if (followup.questions.some((question) => /字段|字段名|JSON 路径|path|metric|sourceType|表达式/i.test(question))) {
      const error = new Error('已有来源地址，却要求用户猜测技术字段；请优先考虑 HTTP/TCP 可用性，或用业务语言说明尚需什么样例');
      error.repairable = true;
      error.question = '你希望在系统打不开时收到提醒，还是在某个业务状态变化时提醒？说出你平时会怎么判断就可以。';
      throw error;
    }
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
  let output = ['ready', 'draft'].includes(parsed?.status) && parsed.monitor ? parsed.monitor : parsed;
  if (draft && output && typeof output === 'object' && !Array.isArray(output)) {
    const kind = output.kind || (output.remindAt ? 'reminder' : output.plan ? 'generated' : draft.kind);
    if (kind === draft.kind) output = { ...draft, ...output, kind, ...(kind === 'generated' ? { plan: output.plan ? { ...draft.plan, ...output.plan } : draft.plan } : {}) };
    else if (kind === 'generated' && draft.kind !== 'reminder') output = { label: draft.label, url: draft.url, intervalMinutes: draft.intervalMinutes, severity: draft.severity, notification: draft.notification, fetch: draft.fetch, ...output, kind };
    if (output.notification && typeof output.notification === 'object' && !Array.isArray(output.notification)) output.notification = { ...draft.notification, ...output.notification };
  }
  const presentation = draftPresentation(parsed);
  if (output && typeof output === 'object' && !output.notification && draft && (output.kind || (output.remindAt ? 'reminder' : 'generated')) === draft.kind) output.notification = draft.notification;
  if (!output || typeof output !== 'object' || Array.isArray(output)) { const error = new Error('AI 未返回有效规则'); error.repairable = true; throw error; }
  if (output.kind === 'reminder' || output.remindAt) {
    const interval = Number(output.repeatMinutes);
    if (!output.remindAt && /每隔\s*\d+/.test(fullInput) && Number.isInteger(interval) && interval >= 1 && interval <= 525600) {
      output.remindAt = new Date(Date.now() + interval * 60_000).toISOString();
    }
    try { return { status: 'ready', monitor: validateMonitor({ ...output, kind: 'reminder' }, { allowPastReminder: draft?.kind === 'reminder' && Date.parse(output.remindAt) === Date.parse(draft.remindAt) }), parser: 'ai', sourceNote: '', ...presentation }; }
    catch (error) {
      if (/提醒时间|提醒什么/.test(error.message)) return needMoreInfo([error.message]);
      error.repairable = true;
      throw error;
    }
  }
  if (!sourceUrl && !dmit) {
    let plan;
    try { plan = validateGeneratedPlan(output.plan); }
    catch (error) { error.repairable = true; error.question = '你希望什么时候收到提醒？可以说“打不开时”或“出现某种变化时”。'; throw error; }
    const minimum = ['service', 'log'].includes(plan.sourceType) ? 1 : 5;
    const monitor = {
      kind: 'generated', url: '', plan, notification: validateNotification(output.notification),
      label: String(output.label || '新监控').trim().slice(0, 60),
      intervalMinutes: Math.max(minimum, Math.min(1440, Number(output.intervalMinutes) || 5)),
      severity: ['info', 'warning', 'critical'].includes(output.severity) ? output.severity : 'warning',
      description: describeGeneratedPlan(plan)
    };
    return { status: 'draft', monitor, parser: 'ai', missing: ['source'], ...presentation,
      message: presentation.message || '我已拟好监控方案。填入你平时访问的网址，就可以试跑并确认创建。' };
  }
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
  try { candidate = validateMonitor({ ...output, kind: output.kind && output.kind === draft?.kind ? output.kind : 'generated' }); }
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
  return { status: 'ready', monitor: candidate, parser: 'ai', sourceNote, ...presentation };
}

async function parseInstruction(user, instruction, sourceUrlInput, trace, conversationInput = [], timeZone = '', draftInput = null) {
  try { return await parseInstructionAttempt(user, instruction, sourceUrlInput, trace, conversationInput, '', timeZone, draftInput); }
  catch (error) {
    if (!error.repairable) throw error;
    trace.firstModelError = error.message;
    trace.firstModelResponse = trace.aiResponse || '';
    try { return await parseInstructionAttempt(user, instruction, sourceUrlInput, trace, conversationInput, error.message, timeZone, draftInput); }
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
        const suppliedId = String(request.headers['x-radar-request-id'] || '');
        const requestId = /^[a-zA-Z0-9-]{1,80}$/.test(suppliedId) ? suppliedId : randomUUID();
        const started = Date.now();
        const payload = JSON.stringify({ model, messages: [{ role: 'user', content: '回复 OK' }] });
        const trace = { requestId, apiEndpoint: endpoint, model, aiRequest: payload, networkRoute: '服务器网络设置（不使用网页监控代理）' };
        const redact = value => {
          let text = String(value || '');
          for (const secret of [key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[已隐藏的 API Key]');
          return text;
        };
        const safeTrace = () => redactData(trace, redact);
        try {
          const raw = await fetchText(endpoint, { method: 'POST', timeout: 20000, maxBytes: 100_000,
            onResponse: status => { trace.httpStatus = status; },
            onBody: text => { trace.responseBody = text.slice(0, 12000); trace.aiResponseTruncated = text.length > 12000; },
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: payload });
          let result;
          try { result = JSON.parse(raw); } catch { throw new Error('API 返回的不是 JSON；请在日志查看原始响应和实际请求地址'); }
          if (!Array.isArray(result.choices) || !result.choices[0]?.message) throw new Error('API 响应缺少 Chat Completions 结果；请在日志查看原始响应');
          addLog(user, 'ai-test', 'success', `AI 连接成功 · ${model}`, new URL(endpoint).origin, Date.now() - started, null, safeTrace());
          return sendJson(response, 200, { ok: true, model, requestId, durationMs: Date.now() - started });
        } catch (error) {
          Object.assign(trace, { networkCode: error.networkCode || null, networkCause: error.networkCause || null, error: error.message });
          let hint = '';
          if (/timeout/i.test(error.networkCode || error.name)) hint = 'AI 接口在 20 秒内未响应';
          else if (/CERT|TLS|SSL/i.test(error.networkCode || '')) hint = '服务器连接 AI 接口时 TLS / 证书校验失败';
          else if (/ENOTFOUND|EAI_AGAIN/.test(error.networkCode || '')) hint = '服务器无法解析 AI 接口域名';
          else if (/ECONNREFUSED/.test(error.networkCode || '')) hint = 'AI 接口拒绝了服务器连接';
          let detail = error.message;
          if (trace.httpStatus >= 400) {
            let provider;
            try { const parsed = JSON.parse(trace.responseBody || '{}'); provider = parsed.error?.message || parsed.message || (typeof parsed.error === 'string' ? parsed.error : ''); } catch { /* original response remains in logs */ }
            detail = 'AI 接口返回 HTTP ' + trace.httpStatus + (provider ? ' · ' + String(provider).slice(0, 300) : '');
          } else if (error.networkCode && !detail.includes(error.networkCode)) detail += ' · ' + error.networkCode;
          const message = redact(hint ? hint + ' · ' + detail : detail);
          addLog(user, 'ai-test', 'error', message, new URL(endpoint).origin, Date.now() - started, null, safeTrace());
          return sendJson(response, 502, { error: message, code: error.networkCode || 'AI_TEST_FAILED', requestId, upstreamStatus: trace.httpStatus || null });
        }
      }
      if (['PUT', 'DELETE'].includes(request.method) && pathname === '/api/source-proxy') {
        const body = request.method === 'PUT' ? await readJson(request) : {};
        const proxy = request.method === 'DELETE' ? '' : validateSourceProxy(body.proxyUrl || user.settings.sourceProxy);
        if (request.method === 'PUT' && !proxy) throw new Error('请填写代理地址，或使用清除按钮移除已保存代理');
        if (body.applyAll && user.monitors.some(monitor => monitor.fetch?.proxy === 'direct' && activeChecks.has(monitor.id))) throw new Error('有直接连接的任务正在检查，请等待检查完成后再应用代理');
        user.settings.sourceProxy = proxy;
        for (const monitor of user.monitors) {
          const webSource = monitor.kind !== 'reminder' && !(monitor.kind === 'generated' && ['log', 'service'].includes(monitor.plan.sourceType));
          if (!webSource) continue;
          if (body.applyAll && request.method === 'PUT' && monitor.fetch?.proxy === 'direct') {
            monitor.fetch = { ...validateFetchOptions(monitor.fetch), proxy: 'default' };
            monitor.revision = (monitor.revision || 0) + 1;
          }
          if (monitor.fetch?.proxy === 'direct') continue;
          Object.assign(monitor, { sourceRetryAt: null, sourceFailures: 0, lastSourceError: '', lastFetch: null });
        }
        for (const key of sourceCheckCache.keys()) if (key.startsWith(user.id + ':')) sourceCheckCache.delete(key);
        persist();
        return sendJson(response, 200, publicState(user));
      }
      if (request.method === 'POST' && pathname === '/api/source-proxy/test') {
        const body = await readJson(request);
        const proxyUrl = validateSourceProxy(body.proxyUrl || user.settings.sourceProxy);
        if (!proxyUrl) throw new Error('请先填写或保存代理地址');
        const targetUrl = urlOf(body.targetUrl, '测试网站');
        const started = Date.now();
        try {
          const result = await fetchSource(targetUrl, { userId: user.id, proxyUrl, mode: body.mode === 'browser' ? 'browser' : 'http' });
          addLog(user, 'proxy-test', 'success', '代理读取成功 · HTTP ' + result.status, targetUrl, Date.now() - started, null, { fetch: result.metadata });
          return sendJson(response, 200, { status: result.status, method: result.metadata.method, endpoint: proxyEndpoint(proxyUrl), durationMs: Date.now() - started });
        } catch (error) {
          addLog(user, 'proxy-test', 'error', error.message, targetUrl, Date.now() - started, null, { errorCode: error.code, fetch: error.fetchDetails });
          throw error;
        }
      }
      if (request.method === 'PUT' && pathname === '/api/settings') {
        const body = await readJson(request);
        const webhooks = validateWebhooks(body.webhooks ?? user.settings.webhooks);
        const aiBaseUrl = body.aiBaseUrl ? urlOf(body.aiBaseUrl, 'AI API 地址') : 'https://api.openai.com/v1';
        const aiModel = String(body.aiModel || '').trim().slice(0, 100);
        const aiKey = body.aiKey ? String(body.aiKey).trim().slice(0, 500) : user.settings.aiKey;
        user.settings = { ...user.settings, webhooks, aiBaseUrl, aiModel, aiKey };
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
        const savedMonitor = body.monitorId ? user.monitors.find((item) => item.id === body.monitorId) : null;
        if (body.monitorId && !savedMonitor) return sendJson(response, 404, { error: '任务不存在' });
        const revision = savedMonitor?.revision || 0;
        if (savedMonitor && body.expectedRevision != null && body.expectedRevision !== revision) return sendJson(response, 409, { error: '任务已被修改，请重新打开任务后再与 AI 调整' });
        const trace = {};
        const safeTrace = () => Object.fromEntries(Object.entries(trace).map(([name, value]) => [name, typeof value === 'string' && user.settings.aiKey ? value.replaceAll(user.settings.aiKey, '[已隐藏的 API Key]') : value]));
        try {
          const draft = body.draft || savedMonitor;
          const source = savedMonitor ? instructionUrl(String(body.instruction || '')) || body.sourceUrl || draft?.url : body.sourceUrl;
          const parsed = await parseInstruction(user, body.instruction, source, trace, body.conversation, body.timeZone, draft);
          if (savedMonitor) {
            if (!user.monitors.includes(savedMonitor)) return sendJson(response, 404, { error: '任务已删除，本次方案未应用' });
            if ((savedMonitor.revision || 0) !== revision) return sendJson(response, 409, { error: '任务在生成期间被修改，请重新打开后再调整' });
            if (parsed.monitor && ((parsed.monitor.kind === 'reminder') !== (savedMonitor.kind === 'reminder'))) return sendJson(response, 200, { status: 'answer', message: '这会把任务改成另一种类别。当前修改保留原任务类别；你可以取消修改后创建新的监控或提醒。' });
            parsed.editing = { monitorId: savedMonitor.id, revision };
          }
          if (trace.sourceCheck) parsed.sourceCheck = trace.sourceCheck;
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
          trace.validation = parsed.status === 'draft' ? '草稿已生成，待补充目标' : '通过';
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
      if (request.method === 'POST' && pathname === '/api/notification-preview') {
        const body = await readJson(request);
        const saved = body.monitorId ? user.monitors.find((item) => item.id === body.monitorId) : null;
        if (body.monitorId && !saved) return sendJson(response, 404, { error: '任务不存在' });
        const input = saved ? { ...saved, ...body.rule, kind: body.rule?.kind || saved.kind } : body.rule;
        const spec = { ...validateMonitor(input, { allowMissingSource: true, allowPastReminder: Boolean(saved) }), priority: input.priority,
          webhookIds: input.webhookIds, id: saved?.id };
        const previous = notificationPreviews.get(body.previousPreviewId);
        const observed = previous?.userId === user.id && previous.expiresAt > Date.now() && previous.sourceSignature === previewSourceSignature(spec)
          ? previous.observed : saved && previewSourceSignature(saved) === previewSourceSignature(spec) ? saved.snapshot : null;
        return sendJson(response, 200, buildNotificationPreview(user, spec, observed));
      }
      if (request.method === 'POST' && pathname === '/api/notification-simulate') {
        const body = await readJson(request);
        const preview = notificationPreviews.get(body.previewId);
        if (!preview || preview.userId !== user.id || preview.expiresAt <= Date.now()) return sendJson(response, 404, { error: '预览已失效，请刷新预览后再发送' });
        if (preview.monitorId && !user.monitors.some((item) => item.id === preview.monitorId)) return sendJson(response, 404, { error: '任务已删除' });
        if (!preview.hooks.length) throw new Error('请先选择至少一个接收渠道');
        const ids = selectedWebhookIds(user, preview.hooks.map((hook) => hook.id));
        if (preview.hooks.some((hook) => JSON.stringify(user.settings.webhooks.find((item) => item.id === hook.id)) !== hook.signature)) throw new Error('接收渠道已修改，请刷新预览后再发送');
        // Consume before awaiting I/O, so repeated clicks cannot send the same simulation twice.
        notificationPreviews.delete(body.previewId);
        const report = await deliver(user, preview.payload, ids);
        addLog(user, 'simulation', report.failed.length ? 'error' : 'success',
          '模拟通知 · ' + report.sent.length + ' 个渠道成功，' + report.failed.length + ' 个失败', null, 0, preview.monitorId,
          { notification: JSON.stringify(preview.payload), channels: JSON.stringify(report) });
        addEvent(user, report.failed.length ? 'error' : 'success', '模拟通知', report.sent.length + ' 个渠道成功，' + report.failed.length + ' 个失败；任务状态不变', preview.monitorId);
        return sendJson(response, 200, report);
      }
      if (request.method === 'POST' && pathname === '/api/preview-check') {
        const input = await readJson(request);
        const spec = { ...validateMonitor(input), priority: input.priority, webhookIds: input.webhookIds };
        const started = Date.now();
        let status;
        let responseSample = '';
        let fetchDetails;
        try {
          let result;
          if (spec.kind === 'generated' && spec.plan.sourceType === 'service') {
            result = await inspectService(spec.url, spec.plan);
            status = result.httpStatus;
          } else if (spec.kind === 'generated' && spec.plan.sourceType === 'log') result = inspectLog(logRoot, user, spec, null, true);
          else {
            const expectsJson = ['dmit', 'json', 'github'].includes(spec.kind) || spec.kind === 'generated' && spec.plan.sourceType === 'json';
            const source = await fetchSource(spec.url, { ...sourceOptions(user, spec), expectsJson });
            const body = source.body;
            status = source.status;
            fetchDetails = source.metadata;
            responseSample = body.slice(0, 4000);
            result = spec.kind === 'generated' ? inspectGenerated(spec.plan, body) : inspectPage(spec, body);
          }
          addLog(user, 'preview', 'success', `来源测试 · ${status ? `HTTP ${status} · ` : ''}${result.summary}`, spec.url, Date.now() - started, null, fetchDetails ? { fetch: fetchDetails } : null);
          return sendJson(response, 200, { fetch: fetchDetails, status: status || null, healthy: result.healthy, summary: result.summary, notificationPreview: buildNotificationPreview(user, spec, result) });
        } catch (error) {
          addLog(user, 'preview', 'error', `来源测试 · ${error.message}`, spec.url, Date.now() - started, null, {
            errorCode: error.code || null, fetch: error.fetchDetails || fetchDetails || null,
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
          if (body.expectedRevision != null && body.expectedRevision !== (monitor.revision || 0)) return sendJson(response, 409, { error: '这个任务已在其他位置被修改。请重新打开任务，再确认本次调整。' });
          if (activeChecks.has(monitor.id)) return sendJson(response, 409, { error: '任务正在检查或发送，请稍后再次保存；本次修改已保留。' });
          const updated = structuredClone(monitor);
          let resetBaseline = false;
          let fetchChanged = false;
          if (body.rule) {
            const kind = body.rule.kind || monitor.kind;
            if (kind !== monitor.kind && (kind !== 'generated' || monitor.kind === 'reminder')) throw new Error('本次修改需要保留任务类别；如需在监控和日历提醒之间切换，请另建任务');
            const unchangedReminderTime = monitor.kind === 'reminder' && Date.parse(body.rule.remindAt || monitor.remindAt) === Date.parse(monitor.remindAt);
            const next = validateMonitor({ ...monitor, ...body.rule, kind }, { allowPastReminder: unchangedReminderTime });
            if (body.rule.priority !== undefined) {
              next.priority = body.rule.priority === '' || body.rule.priority == null ? null : Number(body.rule.priority);
              if (next.priority != null && (!Number.isInteger(next.priority) || next.priority < 1 || next.priority > 5)) throw new Error('ntfy 优先级必须在 1 到 5 之间');
            }
            if (monitor.kind === 'reminder' && monitor.completedAt && next.repeatMinutes && Date.parse(next.remindAt) <= Date.now()) next.remindAt = nextRecurringTime(next.remindAt, next.repeatMinutes);
            if (monitor.kind === 'reminder' && (next.remindAt !== monitor.remindAt || next.repeatMinutes !== (monitor.repeatMinutes || 0))) {
              Object.assign(updated, { firedAt: null, completedAt: null, pendingNotifications: [], lastCheckAt: null, lastError: '', lastResult: '' });
            }
            resetBaseline = monitor.kind !== 'reminder' && (kind !== monitor.kind || ['url', 'keyword', 'mode', 'triggerMode', 'jsonPath', 'operator', 'expected'].some((key) => next[key] !== monitor[key]) || JSON.stringify(next.plan) !== JSON.stringify(monitor.plan));
            fetchChanged = JSON.stringify(validateFetchOptions(next.fetch)) !== JSON.stringify(validateFetchOptions(monitor.fetch));
            if (fetchChanged || resetBaseline) Object.assign(updated, { sourceFailures: 0, sourceRetryAt: null, lastSourceError: '', lastFetch: null });
            if (kind !== monitor.kind) for (const key of ['keyword', 'mode', 'triggerMode', 'jsonPath', 'operator', 'expected', 'plan']) delete updated[key];
            Object.assign(updated, next);
            if (resetBaseline) Object.assign(updated, { snapshot: null, baselined: false, lastCheckAt: null, lastResult: '', pendingNotifications: [], lastError: '' });
          }
          if (body.webhookIds !== undefined) {
            updated.webhookIds = selectedWebhookIds(user, body.webhookIds);
            const selected = new Set(updated.webhookIds);
            for (const pending of updated.pendingNotifications) pending.remainingIds = pending.remainingIds.filter((id) => selected.has(id));
            updated.pendingNotifications = updated.pendingNotifications.filter((pending) => pending.remainingIds.length);
          }
          if (body.enabled !== undefined) {
            if (body.enabled && updated.kind === 'reminder' && updated.completedAt) throw new Error('已完成的提醒请先设置新的时间');
            if (body.enabled) selectedWebhookIds(user, updated.webhookIds);
            updated.enabled = Boolean(body.enabled);
          }
          if (/^(没有接收渠道|接收渠道均已停用)/.test(updated.lastError || '')) updated.lastError = '';
          updated.revision = (monitor.revision || 0) + 1;
          for (const key of Object.keys(monitor)) if (!(key in updated)) delete monitor[key];
          Object.assign(monitor, updated);
          persist();
          if ((resetBaseline || fetchChanged) && monitor.enabled) await checkMonitor(user, monitor);
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
    if (!['index.html', 'app.js', 'style.css', 'extra.css', 'spatial.css', 'premium.css', 'controls.css'].includes(filename)) return sendJson(response, 404, { error: '页面不存在' });
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
    const retryAt = Date.parse(monitor.sourceRetryAt);
    const due = Number.isFinite(retryAt) ? now >= retryAt : !Number.isFinite(lastCheck) || now - lastCheck >= monitor.intervalMinutes * 60_000;
    if (monitor.kind !== 'reminder' && monitor.enabled && due) checkMonitor(user, monitor);
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
