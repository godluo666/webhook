export const WEBHOOK_FORMATS = ['auto', 'generic', 'slack', 'discord', 'wecom', 'feishu', 'dingtalk', 'ntfy'];

export function detectFormat(hook) {
  if (hook.format && hook.format !== 'auto') return hook.format;
  const hostname = new URL(hook.url).hostname.toLowerCase();
  if (hostname === 'hooks.slack.com' || hostname === 'hooks.slack-gov.com') return 'slack';
  if (['discord.com', 'discordapp.com'].includes(hostname)) return 'discord';
  if (hostname === 'qyapi.weixin.qq.com') return 'wecom';
  if (hostname === 'open.feishu.cn' || hostname === 'open.larksuite.com') return 'feishu';
  if (hostname === 'oapi.dingtalk.com') return 'dingtalk';
  if (hostname === 'ntfy.sh') return 'ntfy';
  return 'generic';
}

export function createWebhookPayload(hook, payload) {
  const format = detectFormat(hook);
  const content = `${payload.title}\n${payload.message}${payload.url ? `\n${payload.url}` : ''}`;
  if (format === 'ntfy') {
    const priority = payload.priority == null || payload.priority === '' ? (hook.priority ?? 3) : Number(payload.priority);
    if (!Number.isInteger(Number(priority)) || priority < 1 || priority > 5) throw new Error('ntfy 优先级必须在 1 到 5 之间');
    const title = `=?UTF-8?B?${Buffer.from(payload.title).toString('base64')}?=`;
    return { format, body: `${payload.message}${payload.url ? `\n${payload.url}` : ''}`, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-title': title, 'x-priority': String(priority) } };
  }
  if (format === 'slack') return { format, body: { text: content } };
  if (format === 'discord') {
    if (content.length > 2000) throw new Error('Discord 消息超过 2000 字符，请缩短内容');
    return { format, body: { content } };
  }
  if (format === 'wecom' || format === 'dingtalk') return { format, body: { msgtype: 'text', text: { content } } };
  if (format === 'feishu') return { format, body: { msg_type: 'text', content: { text: content } } };
  return { format, body: { ...payload, content, text: content, timestamp: new Date().toISOString() } };
}

export function assertWebhookAccepted(format, responseText) {
  if (!['wecom', 'feishu', 'dingtalk'].includes(format) || !responseText.trim()) return;
  let data;
  try { data = JSON.parse(responseText); } catch { throw new Error('渠道返回了无法识别的结果'); }
  const code = format === 'feishu' ? data.code ?? data.StatusCode : data.errcode;
  if (code == null) throw new Error('渠道未返回明确的发送结果');
  if (Number(code) !== 0) throw new Error(String(data.msg || data.errmsg || data.StatusMessage || `错误码 ${code}`));
}
