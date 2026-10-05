import { displayValue } from './monitor-rule.js';
import { restockedItems } from './monitor.js';

const variables = new Set(['name', 'details', 'items', 'count', 'value', 'previous', 'summary', 'source', 'keyword', 'time', 'message']);
const clip = (value, limit) => String(value ?? '').length > limit ? String(value).slice(0, limit - 8) + '…（已截断）' : String(value ?? '');

export function validateNotification(candidate) {
  if (candidate == null) return { title: '{{name}}', body: '{{details}}' };
  if (typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('通知内容格式无效');
  const result = {};
  for (const [key, limit, fallback] of [['title', 200, '{{name}}'], ['body', 2000, '{{details}}']]) {
    const value = String(candidate[key] ?? fallback).trim();
    if (value.length > limit) throw new Error('通知' + (key === 'title' ? '标题' : '内容') + '过长');
    for (const match of value.matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
      if (!variables.has(match[1])) throw new Error('通知内容包含不支持的变量：' + match[1]);
    }
    if (value.replace(/{{\s*([^{}]+?)\s*}}/g, '').includes('{{')) throw new Error('通知变量格式无效');
    result[key] = value;
  }
  if (!result.title && !result.body) throw new Error('请填写通知标题或正文，不能同时为空');
  return result;
}

function changedItems(monitor, current, previous) {
  const plan = monitor.plan;
  return Object.entries(current?.states || {}).filter(([id, state]) =>
    plan.toValues.some((value) => String(value) === state) &&
    (!previous || plan.fromValues.some((value) => String(value) === previous.states?.[id]))
  ).map(([id, state]) => ({ name: current.itemNames?.[id] || id, state, before: previous?.states?.[id] }));
}
const list = (names, count = names.length) => names.slice(0, 10).map((name) => '• ' + name).join('\n') + (count > 10 ? '\n另有 ' + (count - 10) + ' 条，详见来源。' : '');

export function notificationContext(monitor, current = {}, previous = null) {
  let names = [], count = 0, details = current.summary || monitor.description || monitor.message || '';
  const plan = monitor.plan || {};
  if (monitor.kind === 'unified') {
    const label = monitor.type === 'product_stock' ? '库存状态' : monitor.type === 'price_change' ? '价格' : '关注内容';
    details = '商品 / 任务：' + monitor.label + '\n' + label + '：' + (previous?.value == null ? '' : displayValue(previous.value) + ' → ') + displayValue(current.value);
    if (monitor.type === 'webpage_change' && previous?.content_hash && current.content_hash !== previous.content_hash && current.value === previous.value) details = '任务：' + monitor.label + '\n页面内容已变化。当前摘要：' + displayValue(current.value);
    if (monitor.extraction_rule.kind === 'stock_items') {
      const before = new Map((previous?.items || []).map(item => [item.id, item]));
      const changed = current.triggered_items?.length ? current.items.filter(item => current.triggered_items.includes(item.id)) : (current.items || []).filter(item => monitor.condition.operator === 'equals' ? item.state === monitor.condition.value && (!before.has(item.id) || before.get(item.id).state !== item.state) : before.has(item.id) && monitor.condition.from?.includes(before.get(item.id).state) && monitor.condition.to?.includes(item.state));
      names = changed.map(item => item.name); count = changed.length;
      details = '商品 / 任务：' + monitor.label + '\n' + (changed.length ? '本次符合条件的型号：\n' + list(changed.map(item => item.name + ' · ' + (before.has(item.id) ? displayValue(before.get(item.id).state) + ' → ' : '') + displayValue(item.state)), count) : current.summary || '当前没有型号满足提醒条件');
    } else if (current.raw_value && monitor.type === 'product_stock') details += '\n页面状态：' + current.raw_value;
    if (monitor.type === 'api_monitor') details = '接口：' + monitor.label + '\n' + current.summary;
  } else if (monitor.kind === 'reminder') details = monitor.message;
  else if (plan.mode === 'any') {
    names = current.names || [];
    count = current.count || 0;
    details = count + ' 条符合条件：\n' + list(names, count);
  } else if (plan.mode === 'item-transition') {
    const items = changedItems(monitor, current, previous);
    names = items.map((item) => item.name); count = items.length;
    details = '本次变化的条目：\n' + list(items.map((item) => item.name + ' · ' + (item.before == null ? '' : item.before + ' → ') + item.state), count);
  } else if (plan.mode === 'changed') {
    details = '当前值：' + (current.value ?? '—') + (previous?.value == null ? '' : '\n之前：' + previous.value);
  } else if (monitor.kind === 'dmit') {
    const items = monitor.triggerMode === 'any-available' || !previous ? Object.values(current.items || {}).filter((item) => item.status === 'available') : restockedItems(previous, current);
    names = items.map((item) => item.name); count = items.length;
    details = 'DMIT ' + (monitor.triggerMode === 'any-available' ? '有货' : '补货') + '：\n' + list(names, count);
  } else if (current.entries) {
    const keyword = plan.keyword || monitor.keyword || '';
    const entries = current.entries.filter((item) => (!keyword || item.title.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())) && !previous?.entries?.some((old) => old.link ? old.link === item.link : old.title === item.title));
    names = entries.map((item) => item.title); count = entries.length;
    details = '新条目：\n' + list(entries.map((item) => item.title + (item.link ? '\n  ' + item.link : '')), count);
  } else if (monitor.kind === 'github') details = '发布了新版本 ' + current.tag + '\n' + current.link;
  else if (current.excerpt) details += '\n匹配附近的内容：' + current.excerpt;
  if (plan.sourceType === 'service' && current.consecutiveFailures) details += '\n连续失败：' + current.consecutiveFailures + ' 次';
  return {
    name: monitor.label, details: clip(details, monitor.kind === 'reminder' ? 2000 : 1600), items: clip(names.join('、'), 1300), count: String(count),
    value: String(current.value ?? current.latencyMs ?? ''), previous: String(previous?.value ?? ''), summary: current.summary || '',
    source: monitor.url || '', keyword: plan.keyword || monitor.keyword || '',
    time: new Date().toISOString(), message: monitor.message || ''
  };
}

