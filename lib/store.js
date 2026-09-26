import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';

const SESSION_SECONDS = 7 * 24 * 60 * 60;

function migrateSettings(settings = {}) {
  const migrated = { ...settings };
  if (!Array.isArray(migrated.webhooks)) {
    migrated.webhooks = migrated.webhookUrl ? [{ id: randomUUID(), name: '默认 Webhook', url: migrated.webhookUrl, enabled: true, format: 'auto' }] : [];
  }
  delete migrated.webhookUrl;
  migrated.aiBaseUrl ||= 'https://api.openai.com/v1';
  migrated.aiModel ||= '';
  migrated.aiKey ||= '';
  return migrated;
}

function migrateWorkspace(saved = {}) {
  const settings = migrateSettings(saved.settings);
  const monitors = Array.isArray(saved.monitors) ? saved.monitors : [];
  for (const monitor of monitors) {
    if (!Array.isArray(monitor.webhookIds)) monitor.webhookIds = settings.webhooks.map((hook) => hook.id);
    if (!Array.isArray(monitor.pendingNotifications)) monitor.pendingNotifications = [];
  }
  return { settings, monitors, events: Array.isArray(saved.events) ? saved.events : [], logs: Array.isArray(saved.logs) ? saved.logs : [], sentCount: saved.sentCount || 0 };
}

export function createStore(dataDir) {
  const dataFile = path.join(dataDir, 'state.json');
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(dataFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const state = saved?.users
    ? { ...saved, users: saved.users.map((user) => ({ ...user, ...migrateWorkspace(user) })) }
    : {
        users: [],
        legacyUnclaimed: saved ? migrateWorkspace(saved) : null,
        legacyClaimToken: saved ? randomBytes(18).toString('hex') : null,
        sessionSecret: randomBytes(32).toString('hex')
      };
  state.sessionSecret ||= randomBytes(32).toString('hex');

  function persist() {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = `${dataFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, dataFile);
  }

  if (!saved?.users) persist();
  if (state.legacyUnclaimed) console.log(`旧数据认领码（仅在创建或认领账号时使用）：${state.legacyClaimToken}`);

  function publicWorkspace(user) {
    const { aiKey, ...settings } = user.settings;
    return { settings: { ...settings, hasAiKey: Boolean(aiKey) }, monitors: user.monitors, events: user.events.slice(0, 60), logs: user.logs.slice(0, 100), sentCount: user.sentCount, user: { id: user.id, username: user.username } };
  }

  function register(usernameInput, password, inviteCode) {
    const username = String(usernameInput || '').trim();
    if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(username)) throw new Error('用户名需要 3 到 32 个字，只能包含字母、数字、下划线或连字符');
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('密码长度需要在 12 到 128 位之间');
    if (state.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) throw new Error('用户名已存在');
    if (process.env.SIGNUP_CODE && inviteCode !== process.env.SIGNUP_CODE) throw new Error('注册邀请码不正确');
    const salt = randomBytes(16).toString('hex');
    const user = { id: randomUUID(), username, salt, passwordHash: scryptSync(password, salt, 64).toString('hex'), ...migrateWorkspace() };
    state.users.push(user);
    persist();
    return user;
  }

  function verifyLogin(usernameInput, password) {
    const user = state.users.find((item) => item.username.toLowerCase() === String(usernameInput || '').toLowerCase());
    if (!user || typeof password !== 'string') return null;
    const actual = scryptSync(password, user.salt, 64);
    const expected = Buffer.from(user.passwordHash, 'hex');
    return expected.length === actual.length && timingSafeEqual(actual, expected) ? user : null;
  }

  function claimLegacy(user, token) {
    if (!state.legacyUnclaimed) throw new Error('没有待认领的旧数据');
    const actual = Buffer.from(String(token || ''));
    const expected = Buffer.from(state.legacyClaimToken);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('旧数据认领码不正确');
    if (user.monitors.length || user.settings.webhooks.length) throw new Error('只能把旧数据认领到尚未配置的账号');
    Object.assign(user, state.legacyUnclaimed);
    state.legacyUnclaimed = null;
    state.legacyClaimToken = null;
    persist();
  }

  function issueCookie(user) {
    const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const body = `${user.id}.${expires}`;
    const signature = createHmac('sha256', state.sessionSecret).update(body).digest('hex');
    return `wr_session=${body}.${signature}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`;
  }

  function clearCookie() {
    return `wr_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`;
  }

  function userFromRequest(request) {
    const value = (request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('wr_session='))?.slice(11);
    const parts = value?.split('.');
    if (!parts || parts.length !== 3) return null;
    const [id, expires, signature] = parts;
    if (!/^\d+$/.test(expires) || Number(expires) <= Date.now() / 1000 || !/^[a-f0-9]{64}$/.test(signature)) return null;
    const expected = createHmac('sha256', state.sessionSecret).update(`${id}.${expires}`).digest();
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) return null;
    return state.users.find((user) => user.id === id) || null;
  }

  return { state, persist, publicWorkspace, register, verifyLogin, claimLegacy, issueCookie, clearCookie, userFromRequest };
}
