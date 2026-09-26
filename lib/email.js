import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const CODE_TTL_MS = 10 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const HOURLY_LIMIT = 5;

export function createEmailCodeService({ apiKey = '', from = '', endpoint = 'https://api.resend.com/emails', fetcher = fetch } = {}) {
  const enabled = Boolean(apiKey && from);
  const secret = randomBytes(32);
  const challenges = new Map();
  const sendsByEmail = new Map();

  function keyFor(purpose, email, userId = '') {
    if (!['register', 'bind'].includes(purpose)) throw new Error('不支持的验证码用途');
    return `${purpose}:${userId}:${email}`;
  }

  function digest(key, code) {
    return createHmac('sha256', secret).update(`${key}:${code}`).digest();
  }

  async function send(purpose, email, userId = '') {
    if (!enabled) throw new Error('邮件验证码尚未启用：管理员需配置 RESEND_API_KEY 和 MAIL_FROM');
    const key = keyFor(purpose, email, userId);
    const now = Date.now();
    const existing = challenges.get(key);
    if (existing && now - existing.sentAt < RESEND_COOLDOWN_MS) throw new Error('验证码发送太频繁，请 60 秒后再试');
    const previous = existing?.expiresAt > now ? existing : null;
    for (const [address, timestamps] of sendsByEmail) {
      const active = timestamps.filter((at) => now - at < 60 * 60_000);
      if (active.length) sendsByEmail.set(address, active);
      else sendsByEmail.delete(address);
    }
    const recent = (sendsByEmail.get(email) || []).filter((at) => now - at < 60 * 60_000);
    if (recent.length >= HOURLY_LIMIT) throw new Error('该邮箱发送次数过多，请一小时后再试');
    for (const [itemKey, challenge] of challenges) if (challenge.expiresAt <= now) challenges.delete(itemKey);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const challenge = { digest: digest(key, code), sentAt: now, expiresAt: now + CODE_TTL_MS, attempts: 0 };
    challenges.set(key, challenge);
    const purposeLabel = purpose === 'register' ? '注册' : '绑定邮箱';
    try {
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [email], subject: `Webhook Radar ${purposeLabel}验证码`, text: `你的 ${purposeLabel}验证码是 ${code}。10 分钟内有效，请勿转发给他人。` }),
        signal: AbortSignal.timeout(10_000)
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.id) throw new Error(`邮件服务发送失败（HTTP ${response.status}）`);
      recent.push(now);
      sendsByEmail.set(email, recent);
      return { expiresInSeconds: CODE_TTL_MS / 1000, retryAfterSeconds: RESEND_COOLDOWN_MS / 1000 };
    } catch (error) {
      if (challenges.get(key) === challenge) {
        if (previous) challenges.set(key, previous);
        else challenges.delete(key);
      }
      if (error.message?.startsWith('邮件服务发送失败')) throw error;
      throw new Error('邮件服务连接失败，请稍后重试');
    }
  }

  function consume(purpose, email, code, userId = '') {
    const key = keyFor(purpose, email, userId);
    const challenge = challenges.get(key);
    if (!challenge || challenge.expiresAt <= Date.now()) {
      challenges.delete(key);
      throw new Error('验证码不存在或已过期，请重新发送');
    }
    const candidate = String(code || '').trim();
    const valid = /^\d{6}$/.test(candidate) && timingSafeEqual(digest(key, candidate), challenge.digest);
    if (!valid) {
      challenge.attempts += 1;
      if (challenge.attempts >= 5) challenges.delete(key);
      throw new Error('验证码错误，请检查后重试');
    }
    challenges.delete(key);
  }

  return { enabled, send, consume };
}
