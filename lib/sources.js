import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const MAX_LOG_READ = 1_000_000;

export function validateLocalSource(sourceType, input) {
  const value = String(input || '').trim();
  if (sourceType === 'log') {
    const relative = value.startsWith('log:') ? value.slice(4) : value;
    if (!relative || relative.length > 240 || !/^[\p{L}\p{N}._/ -]+$/u.test(relative) || relative.startsWith('/') || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('日志来源请填写账户日志目录内的相对路径，例如 log:app.log');
    }
    return `log:${relative}`;
  }
  if (sourceType === 'service' && value.toLowerCase().startsWith('tcp://')) {
    let target;
    try { target = new URL(value); } catch { throw new Error('TCP 服务地址无效'); }
    if (target.protocol !== 'tcp:' || !target.hostname || !target.port || target.username || target.password || target.search || target.hash || !['', '/'].includes(target.pathname)) throw new Error('TCP 服务请使用 tcp://主机:端口');
    return `tcp://${target.host}`;
  }
  return null;
}

export function userLogDirectory(logRoot, user) {
  return path.join(logRoot, user.id);
}

function inside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveLogFile(logRoot, user, source) {
  const relative = validateLocalSource('log', source).slice(4);
  fs.mkdirSync(logRoot, { recursive: true });
  const accountDir = userLogDirectory(logRoot, user);
  fs.mkdirSync(accountDir, { recursive: true });
  const realRoot = fs.realpathSync(logRoot);
  const realAccountDir = fs.realpathSync(accountDir);
  if (!inside(realRoot, realAccountDir)) throw new Error('账户日志目录超出允许范围');
  const target = path.join(realAccountDir, ...relative.split('/'));
  let realFile;
  try { realFile = fs.realpathSync(target); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`日志文件不存在：${relative}`); throw error; }
  if (!inside(realAccountDir, realFile)) throw new Error('日志文件超出账户目录');
  const stat = fs.statSync(realFile);
  if (!stat.isFile()) throw new Error('日志来源不是普通文件');
  return { realFile, stat };
}

export function inspectLog(logRoot, user, monitor, previous = null, preview = false) {
  const { realFile, stat } = resolveLogFile(logRoot, user, monitor.url);
  const fileId = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  const first = !previous;
  const fromBaseline = first && monitor.plan.initial !== 'notify' && !preview;
  let start = fromBaseline ? stat.size : first || previous.fileId !== fileId || stat.size < previous.offset ? Math.max(0, stat.size - 128_000) : previous.offset;
  let skipped = 0;
  if (stat.size - start > MAX_LOG_READ) {
    skipped = stat.size - start - MAX_LOG_READ;
    start = stat.size - MAX_LOG_READ;
  }
  const size = stat.size - start;
  const buffer = Buffer.alloc(size);
  let bytesRead = 0;
  if (size) {
    const fd = fs.openSync(realFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try { bytesRead = fs.readSync(fd, buffer, 0, size, start); } finally { fs.closeSync(fd); }
  }
  const text = `${!first && start === previous.offset ? previous.carry || '' : ''}${buffer.subarray(0, bytesRead).toString('utf8')}`;
  const lines = text.split(/\r?\n/);
  let carry = '';
  if (text.endsWith('\n')) lines.pop();
  else carry = lines.pop()?.slice(-4000) || '';
  if (preview && carry) lines.push(carry);
  const keyword = monitor.plan.caseSensitive ? monitor.plan.keyword : monitor.plan.keyword.toLocaleLowerCase();
  const matches = lines.filter((line) => (monitor.plan.caseSensitive ? line : line.toLocaleLowerCase()).includes(keyword));
  const sample = matches.slice(-2).map((line) => line.trim().slice(0, 150)).join(' | ');
  const summary = fromBaseline ? '已记录日志末尾位置，后续只检查新增内容' : `新增 ${lines.length} 行，匹配 ${matches.length} 行${sample ? `：${sample}` : ''}${skipped ? `；跳过较早的 ${skipped} 字节` : ''}`;
  return { fileId, offset: start + bytesRead, carry, matches: matches.length, summary };
}

async function inspectTcp(source, timeoutMs) {
  const target = new URL(source);
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port) });
    let settled = false;
    const finish = (healthy, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ healthy, detail, latencyMs: Date.now() - started });
    };
    socket.setTimeout(timeoutMs, () => finish(false, '连接超时'));
    socket.once('connect', () => finish(true, 'TCP 已连接'));
    socket.once('error', (error) => finish(false, error.code || error.message));
  });
}

export async function inspectService(source, plan) {
  const timeoutMs = plan.mode === 'slow' ? Math.min(30_000, Math.max(5000, plan.thresholdMs + 1000)) : 5000;
  let status;
  if (source.startsWith('tcp://')) status = await inspectTcp(source, timeoutMs);
  else {
    const started = Date.now();
    try {
      const response = await fetch(source, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'WebhookRadar/2.0' } });
      try { await response.body?.cancel(); } catch { /* status is already available */ }
      status = { healthy: response.status >= 200 && response.status < 400, detail: `HTTP ${response.status}`, latencyMs: Date.now() - started, httpStatus: response.status };
    } catch (error) {
      status = { healthy: false, detail: error.cause?.code || error.name || '连接失败', latencyMs: Date.now() - started };
    }
  }
  const matched = plan.mode === 'unavailable' ? !status.healthy : plan.mode === 'available' ? status.healthy : !status.healthy || status.latencyMs > plan.thresholdMs;
  return { matched, healthy: status.healthy, latencyMs: status.latencyMs, httpStatus: status.httpStatus || null, summary: `${status.healthy ? '可用' : '不可用'} · ${status.detail} · ${status.latencyMs} ms` };
}
