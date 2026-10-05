// Business defaults and frequency choices belong to the program, not the model.
export const DEFAULT_INTERVALS = Object.freeze({ product_stock: 30, price_change: 300, webpage_change: 300, api_monitor: 60 });
export const MIN_INTERVAL_SECONDS = 1;
export const DEFAULT_SLOW_THRESHOLD_MS = 3000;
export function defaultCondition(type) {
  if (type === 'product_stock') return { operator: 'transition', from: ['out_of_stock'], to: ['in_stock'], initial: 'baseline' };
  if (type === 'api_monitor') return { operator: 'unavailable', failure_threshold: 1, initial: 'baseline' };
  return { operator: 'changed', initial: 'baseline' };
}
const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const multipliers = { 十: 10, 百: 100, 千: 1000 };
function chineseNumber(input) {
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(input)) return Number(input);
  if (input === '半') return 0.5;
  const [whole, fraction] = input.split('点');
  let sum = 0, current = 0;
  for (const char of whole) {
    if (char in digits) current = digits[char];
    else if (char in multipliers) { sum += (current || 1) * multipliers[char]; current = 0; }
    else return NaN;
  }
  const decimals = fraction ? Number('0.' + [...fraction].map(char => digits[char] ?? 'x').join('')) : 0;
  return sum + current + decimals;
}
const amount = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)|[零〇一二两三四五六七八九十百千点]+|半';
const unit = '秒钟?|分钟?|小时|天|seconds?|secs?|s\\b|minutes?|mins?|m\\b|hours?|hrs?|h\\b|days?|d\\b';
const part = '(?:' + amount + ')\\s*(?:' + unit + ')';
const duration = '(?:(?:' + part + ')(?:\\s*(?:' + part + ')){0,2}|一刻钟|(?:' + unit + '))';
function durationSeconds(value) {
  if (value === '一刻钟') return 900;
  const parts = [...value.matchAll(new RegExp('(' + amount + ')\\s*(' + unit + ')', 'gi'))];
  if (!parts.length) parts.push([value, '1', value]);
  return Math.round(parts.reduce((sum, [, count, token]) => {
    const scale = /^(?:秒|s)/i.test(token) ? 1 : /^(?:分|m)/i.test(token) ? 60 : /^(?:小时|h)/i.test(token) ? 3600 : 86400;
    return sum + chineseNumber(count) * scale;
  }, 0) * 1000) / 1000;
}
export function requestedInterval(instruction) {
  const input = String(instruction || '').replace(/https?:\/\/[^\s\p{Script=Han}]+/gu, ' ');
  const patterns = [
    new RegExp('(?:每(?:隔)?|间隔(?:为|设为|改为)?|周期(?:为|设为|改为)?|频率(?:为|设为|改为)?|改成|改为|调整到)\\s*(' + duration + ')', 'gi'),
    new RegExp('(' + duration + ')\\s*(?:监控|检查|检测|执行|轮询)?\\s*(?:一|1)次', 'gi'),
    new RegExp('\\b(?:every|interval\\s*(?:of|is|=|:)?)[\\s]*(' + duration + ')', 'gi')
  ];
  const matches = patterns.flatMap(pattern => [...input.matchAll(pattern)]).sort((a, b) => a.index - b.index || b[1].length - a[1].length);
  return matches.length ? durationSeconds(matches.at(-1)[1]) : undefined;
}
export function validateInterval(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < MIN_INTERVAL_SECONDS) throw new Error('检测周期至少 1 秒，可按需求自定义秒、分钟或小时');
  if (value * 1000 > Math.min(Number.MAX_SAFE_INTEGER, 8.64e15) - Date.now()) throw new Error('检测周期过大，无法安全计算下一次检查时间');
  return value;
}
export function resolveInterval(type, instruction, existing = null, explicit) {
  return validateInterval(requestedInterval(instruction) ?? explicit ?? existing?.interval ?? (existing?.intervalMinutes != null ? existing.intervalMinutes * 60 : undefined) ?? DEFAULT_INTERVALS[type] ?? 300);
}
export function resolveRuleCondition(inferred, proposed, existing = null) {
  if (inferred.requested_condition) return inferred.condition;
  if (existing?.type === inferred.type && !inferred.condition_change) return existing.condition;
  if (inferred.standard_condition && !(existing?.type === inferred.type && inferred.condition_change && proposed)) return inferred.condition;
  return proposed ? { ...(existing?.type === inferred.type ? existing.condition : {}), ...proposed } : inferred.condition;
}
