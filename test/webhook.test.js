import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, createWebhookPayload, assertWebhookAccepted } from '../lib/webhook.js';

test('按渠道生成对应的文本消息格式', () => {
  const payload = { event: 'manual', title: '提醒', message: '内容', url: 'https://example.com/item' };
  assert.equal(detectFormat({ url: 'https://hooks.slack.com/services/example' }), 'slack');
  assert.equal(detectFormat({ url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x' }), 'wecom');
  assert.deepEqual(createWebhookPayload({ url: 'https://example.com', format: 'feishu' }, payload).body, { msg_type: 'text', content: { text: '提醒\n内容\nhttps://example.com/item' } });
  assert.deepEqual(createWebhookPayload({ url: 'https://example.com', format: 'dingtalk' }, payload).body, { msgtype: 'text', text: { content: '提醒\n内容\nhttps://example.com/item' } });
  assert.equal(createWebhookPayload({ url: 'https://example.com', format: 'discord' }, payload).body.content.includes('内容'), true);
});

test('HTTP 200 中的机器人业务错误仍视为失败', () => {
  assert.doesNotThrow(() => assertWebhookAccepted('wecom', '{"errcode":0,"errmsg":"ok"}'));
  assert.throws(() => assertWebhookAccepted('wecom', '{"errcode":93000,"errmsg":"bad webhook"}'), /bad webhook/);
  assert.throws(() => assertWebhookAccepted('feishu', '{"code":19001,"msg":"invalid"}'), /invalid/);
});

test('ntfy 使用渠道默认优先级，单条通知可覆盖', () => {
  const hook = { url: 'https://ntfy.sh/my-topic', priority: 4 };
  assert.equal(detectFormat(hook), 'ntfy');
  const formatted = createWebhookPayload(hook, { title: '提醒', message: '内容' });
  assert.equal(formatted.headers['x-priority'], '4');
  assert.equal(Buffer.from(formatted.headers['x-title'].slice(10, -2), 'base64').toString(), '提醒');
  assert.equal(formatted.body, '内容');
  assert.equal(createWebhookPayload(hook, { title: '提醒', message: '内容', priority: 5 }).headers['x-priority'], '5');
  assert.throws(() => createWebhookPayload(hook, { title: '提醒', message: '内容', priority: 9 }), /1 到 5/);
});
