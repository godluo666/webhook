import { inferGoal } from './page-analysis.js';
import { validateMonitorRule } from './monitor-rule.js';
import { resolveInterval, resolveRuleCondition } from './rule-policy.js';

// Older providers may still answer with the former "plan" prompt shape.
// Ordinary new tasks are compiled into the same MonitorRule as goal responses.
export async function normalizeAiPlan(user, candidate, { instruction, analysis, ruleService, editing = false, privateSourceProxy = '', hasNotification = false } = {}) {
  if (editing || candidate.kind !== 'generated' || !/^https?:\/\//.test(candidate.url)) return candidate;
  const plan = candidate.plan;
  if (!['html', 'service', 'json'].includes(plan.sourceType)) return candidate;
  const inferred = inferGoal(instruction);
  if (plan.sourceType === 'json' && !['compare', 'changed'].includes(plan.mode) && inferred.type !== 'product_stock') return candidate;
  const interval = resolveInterval(inferred.type, instruction);
  const existing = { ...candidate, notification: hasNotification ? candidate.notification : undefined, type: inferred.type, interval, sourceProxy: privateSourceProxy };
  if (['product_stock', 'price_change'].includes(inferred.type)) {
    if (!analysis) analysis = await ruleService.analyze(user, candidate.url, existing);
    let condition = inferred.condition;
    // Stock intent and explicit frequency are compiled by the program, independent of model wording.
    if (inferred.type === 'price_change' && !inferred.requested_condition && plan.mode === 'compare' && ['lt', 'lte', 'gt', 'gte'].includes(plan.operator)) condition = { operator: plan.operator, value: plan.expected, initial: plan.initial };
    // A guessed keyword/path is never used to create a stock/price task.
    const built = await ruleService.build(user, { type: inferred.type, condition, name: candidate.label, interval, all_models: inferred.all_models }, analysis, existing);
    return { ...built.rule, plan }; // Read-only compatibility information for older clients.
  }
  const service = plan.sourceType === 'service';
  const type = service || plan.sourceType === 'json' ? 'api_monitor' : 'webpage_change';
  let condition = service ? {
    operator: plan.mode, initial: plan.initial,
    ...(plan.mode === 'slow' ? { value: plan.thresholdMs } : {}),
    ...(plan.mode === 'unavailable' ? { failure_threshold: plan.failureThreshold } : {})
  } : plan.sourceType === 'html' ? { operator: plan.mode, value: plan.keyword, initial: plan.initial }
    : plan.mode === 'changed' ? { operator: 'changed', initial: 'baseline' }
    : { operator: plan.operator, value: plan.expected, initial: plan.initial };
  if (inferred.type === type) condition = resolveRuleCondition(inferred, condition);
  const spec = {
    ...candidate, kind: 'unified', type, name: candidate.label,
    detection_method: service ? 'api' : plan.sourceType === 'json' ? 'json' : candidate.fetch?.mode === 'browser' ? 'browser' : 'html',
    target_element: { label: service ? '接口可用性' : plan.sourceType === 'json' ? '接口数据字段' : '页面可见内容', ...(plan.sourceType === 'html' ? { selector: 'body' } : {}) },
    extraction_rule: service ? { kind: 'service' } : plan.sourceType === 'json' ? { kind: ['lt', 'lte', 'gt', 'gte'].includes(condition.operator) ? 'number' : 'json', path: plan.path.split('.') } : { kind: 'text' },
    condition, intervalMinutes: interval / 60, sourceProxy: privateSourceProxy
  };
  const report = await ruleService.test(user, spec);
  delete spec.sourceProxy;
  return { ...validateMonitorRule(spec), plan, confidence: report.confidence, last_test_result: report, description: report.condition, explanation: '已将旧格式 AI 回答转为统一监控规则，并完成实际检测。' };
}
