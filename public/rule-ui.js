let preferredMonitorType = 'webpage_change';
const ruleTypeNames = { product_stock: '商品库存', price_change: '价格变化', webpage_change: '网页变化', api_monitor: '接口状态' };
const ruleMethodNames = { html: '页面内容', dom: '网页区域', json: '商品 JSON 数据', api: '数据接口', browser: '浏览器渲染页面' };
function ruleValue(value) { return ({ in_stock: '有货', out_of_stock: '无货', healthy: '正常', unhealthy: '异常' })[value] || String(value ?? '尚未检测'); }
function unifiedDescription(monitor) {
  const c = monitor.condition || {};
  if (monitor.extraction_rule?.kind === 'stock_items') return c.operator === 'transition' ? '任一型号从「' + (c.from || []).map(ruleValue).join('、') + '」变为「' + (c.to || []).map(ruleValue).join('、') + '」时提醒' : c.operator === 'equals' ? '任一型号' + ruleValue(c.value) + '时提醒' : '任一型号库存变化时提醒';
  if (c.operator === 'transition') return '从「' + (c.from || []).map(ruleValue).join('、') + '」变为「' + (c.to || []).map(ruleValue).join('、') + '」时提醒';
  if (c.operator === 'changed') return ruleTypeNames[monitor.type] + '变化时提醒';
  if (c.operator === 'unavailable') return '连续 ' + (c.failure_threshold || 1) + ' 次访问异常时提醒';
  if (c.operator === 'available') return '恢复正常时提醒';
  if (c.operator === 'slow') return '响应超过 ' + c.value / 1000 + ' 秒时提醒';
  return (monitor.type === 'price_change' ? '价格' : '关注内容') + ({ lt: '低于', lte: '不高于', gt: '超过', gte: '达到', equals: '等于', notEquals: '不等于', contains: '包含', absent: '不再包含' })[c.operator] + '「' + ruleValue(c.value) + '」时提醒';
}
function unifiedSummary(monitor) {
  const test = monitor.last_test_result;
  return '<div class="rule-evidence"><div><span>监控目标</span><strong>' + escapeHtml(ruleTypeNames[monitor.type]) + '</strong></div><div><span>检测方式</span><strong>' + escapeHtml(monitor.target_element?.label || ruleMethodNames[monitor.detection_method]) + '</strong></div><div><span>当前状态</span><strong>' + escapeHtml(monitor.snapshot?.items ? monitor.snapshot.summary : test?.snapshot?.items ? test.summary : ruleValue(monitor.snapshot?.value ?? test?.current_value)) + '</strong></div><div><span>验证结果</span><strong>' + (test?.passed ? '已通过 ' + (Object.keys(test.checks || {}).length + (test.behavior_tests?.length || 0)) + ' 项验证 · 依据评分 ' + Math.round(monitor.confidence * 100) + '%' : '等待验证') + '</strong></div></div>' + (monitor.explanation ? '<p class="field-help">' + escapeHtml(monitor.explanation) + '</p>' : '');
}
function ruleValidationSummary(monitor) {
  const tests = monitor.last_test_result?.behavior_tests;
  if (!tests?.length) return '';
  return '<details class="rule-validation"><summary>查看提醒条件的 ' + tests.length + ' 项场景验证</summary><ul>' + tests.map(test => '<li>' + (test.passed ? '已通过：' : '未通过：') + escapeHtml(test.name) + '</li>').join('') + '</ul><p class="field-help">这些条件测试使用模拟状态，不代表商品实际补货。上方当前库存和原文来自实际抓取。</p></details>';
}
function stockModelSummary(monitor, open = false) {
  const items = monitor.snapshot?.items || monitor.last_test_result?.snapshot?.items;
  if (!items?.length) return '';
  return '<details class="stock-models" ' + (open ? 'open' : '') + '><summary>查看 ' + items.length + ' 个型号的库存</summary><ul>' + items.map(item => '<li><span>' + escapeHtml(item.name) + '</span><strong class="' + (item.state === 'in_stock' ? 'available' : '') + '">' + escapeHtml(ruleValue(item.state)) + '</strong><small>' + escapeHtml(item.raw_value) + '</small></li>').join('') + '</ul></details>';
}
function unifiedConditionFields(monitor) {
  const c = monitor.condition || {};
  const options = {
    product_stock: [['transition', '由无货变为有货'], ['equals', '当前有货时'], ['changed', '库存状态有变化']],
    price_change: [['lt', '价格低于'], ['lte', '价格不高于'], ['gt', '价格超过'], ['gte', '价格达到'], ['changed', '价格有变化']],
    webpage_change: [['changed', '关注区域有变化'], ['contains', '出现这些文字'], ['absent', '不再出现这些文字'], ['equals', '内容等于'], ['notEquals', '内容不等于'], ['transition', '从指定内容变为另一内容']],
    api_monitor: monitor.extraction_rule?.kind === 'service' ? [['unavailable', '接口访问异常'], ['available', '接口恢复正常'], ['slow', '接口响应太慢']]
      : [['changed', '接口数据有变化'], ['equals', '数据等于'], ['notEquals', '数据不等于'], ['contains', '数据包含'], ['lt', '数值低于'], ['gt', '数值超过']]
  };
  const select = (label, key, value, values) => '<label>' + label + '<select data-unified-key="' + key + '">' + values.map(([id, name]) => '<option value="' + id + '" ' + (id === value ? 'selected' : '') + '>' + name + '</option>').join('') + '</select></label>';
  const input = (label, key, value, type = 'text', attr = '') => '<label>' + label + '<input data-unified-key="' + key + '" type="' + type + '" value="' + escapeHtml(value ?? '') + '" ' + attr + '></label>';
  let fields = select('监控目标', 'type', monitor.type, Object.entries(ruleTypeNames))
    + select('什么时候提醒', 'condition.operator', c.operator, options[monitor.type] || []);
  if (monitor.type === 'product_stock' && c.operator === 'equals') fields += select('希望看到的状态', 'condition.value', c.value, [['in_stock', '有货'], ['out_of_stock', '无货']]);
  else if (['lt', 'lte', 'gt', 'gte'].includes(c.operator)) fields += input('达到这个数值时提醒', 'condition.value', c.value, 'number', 'step="any"');
  else if (['equals', 'notEquals', 'contains', 'absent'].includes(c.operator)) fields += input('要关注的内容', 'condition.value', c.value);
  else if (c.operator === 'slow') fields += input('响应超过多少毫秒', 'condition.value', c.value, 'number', 'min="100"');
  else if (c.operator === 'unavailable') fields += input('连续失败几次', 'condition.failure_threshold', c.failure_threshold || 1, 'number', 'min="1" max="10"');
  else if (c.operator === 'transition' && monitor.type !== 'product_stock') {
    fields += input('之前的内容（逗号分隔）', 'condition.from', (c.from || []).join(', '), 'text', 'data-unified-array')
      + input('变成这些内容时提醒', 'condition.to', (c.to || []).join(', '), 'text', 'data-unified-array');
  }
  if (!['changed', 'transition'].includes(c.operator)) fields += select('第一次检查', 'condition.initial', c.initial, [['baseline', '先记录，之后满足条件再提醒'], ['notify', '已经满足也提醒我']]);
  return fields;
}
function unifiedRuleEditor(monitor) {
  const editable = { type: monitor.type, detection_method: monitor.detection_method, target_element: monitor.target_element, extraction_rule: monitor.extraction_rule, condition: monitor.condition };
  return '<div class="unified-rule-editor editor-wide">' + unifiedSummary(monitor) + ruleValidationSummary(monitor) + stockModelSummary(monitor) + '<div class="unified-basic-fields rule-fields">' + unifiedConditionFields(monitor) + '</div>'
    + '<div class="element-actions"><button type="button" class="button button-outline" data-rule-analyze>重新分析目标</button><button type="button" class="button button-outline" data-rule-pick>选择网页元素</button></div><p class="field-help">选择价格、库存或购买按钮。更换监控目标后，请重新分析或选择区域；保存前自动验证。</p>'
    + '<details class="advanced-plan"><summary>高级设置 · 网页区域与数据字段</summary><p class="field-help">selector、XPath、API 字段和 JSON 路径保存在统一配置中。通常无需修改。</p><textarea class="unified-json" rows="10" spellcheck="false">' + escapeHtml(JSON.stringify(editable, null, 2)) + '</textarea><p class="unified-error" role="status"></p></details></div>';
}
function readUnifiedRule(root) {
  const editor = root.querySelector('.unified-rule-editor') || root.closest('.unified-rule-editor');
  if (!editor) throw new Error('未找到监控规则编辑区域');
  try { return JSON.parse(editor.querySelector('.unified-json').value); }
  catch { throw new Error('高级配置尚未填写完整，请检查后再保存'); }
}
document.addEventListener('input', event => {
  const editor = event.target.closest('.unified-rule-editor');
  if (!editor) return;
  const raw = editor.querySelector('.unified-json'), error = editor.querySelector('.unified-error');
  try {
    const rule = JSON.parse(raw.value);
    const key = event.target.dataset.unifiedKey;
    if (key) {
      const parts = key.split('.'), property = parts.pop();
      const target = parts.reduce((value, k) => value[k], rule);
      let value = event.target.type === 'number' ? Number(event.target.value) : event.target.hasAttribute('data-unified-array') ? event.target.value.split(/[,，]/).map(x => x.trim()).filter(Boolean) : event.target.value;
      target[property] = value;
      if (key === 'type') rule.condition = { operator: value === 'product_stock' ? 'transition' : value === 'api_monitor' ? 'unavailable' : 'changed', initial: 'baseline', ...(value === 'product_stock' ? { from: ['out_of_stock'], to: ['in_stock'] } : value === 'api_monitor' ? { failure_threshold: 1 } : {}) };
      if (key === 'condition.operator') {
        if (value === 'transition' && rule.type === 'product_stock') Object.assign(rule.condition, { from: ['out_of_stock'], to: ['in_stock'], initial: 'baseline' });
        if (value === 'equals' && rule.type === 'product_stock') rule.condition.value = 'in_stock';
        if (['lt', 'lte', 'gt', 'gte'].includes(value)) rule.condition.value = Number(rule.condition.value) || 100;
        if (value === 'slow') rule.condition.value = 3000;
        if (value === 'unavailable') rule.condition.failure_threshold = 1;
        if (['contains', 'absent'].includes(value)) rule.condition.value ??= '';
      }
      raw.value = JSON.stringify(rule, null, 2);
      if (key === 'type' || key === 'condition.operator') editor.querySelector('.unified-basic-fields').innerHTML = unifiedConditionFields(rule);
    } else if (event.target === raw) editor.querySelector('.unified-basic-fields').innerHTML = unifiedConditionFields(rule);
    error.textContent = '';
    editor.dispatchEvent(new CustomEvent('rule-plan-updated', { bubbles: true }));
  } catch (failure) { error.textContent = '配置尚未完整：' + failure.message; }
});
function ruleDialog(title) {
  const dialog = document.createElement('dialog');
  dialog.className = 'rule-dialog';
  dialog.setAttribute('aria-label', title);
  dialog.innerHTML = '<header><h2>' + escapeHtml(title) + '</h2><button type="button" class="mini-button" data-rule-close>关闭</button></header><div class="rule-dialog-body"></div>';
  dialog.addEventListener('click', event => { if (event.target.closest('[data-rule-close]')) dialog.close(); });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
async function openElementPicker(monitor, onSelected) {
  const dialog = ruleDialog('选择网页元素');
  const body = dialog.querySelector('.rule-dialog-body');
  body.innerHTML = '<p class="field-help">点击页面中的价格、库存或购买按钮。下面是服务端使用此任务出口读取的文字快照，绿色框为当前检测区域。页面语言可能随出口变化，请核对原文；选择后会重新读取并验证。</p><label><input type="checkbox" class="picker-browser"> 等待动态页面渲染</label><button type="button" class="mini-button" data-picker-load>重新加载页面</button><p class="picker-status" role="status">正在读取页面…</p><iframe class="element-frame" title="可选择的网页区域" sandbox="allow-same-origin"></iframe>' + (monitor.type === 'product_stock' ? '<label class="picker-scope-label hidden">监控范围<select class="picker-scope"><option value="all_models">同类全部型号（任意型号有货即可提醒）</option><option value="single">只监控点选的这个型号</option></select></label><p class="picker-scope-help field-help"></p>' : '') + '<button type="button" class="button button-primary" data-picker-confirm disabled>使用所选区域</button>';
  const frame = body.querySelector('iframe'), status = body.querySelector('.picker-status'), confirm = body.querySelector('[data-picker-confirm]');
  body.querySelector('.picker-browser').checked = monitor.detection_method === 'browser' || monitor.fetch?.mode === 'browser';
  let preview, selected = null;
  const reload = async () => {
    selected = null; confirm.disabled = true; status.textContent = '正在读取页面…';
    body.querySelector('.picker-scope-label')?.classList.add('hidden');
    const help = body.querySelector('.picker-scope-help'); if (help) help.textContent = '';
    preview = await api('/api/element-preview', 'POST', { monitorId: monitor.id || undefined, url: monitor.url, rule: monitor, browser: body.querySelector('.picker-browser').checked });
    if (monitor.label === '网页区域监控' && preview.title) monitor.label = preview.title;
    frame.onload = () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      doc.addEventListener('click', event => {
        event.preventDefault();
        const target = event.target.closest('[data-radar-element]');
        if (!target) return;
        doc.querySelectorAll('.radar-selected').forEach(element => element.classList.remove('radar-selected'));
        target.classList.add('radar-selected');
        selected = Number(target.dataset.radarElement);
        status.textContent = '已选择：' + (target.textContent || target.value || '').trim().slice(0, 180);
        const collection = preview.collections?.find(item => item.index === selected);
        const scope = body.querySelector('.picker-scope');
        if (scope) {
          scope.closest('label').classList.toggle('hidden', !collection);
          const requireCollection = monitor.extraction_rule?.kind === 'stock_items';
          scope.value = collection ? 'all_models' : 'single';
          body.querySelector('.picker-scope-help').textContent = collection ? '已识别 ' + collection.count + ' 个型号。默认保留全部型号的监控范围；也可选择仅监控一个。' : requireCollection ? '当前是全部型号的监控任务。请选择某个型号的库存文字，以保留监控范围。' : '当前选择仅用于这个区域。';
          confirm.disabled = requireCollection && !collection;
        } else confirm.disabled = false;
      });
    };
    frame.srcdoc = preview.html;
    status.textContent = preview.count ? '页面已加载 · ' + (preview.fetch?.route === 'proxy' ? '任务代理出口' : '服务端出口') + ' · ' + (preview.language || '语言由来源决定') + ' · 当前标记 ' + preview.highlighted + ' 个区域。点击要关注的区域。' : '页面中没有可选区域，可以勾选动态页面渲染后重试。';
  };
  body.querySelector('[data-picker-load]').onclick = () => withButton(body.querySelector('[data-picker-load]'), reload);
  confirm.onclick = () => withButton(confirm, async () => {
    const result = await api('/api/select-element', 'POST', { monitorId: monitor.id || undefined, previewId: preview.id, index: selected, scope: body.querySelector('.picker-scope')?.value || 'single', type: monitor.type || 'webpage_change', rule: monitor });
    onSelected({ ...monitor, ...result.monitor, id: monitor.id });
    dialog.close();
  });
  try { await reload(); } catch (error) { status.textContent = error.message; }
}
async function showRuleLogs(monitor) {
  const dialog = ruleDialog('检测记录 · ' + monitor.label), body = dialog.querySelector('.rule-dialog-body');
  body.textContent = '正在读取检测记录…';
  const data = await api('/api/monitors/' + encodeURIComponent(monitor.id) + '/logs');
  body.innerHTML = data.logs.length ? data.logs.map(log => '<article class="check-record"><strong>' + escapeHtml(new Date(log.at).toLocaleString('zh-CN')) + ' · ' + (log.status === 'error' ? '失败' : '成功') + '</strong><p>' + escapeHtml(log.detail) + '</p>' + (log.raw?.current_value != null ? '<p>当前值：' + escapeHtml(ruleValue(log.raw.current_value)) + '</p>' : '') + (log.raw?.previous_value != null ? '<p>之前：' + escapeHtml(ruleValue(log.raw.previous_value)) + '</p>' : '') + (log.raw?.reason ? '<p>' + escapeHtml(log.raw.reason) + '</p>' : '') + '</article>').join('') : '<p>暂无检测记录。</p>';
}
async function showRuleRepair(monitor) {
  const dialog = ruleDialog('修复规则 · ' + monitor.label), body = dialog.querySelector('.rule-dialog-body');
  body.textContent = '正在重新分析页面并验证替代区域…';
  const proposal = monitor.repair_suggestion || await api('/api/monitors/' + encodeURIComponent(monitor.id) + '/repair', 'POST');
  body.innerHTML = '<p>' + escapeHtml(proposal.reason) + '</p><p>原区域：' + escapeHtml(proposal.previous_target?.selector || monitor.target_element?.label || '原检测方式') + '</p><p>新区域：' + escapeHtml(proposal.rule.target_element?.selector || proposal.rule.target_element?.label) + '</p>' + unifiedSummary(proposal.rule) + '<p class="field-help">更新原任务，保留通知渠道、频率和检测记录。</p><button type="button" class="button button-primary" data-repair-apply>确认更新原规则</button>';
  const button = body.querySelector('[data-repair-apply]');
  button.onclick = () => withButton(button, async () => {
    appState = await api('/api/monitors/' + encodeURIComponent(monitor.id), 'PATCH', { rule: proposal.rule, expectedRevision: proposal.revision });
    render(true, monitor.id); dialog.close(); toast('原任务已修复');
  });
}
function unifiedTaskActions(monitor) {
  return '<button class="mini-button" data-action="rule-logs" data-id="' + escapeHtml(monitor.id) + '">检测记录</button>' + (monitor.kind === 'unified' ? '<button class="mini-button" data-action="rule-repair" data-id="' + escapeHtml(monitor.id) + '">' + (monitor.repair_suggestion ? '查看修复建议' : '重新分析与修复') + '</button>' : '');
}
document.addEventListener('click', event => {
  const preset = event.target.closest('[data-interval-preset]');
  if (preset) {
    const label = preset.closest('label'), seconds = Number(preset.dataset.intervalPreset);
    const input = label.querySelector('input'), unit = label.querySelector('.interval-unit');
    unit.value = seconds < 60 ? 'seconds' : 'minutes';
    input.value = seconds < 60 ? seconds : seconds / 60;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    unit.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const createPick = event.target.closest('#create-pick-element');
  if (createPick) {
    const url = $('#instruction-url').value.trim();
    if (!url) { toast('请先粘贴商品或网页链接', true); $('#instruction-url').focus(); return; }
    const type = preferredMonitorType, text = $('#instruction').value;
    const price = text.match(/(?:低于|小于|不高于)\s*(\d+(?:\.\d+)?)/);
    const condition = type === 'product_stock' ? { operator: 'transition', from: ['out_of_stock'], to: ['in_stock'], initial: 'baseline' }
      : type === 'price_change' && price ? { operator: 'lt', value: Number(price[1]), initial: 'baseline' } : { operator: 'changed', initial: 'baseline' };
    if (type === 'api_monitor') { toast('接口状态可以直接生成方案；网页元素选择适用于库存、价格和网页变化', true); return; }
    let routing;
    try { routing = readCreateSourceSettings(); } catch (error) { toast(error.message, true); return; }
    const draft = { ...routing, kind: 'unified', type, url, label: '网页区域监控', condition, interval: type === 'product_stock' ? 30 : 300,
      notification: { title: type === 'product_stock' ? '库存变化提醒 · {{name}}' : type === 'price_change' ? '价格提醒 · {{name}}' : '{{name}}', body: '{{details}}\n时间：{{time}}\n链接：{{source}}' } };
    openElementPicker(draft, rule => {
      previewMonitor = rule; renderPreview(rule); assistantPhase('ready'); location.hash = '#create';
      testPreviewSource(true).catch(error => toast(error.message, true));
    }).catch(error => toast(error.message, true));
  }
  const quick = event.target.closest('[data-monitor-type]');
  if (quick) {
    const type = quick.dataset.monitorType;
    preferredMonitorType = type;
    $('#instruction').value = ({ product_stock: '帮我监控这个商品什么时候有货', price_change: '帮我监控这个商品的价格变化', webpage_change: '这个网页有变化提醒我', api_monitor: '这个接口异常通知我' })[type];
    $('#instruction-url').focus(); location.hash = '#create';
  }
  const action = event.target.closest('button[data-action="rule-logs"],button[data-action="rule-repair"]');
  if (action) {
    const monitor = appState.monitors.find(m => m.id === action.dataset.id);
    if (monitor) withButton(action, () => action.dataset.action === 'rule-logs' ? showRuleLogs(monitor) : showRuleRepair(monitor));
  }
  const sourcePreview = event.target.closest('[data-source-preview]');
  if (sourcePreview) {
    const current = collectPreviewRule();
    openElementPicker(current, rule => { previewMonitor = { ...current, ...rule }; renderPreview(previewMonitor); testPreviewSource(true).catch(error => toast(error.message, true)); }).catch(error => toast(error.message, true));
    return;
  }
  const button = event.target.closest('[data-rule-pick],[data-rule-analyze]');
  if (!button) return;
  const editor = button.closest('.unified-rule-editor'), task = button.closest('.monitor-route');
  const original = task ? appState.monitors.find(m => m.id === task.dataset.id) : previewMonitor;
  const edited = task ? readSavedRule(task, original) : null;
  const current = task ? { ...original, ...edited.rule, webhookIds: edited.webhookIds } : collectPreviewRule();
  const apply = rule => {
    editor.outerHTML = unifiedRuleEditor(rule);
    if (!task) {
      previewMonitor = { ...current, ...rule };
      renderPreview(previewMonitor);
      $('#preview .rule-editor').open = true;
      const conditionsTab = $('#preview [data-editor-tab="1"]');
      if (conditionsTab) selectRuleTab(conditionsTab);
      renderRevisionDiff();
    }
    toast('检测区域已验证，保存后生效');
  };
  if (button.hasAttribute('data-rule-pick')) openElementPicker(current, apply).catch(error => toast(error.message, true));
  else withButton(button, async () => {
    const data = await api('/api/analyze', 'POST', { monitorId: original.id || undefined, url: current.url, type: current.type, condition: current.condition, rule: current });
    apply({ ...current, ...data.monitor });
  });
});
