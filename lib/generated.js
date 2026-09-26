import { visibleText } from './monitor.js';

const operators = new Set(['equals', 'notEquals', 'contains', 'in', 'gt', 'gte', 'lt', 'lte', 'withinMinutes']);
const modes = new Set(['compare', 'changed', 'any', 'item-transition', 'contains', 'absent', 'new-item', 'unavailable', 'available', 'slow', 'new-line']);
const pathPattern = /^[\w-]+(?:\.[\w-]+)*$/;

function field(value, label, max = 120) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max) throw new Error(`${label}无效`);
  return result;
}

function path(value, label) {
  const result = field(value, label);
  if (!pathPattern.test(result) || result.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error(`${label}需要使用 a.b.c 格式`);
  return result;
}

function scalar(value, label) {
  if (typeof value === 'string' && value.length <= 160) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  throw new Error(`${label}无效`);
}

function values(value, label) {
  if (!Array.isArray(value) || !value.length || value.length > 12) throw new Error(`${label}需要 1 到 12 个值`);
  return value.map((item) => scalar(item, label));
}

function predicate(candidate) {
  if (!candidate || typeof candidate !== 'object') throw new Error('筛选条件无效');
  const operator = field(candidate.operator, '比较方式', 20);
  if (!operators.has(operator)) throw new Error('不支持的比较方式');
  const expected = operator === 'in' ? values(candidate.expected, '比较值') : scalar(candidate.expected, '比较值');
  if (operator === 'withinMinutes' && (!Number.isFinite(Number(expected)) || Number(expected) < 1 || Number(expected) > 1440)) throw new Error('时间范围需要 1 到 1440 分钟');
  return { path: path(candidate.path, '字段路径'), operator, expected };
}

export function validateGeneratedPlan(candidate) {
  if (!candidate || typeof candidate !== 'object') throw new Error('AI 未生成有效监控逻辑');
  const sourceType = field(candidate.sourceType, '来源类型', 20);
  const mode = field(candidate.mode, '检查方式', 30);
  if (!['json', 'html', 'rss', 'service', 'log'].includes(sourceType) || !modes.has(mode)) throw new Error('AI 生成了不支持的监控逻辑');
  const compatible = { json: ['compare', 'changed', 'any', 'item-transition'], html: ['contains', 'absent'], rss: ['new-item'], service: ['unavailable', 'available', 'slow'], log: ['new-line'] };
  if (!compatible[sourceType].includes(mode)) throw new Error('来源与检查方式不匹配');
  const initial = mode === 'changed' ? 'baseline' : candidate.initial === 'notify' ? 'notify' : 'baseline';
  const plan = { sourceType, mode, initial };
  if (mode === 'compare') Object.assign(plan, predicate(candidate));
  if (mode === 'changed') plan.path = path(candidate.path, '字段路径');
  if (mode === 'any' || mode === 'item-transition') {
    plan.path = path(candidate.path, '列表路径');
    if (!Array.isArray(candidate.filters) || candidate.filters.length > 8) throw new Error('筛选条件最多 8 个');
    plan.filters = candidate.filters.map(predicate);
  }
  if (mode === 'item-transition') {
    plan.idPath = path(candidate.idPath, '条目标识字段');
    plan.statePath = path(candidate.statePath, '状态字段');
    plan.fromValues = values(candidate.fromValues, '原状态');
    plan.toValues = values(candidate.toValues, '目标状态');
  }
  if (mode === 'contains' || mode === 'absent') plan.keyword = field(candidate.keyword, '监控文字', 80);
  if (mode === 'new-item') plan.keyword = String(candidate.keyword || '').trim().slice(0, 80);
  if (mode === 'slow') {
    plan.thresholdMs = Number(candidate.thresholdMs);
    if (!Number.isInteger(plan.thresholdMs) || plan.thresholdMs < 100 || plan.thresholdMs > 30000) throw new Error('服务响应阈值需要在 100 到 30000 毫秒之间');
  }
  if (mode === 'new-line') {
    plan.keyword = field(candidate.keyword, '日志关键词', 120);
    plan.caseSensitive = candidate.caseSensitive === true;
  }
  return plan;
}

function at(value, dottedPath) {
  return dottedPath.split('.').reduce((part, key) => part?.[key], value);
}

function compare(actual, operator, expected) {
  if (actual === undefined) return false;
  if (operator === 'equals') return String(actual) === String(expected);
  if (operator === 'notEquals') return String(actual) !== String(expected);
  if (operator === 'contains') return String(actual).toLocaleLowerCase().includes(String(expected).toLocaleLowerCase());
  if (operator === 'in') return expected.some((item) => String(actual).toLocaleLowerCase() === String(item).toLocaleLowerCase());
  if (operator === 'withinMinutes') {
    const age = Date.now() - Date.parse(String(actual));
    return Number.isFinite(age) && age >= 0 && age <= Number(expected) * 60_000;
  }
  const left = Number(actual), right = Number(expected);
  if (!Number.isFinite(left) || !Number.isFinite(right)) throw new Error('比较值不是数字');
  return ({ gt: left > right, gte: left >= right, lt: left < right, lte: left <= right })[operator];
}

function feedEntries(xml) {
  const entries = [...xml.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)].slice(0, 30).map((match) => {
    const title = match[1].match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
    const link = match[1].match(/<link\b[^>]*href=["']([^"']+)/i)?.[1] || match[1].match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1] || '';
    return { title: visibleText(title).slice(0, 200), link: link.trim().slice(0, 1000) };
  });
  if (!entries.length) throw new Error('订阅源没有可识别的条目');
  return entries;
}

export function inspectGenerated(plan, body) {
  if (plan.sourceType === 'html') {
    const hasText = visibleText(body).toLocaleLowerCase().includes(plan.keyword.toLocaleLowerCase());
    const matched = plan.mode === 'absent' ? !hasText : hasText;
    return { matched, summary: `${plan.mode === 'absent' ? '未出现' : '已出现'}「${plan.keyword}」：${matched ? '是' : '否'}` };
  }
  if (plan.sourceType === 'rss') {
    const entries = feedEntries(body);
    return { entries, summary: `最新：${entries[0].title}` };
  }
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('接口没有返回有效 JSON'); }
  if (plan.mode === 'compare' || plan.mode === 'changed') {
    const actual = at(data, plan.path);
    if (actual === undefined) throw new Error(`JSON 字段 ${plan.path} 不存在`);
    if (actual !== null && typeof actual === 'object') throw new Error(`JSON 字段 ${plan.path} 不是可比较的单值`);
    if (plan.mode === 'changed') return { value: String(actual), summary: `${plan.path} = ${String(actual).slice(0, 100)}` };
    const matched = compare(actual, plan.operator, plan.expected);
    return { matched, summary: `${plan.path} = ${String(actual).slice(0, 100)}` };
  }
  const items = at(data, plan.path);
  if (!Array.isArray(items)) throw new Error(`JSON 列表 ${plan.path} 不存在`);
  const filtered = items.filter((item) => plan.filters.every((filter) => compare(at(item, filter.path), filter.operator, filter.expected)));
  if (plan.mode === 'any') return { matched: filtered.length > 0, count: filtered.length, summary: `${filtered.length} 条符合条件` };
  const states = Object.create(null);
  for (const item of filtered.slice(0, 2000)) {
    const id = at(item, plan.idPath);
    if (id != null) states[String(id)] = String(at(item, plan.statePath));
  }
  return { states, summary: `跟踪 ${Object.keys(states).length} 条状态` };
}

export function transitionGenerated(plan, previous, current) {
  if (plan.sourceType === 'log') return previous ? current.matches > 0 : plan.initial === 'notify' && current.matches > 0;
  if (plan.mode === 'changed') return Boolean(previous) && previous.value !== current.value;
  if (plan.mode === 'new-item') {
    if (!previous) return plan.initial === 'notify' && current.entries.some((item) => !plan.keyword || item.title.includes(plan.keyword));
    return current.entries.some((item) => !previous.entries?.some((old) => old.link ? old.link === item.link : old.title === item.title) && (!plan.keyword || item.title.includes(plan.keyword)));
  }
  if (plan.mode === 'item-transition') {
    if (!previous) return plan.initial === 'notify' && Object.values(current.states).some((state) => plan.toValues.some((value) => String(value) === state));
    return Object.entries(current.states).some(([id, state]) => plan.fromValues.some((value) => String(value) === previous.states?.[id]) && plan.toValues.some((value) => String(value) === state));
  }
  return previous ? !previous.matched && current.matched : plan.initial === 'notify' && current.matched;
}

export function describeGeneratedPlan(plan) {
  const operatorLabel = { equals: '等于', notEquals: '不等于', contains: '包含', in: '属于', gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于', withinMinutes: '最近' };
  const predicate = (item) => `${item.path} ${operatorLabel[item.operator]} ${item.operator === 'withinMinutes' ? `${item.expected} 分钟` : Array.isArray(item.expected) ? item.expected.join('/') : String(item.expected)}`;
  if (plan.sourceType === 'service') return `服务${plan.mode === 'unavailable' ? '不可用' : plan.mode === 'available' ? '恢复可用' : `响应超过 ${plan.thresholdMs} 毫秒`}时通知${plan.initial === 'notify' ? '；首次检查满足时立即通知' : ''}`;
  if (plan.sourceType === 'log') return `日志新增包含「${plan.keyword}」的行时通知${plan.initial === 'notify' ? '；首次检查读取现有末尾内容' : '；首次检查从当前位置开始'}`;
  if (plan.mode === 'any') return `JSON 列表 ${plan.path} 中存在符合${plan.filters.length ? ` ${plan.filters.map(predicate).join('、')} ` : ''}条件的条目${plan.initial === 'notify' ? '；首次检查满足时立即通知' : '；首次检查仅建立基线'}`;
  if (plan.mode === 'item-transition') return `JSON 列表 ${plan.path} 中${plan.filters.length ? `符合 ${plan.filters.map(predicate).join('、')} 的` : ''}条目从 ${plan.fromValues.join('/')} 变为 ${plan.toValues.join('/')} 时通知`;
  if (plan.mode === 'compare') return `JSON 字段 ${predicate(plan)} 时通知${plan.initial === 'notify' ? '；首次检查满足时立即通知' : ''}`;
  if (plan.mode === 'changed') return `JSON 字段 ${plan.path} 的值发生变化时通知；首次检查只记录当前值`;
  if (plan.mode === 'new-item') return `订阅源出现${plan.keyword ? `标题包含「${plan.keyword}」的` : ''}新条目时通知`;
  return `页面${plan.mode === 'absent' ? '不再包含' : '出现'}「${plan.keyword}」时通知${plan.initial === 'notify' ? '；首次检查满足时立即通知' : ''}`;
}
