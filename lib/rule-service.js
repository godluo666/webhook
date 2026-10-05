import { analyzePage, candidateRule, analysisForAI } from './page-analysis.js';
import { validateMonitorRule, extractRule, evaluateRule, ruleSignature, describeRule } from './monitor-rule.js';

import { stockBehaviorTests } from './rule-behavior.js';

export function createRuleService({ fetchSource, sourceOptions, inspectService }) {
  const observe = async (user, rule) => {
    if (rule.extraction_rule.kind === 'service') {
      const plan = { mode: rule.condition.operator, thresholdMs: rule.condition.value, failureThreshold: rule.condition.failure_threshold };
      const result = await inspectService(rule.url, plan, sourceOptions(user, rule));
      return { ...result, value: result.healthy ? 'healthy' : 'unhealthy', raw_value: result.summary };
    }
    const options = sourceOptions(user, rule);
    const source = await fetchSource(rule.extraction_rule.endpoint || rule.url, {
      ...options, ...(rule.detection_method === 'browser' ? { mode: 'browser' } : {}),
      expectsJson: ['json', 'api'].includes(rule.detection_method)
    });
    try { return { ...extractRule(rule, source.body), httpStatus: source.status, fetch: source.metadata }; }
    catch (error) { error.rule_checks = { accessible: true, ...error.rule_checks }; throw error; }
  };
  const test = async (user, input) => {
    const rule = validateMonitorRule(input);
    rule.fetch = input.fetch;
    rule.sourceProxy = input.sourceProxy || '';
    const checked_at = new Date().toISOString();
    const checks = { accessible: false, target_exists: false, extractable: false, condition_evaluable: false, goal_consistent: false };
    try {
      const snapshot = await observe(user, rule);
      checks.accessible = true;
      checks.target_exists = true;
      checks.extractable = true;
      const behavior_tests = stockBehaviorTests(rule, snapshot);
      if (behavior_tests.some(test => !test.passed)) throw Object.assign(new Error('规则未通过业务场景验证，不能可靠满足提醒需求'), { rule_checks: { accessible: true, target_exists: true, extractable: true, goal_consistent: false } });
      const result = evaluateRule(rule, snapshot);
      checks.condition_evaluable = typeof result.matched === 'boolean';
      checks.goal_consistent = rule.type !== 'product_stock' || ['in_stock', 'out_of_stock'].includes(snapshot.value) && (rule.extraction_rule.kind !== 'stock_items' || snapshot.items?.length > 0 && snapshot.items.every(item => item.id && item.name && ['in_stock', 'out_of_stock'].includes(item.state)));
      const confidence = rule.extraction_rule.kind === 'service' ? 0.9
        : rule.detection_method === 'api' ? 0.96 : rule.detection_method === 'json' ? 0.93
        : rule.extraction_rule.kind === 'stock_items' ? rule.detection_method === 'browser' ? 0.78 : rule.extraction_rule.script_selector ? 0.93 : 0.88
        : rule.extraction_rule.kind === 'structured_data' ? 0.9 : rule.detection_method === 'browser' ? 0.72
        : rule.detection_method === 'dom' ? 0.82 : rule.type === 'product_stock' ? 0.55 : 0.7;
      return { passed: Object.values(checks).every(Boolean), checked_at, checks, behavior_tests, confidence,
        signature: ruleSignature(rule), current_value: snapshot.value, raw_value: snapshot.raw_value,
        summary: snapshot.summary, condition: describeRule(rule), snapshot, error: null };
    } catch (error) {
      Object.assign(checks, error.rule_checks || {});
      const report = { passed: false, checked_at, checks, confidence: 0, signature: ruleSignature(rule), current_value: null, error: error.message, error_code: error.code || null };
      error.last_test_result = report;
      throw error;
    }
  };
  const analyze = async (user, url, draft = {}, { browser = false } = {}) => {
    const options = sourceOptions(user, draft);
    const source = await fetchSource(url, { ...options, ...(browser ? { mode: 'browser' } : {}) });
    let analysis = analyzePage(source.body, { url, method: source.metadata.method, apiResponses: source.apiResponses || [] });
    const responses = [...(source.apiResponses || [])];
    for (const endpoint of analysis.endpoints) {
      try {
        const result = await fetchSource(endpoint, { ...options, mode: 'http', expectsJson: true });
        responses.push({ url: endpoint, body: result.body, method: 'GET' });
      } catch { /* an advertised API must actually work before becoming a candidate */ }
    }
    if (responses.length) analysis = analyzePage(source.body, { url, method: source.metadata.method, apiResponses: responses });
    return { ...analysis, fetch: source.metadata, sourceStatus: source.status };
  };
  const build = async (user, goal, initialAnalysis, existing = null) => {
    let analysis = initialAnalysis, lastError;
    const attempts = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt === 2 && goal.type !== 'api_monitor') {
          analysis = await analyze(user, analysis.url, existing || {}, { browser: existing?.fetch?.mode !== 'http' });
        }
        const index = attempt === 2 ? 0 : attempt;
        const draft = candidateRule(goal, analysis, existing, index);
        const rule = validateMonitorRule(draft);
        rule.sourceProxy = existing?.sourceProxy || '';
        const result = await test(user, rule);
        attempts.push({ attempt: attempt + 1, passed: true, method: rule.detection_method });
        delete rule.sourceProxy;
        return { rule: { ...rule, confidence: result.confidence, last_test_result: result, explanation: draft.explanation, product: draft.product }, analysis: analysisForAI(analysis), attempts };
      } catch (error) {
        lastError = error;
        attempts.push({ attempt: attempt + 1, passed: false, error: error.message });
      }
    }
    throw Object.assign(new Error('自动验证未通过，未保存任务：' + lastError.message), { code: 'RULE_VALIDATION_FAILED', attempts, last_test_result: lastError.last_test_result });
  };
  const repair = async (user, current) => {
    const analysis = await analyze(user, current.url, current);
    const candidates = analysis.candidates.filter(c => c.type === current.type && (
      c.detection_method !== current.detection_method || c.target_element.selector !== current.target_element.selector ||
      JSON.stringify(c.extraction_rule) !== JSON.stringify(current.extraction_rule)
    ));
    if (!candidates.length) throw new Error('没有找到经过验证的替代区域，请选择网页元素');
    const built = await build(user, { type: current.type, name: current.name, condition: current.condition, interval: current.interval, candidate_id: candidates[0].id }, analysis, current);
    if (ruleSignature(built.rule) === ruleSignature(current)) throw new Error('页面暂时不可读取，原检测方式没有发生变化');
    return { rule: built.rule, reason: '发现页面结构变化。已找到新的' + built.rule.target_element.label + '并通过测试；确认后更新原任务。', previous_target: current.target_element, proposed_at: new Date().toISOString(), revision: current.revision || 0 };
  };
  return { observe, test, analyze, build, repair };
}