export function renderNotification(monitor, current = {}, previous = null) {
  const template = validateNotification(monitor.notification);
  const context = notificationContext(monitor, current, previous);
  const expand = (text) => text.replace(/{{\s*([^{}]+?)\s*}}/g, (_, key) => context[key]);
  const title = clip(expand(template.title), 120);
  const message = clip(expand(template.body), 2000);
  if (!title.trim() && !message.trim()) throw new Error('通知内容为空，请填写文字或选择有内容的动态变量');
  return {
    event: monitor.kind === 'reminder' ? 'reminder.due' : 'monitor.triggered',
    title, message, monitorId: monitor.id || null,
    priority: monitor.priority ?? null, severity: monitor.severity || 'warning'
  };
}

export function notificationSample(monitor, current = null) {
  const plan = monitor.plan || {};
  if (monitor.kind === 'reminder') return { current: {}, basis: 'reminder', note: '到时将发送以下提醒内容。' };
  const evidence = current && (monitor.kind === 'unified' ? current.value != null || current.healthy != null : (
    plan.mode === 'any' ? current.count > 0 && current.names?.length :
    plan.mode === 'item-transition' ? changedItems(monitor, current, null).length > 0 :
    current.entries ? current.entries.some((entry) => !(plan.keyword || monitor.keyword) || entry.title.includes(plan.keyword || monitor.keyword)) :
    monitor.kind === 'dmit' ? Object.values(current.items || {}).some((item) => item.status === 'available') :
    plan.mode === 'new-line' ? current.matches > 0 :
    plan.mode === 'changed' || monitor.kind === 'github' ? true : current.matched === true
  ));
  if (evidence) return { current, basis: 'observed', note: '使用最近读取的真实数据展示通知效果；不代表发生了新的告警。' };
  let sample = { matched: true, summary: '检测条件已满足（示例）' };
  if (monitor.kind === 'unified') sample = { value: monitor.type === 'product_stock' ? 'in_stock' : monitor.type === 'price_change' ? monitor.condition.value ?? 199 : '变化后的内容（示例）', summary: '条件满足（示例）' };
  else if (plan.mode === 'any') sample = { matched: true, count: 2, names: ['示例条目 A', '示例条目 B'], summary: '2 条符合条件' };
  else if (plan.mode === 'item-transition') sample = { states: { sample: String(plan.toValues[0]) }, itemNames: { sample: '示例条目 A' }, summary: '1 条状态发生变化' };
  else if (plan.mode === 'changed') sample = { value: '新值（示例）', summary: '数值已变化' };
  else if (plan.mode === 'compare') sample = { matched: true, value: String(plan.expected), summary: plan.path + ' = ' + String(plan.expected) + '（示例值，请以实际比较条件为准）' };
  else if (plan.sourceType === 'html' || monitor.kind === 'webpage') sample.summary = (plan.mode === 'absent' || monitor.mode === 'absent' ? '未出现' : '已出现') + '「' + (plan.keyword || monitor.keyword) + '」（示例）';
  else if (plan.sourceType === 'service') sample.summary = plan.mode === 'available' ? '服务恢复可用 · HTTP 200 · 80 ms（示例）' : plan.mode === 'slow' ? '服务响应 ' + (plan.thresholdMs + 500) + ' ms（示例）' : '服务不可用 · 连接超时 · 连续失败 ' + (plan.failureThreshold || 1) + ' 次（示例）';
  else if (plan.sourceType === 'log') sample = { matches: 1, summary: '新增日志匹配：「' + plan.keyword + '」相关日志内容（示例）' };
  else if (plan.sourceType === 'rss' || monitor.kind === 'rss') sample = { entries: [{ title: (plan.keyword || monitor.keyword || '') + ' 新条目（示例）', link: '' }], summary: '发现新条目' };
  else if (monitor.kind === 'github') sample = { tag: 'v2.0.0（示例）', link: monitor.url };
  else if (monitor.kind === 'dmit') sample = { items: { sample: { name: '示例型号 A', status: 'available' } } };
  return { current: sample, basis: 'sample', note: current ? '当前没有可展示的命中数据，以下是条件满足时的示例。实际发送时会替换为检测到的内容。' : '尚未取得检测数据，以下使用示例内容。试跑后可查看真实匹配结果。' };
}
