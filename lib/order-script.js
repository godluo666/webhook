import { newAsyncContext } from 'quickjs-emscripten';

// Generated JavaScript runs in a separate WebAssembly interpreter. It has no
// Node globals, filesystem, network, imports or unrestricted page evaluation.
export async function executeOrderScript(code, order, methods, { timeoutMs = 60_000, maxCalls = 80, cpuTimeoutMs = 1000 } = {}) {
  if (typeof code !== 'string' || !code.trim() || code.length > 24_000) throw new Error('AI 下单代码为空或过长');
  const vm = await newAsyncContext();
  const deadline = Date.now() + timeoutMs;
  let cpuDeadline = Date.now() + cpuTimeoutMs;
  vm.runtime.setMemoryLimit(24 * 1024 * 1024);
  vm.runtime.setMaxStackSize(512 * 1024);
  vm.runtime.setInterruptHandler(() => Date.now() >= deadline || Date.now() >= cpuDeadline);
  let calls = 0;
  try {
    const api = vm.newObject();
    for (const [name, operation] of Object.entries(methods)) {
      const fn = vm.newAsyncifiedFunction(name, async (...handles) => {
        if (++calls > maxCalls || Date.now() >= deadline) throw new Error('下单程序超出执行时间或操作次数');
        const args = handles.map(handle => vm.dump(handle));
        const value = await operation(...args);
        if (Date.now() >= deadline) throw new Error('下单程序执行超时');
        cpuDeadline = Date.now() + cpuTimeoutMs;
        const json = JSON.stringify(value ?? null);
        if (json.length > 80_000) throw new Error('页面返回内容过大');
        return vm.unwrapResult(vm.evalCode('JSON.parse(' + JSON.stringify(json) + ')'));
      });
      vm.setProp(api, name, fn); fn.dispose();
    }
    vm.setProp(vm.global, 'browser', api); api.dispose();
    const input = vm.unwrapResult(vm.evalCode('JSON.parse(' + JSON.stringify(JSON.stringify(order)) + ')'));
    vm.setProp(vm.global, 'order', input); input.dispose();
    const result = await vm.evalCodeAsync('"use strict"; const run = (' + code + '); JSON.stringify(run(order, browser))', 'ai-order.js');
    if (result.error) { const failure = vm.dump(result.error); result.error.dispose(); throw new Error('下单代码执行失败：' + (failure.message || String(failure))); }
    const raw = vm.getString(result.value); result.value.dispose();
    if (!raw || raw.length > 20_000) throw new Error('下单代码没有返回有效结果');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('下单代码结果格式错误');
    return value;
  } finally { vm.dispose(); }
}
