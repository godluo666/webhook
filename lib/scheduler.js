// A min-heap contains only scheduled tasks. Updates replace an existing heap item,
// so repeated edits do not accumulate stale entries. No periodic full-state scan.
export function createScheduler({ run, now = Date.now, concurrency = 16, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const heap = [], indexes = new Map(), running = new Set();
  let timer = null, stopped = false;
  const swap = (a, b) => { [heap[a], heap[b]] = [heap[b], heap[a]]; indexes.set(heap[a].id, a); indexes.set(heap[b].id, b); };
  const up = index => { while (index > 0) { const parent = (index - 1) >> 1; if (heap[parent].at <= heap[index].at) break; swap(parent, index); index = parent; } return index; };
  const down = index => {
    while (true) {
      const left = index * 2 + 1, right = left + 1;
      let smallest = index;
      if (left < heap.length && heap[left].at < heap[smallest].at) smallest = left;
      if (right < heap.length && heap[right].at < heap[smallest].at) smallest = right;
      if (smallest === index) break;
      swap(index, smallest); index = smallest;
    }
  };
  const remove = id => {
    const index = indexes.get(id);
    if (index == null) return;
    indexes.delete(id);
    const last = heap.pop();
    if (index < heap.length) { heap[index] = last; indexes.set(last.id, index); down(up(index)); }
  };
  const arm = () => {
    if (timer) clearTimer(timer);
    timer = null;
    if (stopped || !heap.length || running.size >= concurrency) return;
    const delay = Math.max(0, Math.min(2_147_483_647, heap[0].at - now()));
    timer = setTimer(tick, delay);
    timer?.unref?.();
  };
  function schedule(id, at, task) {
    remove(id);
    const timestamp = typeof at === 'number' ? at : Date.parse(at);
    if (stopped || !Number.isFinite(timestamp)) { arm(); return; }
    const entry = { id, at: timestamp, task };
    indexes.set(id, heap.length); heap.push(entry); up(heap.length - 1); arm();
  }
  function cancel(id) { remove(id); arm(); }
  function tick() {
    timer = null;
    while (heap.length && heap[0].at <= now() && running.size < concurrency) {
      const entry = heap[0]; remove(entry.id);
      if (running.has(entry.id)) { schedule(entry.id, now() + 100, entry.task); continue; }
      running.add(entry.id);
      Promise.resolve().then(() => run(entry.task)).catch(() => {}).finally(() => { running.delete(entry.id); arm(); });
    }
    arm();
  }
  return { schedule, cancel, stop() { stopped = true; if (timer) clearTimer(timer); timer = null; heap.length = 0; indexes.clear(); }, get size() { return heap.length; }, get active() { return running.size; } };
}
