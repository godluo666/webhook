import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';

const SESSION_SECONDS = 7 * 24 * 60 * 60;

function validPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('密码长度需要在 12 到 128 位之间');
}

export function validEmail(input) {
  const email = String(input || '').trim().toLowerCase();
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error('邮箱格式不正确');
  return email;
}

function matchesSecret(value, salt, hash) {
  if (typeof value !== 'string' || value.length > 128 || !salt || !/^[a-f0-9]{128}$/.test(hash || '')) return false;
  const actual = scryptSync(value, salt, 64);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

function workspace(saved = {}) {
  const settings = { aiBaseUrl: 'https://api.openai.com/v1', aiModel: '', aiKey: '', ...saved.settings };
  delete settings.webhookUrl;
  settings.webhooks = Array.isArray(settings.webhooks) ? settings.webhooks : [];
  return {
    settings,
    monitors: Array.isArray(saved.monitors) ? saved.monitors : [],
    events: Array.isArray(saved.events) ? saved.events : [],
    logs: Array.isArray(saved.logs) ? saved.logs : [],
    sentCount: saved.sentCount || 0
  };
}

export function createStore(dataDir, emailCodes = { enabled: false }) {
  const dataFile = path.join(dataDir, 'state.json');
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(dataFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const state = {
    users: Array.isArray(saved?.users) ? saved.users.map((user) => ({ ...user, ...workspace(user), emailVerified: Boolean(user.emailVerified) })) : [],
    sessionSecret: saved?.sessionSecret || randomBytes(32).toString('hex')
  };

  function persist() {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = `${dataFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, dataFile);
  }

  persist();

  function publicWorkspace(user) {
    const { aiKey, ...settings } = user.settings;
    return { settings: { ...settings, hasAiKey: Boolean(aiKey) }, monitors: user.monitors, events: user.events.slice(0, 60), logs: user.logs.slice(0, 100), sentCount: user.sentCount, user: { id: user.id, username: user.username, email: user.email || '', emailVerified: Boolean(user.emailVerified), hasRecoveryCode: Boolean(user.recoveryHash) } };
  }

  function newRecoveryCode(user) {
    const code = randomBytes(20).toString('hex').toUpperCase();
    user.recoverySalt = randomBytes(16).toString('hex');
    user.recoveryHash = scryptSync(code, user.recoverySalt, 64).toString('hex');
    return code;
  }

  function registrationTarget(usernameInput, inviteCode, emailInput) {
    const username = String(usernameInput || '').trim();
    if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(username)) throw new Error('用户名需要 3 到 32 个字，只能包含字母、数字、下划线或连字符');
    if (state.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) throw new Error('用户名已存在');
    if (process.env.SIGNUP_CODE && inviteCode !== process.env.SIGNUP_CODE) throw new Error('注册邀请码不正确');
    const email = validEmail(emailInput);
    if (email && state.users.some((user) => user.email === email)) throw new Error('邮箱已被其他账号绑定');
    return { username, email };
  }

  async function requestRegistrationEmailCode(username, inviteCode, emailInput) {
    if (!emailCodes.enabled) throw new Error('邮件验证码尚未启用：管理员需配置发信服务');
    const target = registrationTarget(username, inviteCode, emailInput);
    if (!target.email) throw new Error('请先填写邮箱地址');
    await emailCodes.send('register', target.email);
  }

  function register(usernameInput, password, inviteCode, emailInput, emailCode) {
    const { username, email } = registrationTarget(usernameInput, inviteCode, emailInput);
    validPassword(password);
    if (emailCodes.enabled) {
      if (!email) throw new Error('请填写并验证邮箱后注册');
      emailCodes.consume('register', email, emailCode);
    } else if (email) {
      throw new Error('邮件验证尚未配置，目前只能使用用户名注册');
    }
    const salt = randomBytes(16).toString('hex');
    const user = { id: randomUUID(), username, email, emailVerified: Boolean(email), salt, passwordHash: scryptSync(password, salt, 64).toString('hex'), sessionVersion: 0, ...workspace() };
    const recoveryCode = newRecoveryCode(user);
    state.users.push(user);
    persist();
    return { user, recoveryCode };
  }

  function verifyLogin(usernameInput, password) {
    const user = state.users.find((item) => item.username.toLowerCase() === String(usernameInput || '').toLowerCase());
    return user && matchesSecret(password, user.salt, user.passwordHash) ? user : null;
  }

  function changePassword(user, currentPassword, nextPassword) {
    if (!matchesSecret(currentPassword, user.salt, user.passwordHash)) throw new Error('当前密码不正确');
    validPassword(nextPassword);
    if (currentPassword === nextPassword) throw new Error('新密码不能与当前密码相同');
    user.salt = randomBytes(16).toString('hex');
    user.passwordHash = scryptSync(nextPassword, user.salt, 64).toString('hex');
    user.sessionVersion = (user.sessionVersion || 0) + 1;
    persist();
  }

  function emailChangeTarget(user, password, input) {
    if (!matchesSecret(password, user.salt, user.passwordHash)) throw new Error('当前密码不正确');
    const email = validEmail(input);
    if (email && state.users.some((item) => item.id !== user.id && item.email === email)) throw new Error('邮箱已被其他账号绑定');
    return email;
  }

  async function requestBindEmailCode(user, password, input) {
    if (!emailCodes.enabled) throw new Error('邮件验证码尚未启用：管理员需配置发信服务');
    const email = emailChangeTarget(user, password, input);
    if (!email) throw new Error('请先填写邮箱地址');
    if (email === user.email && user.emailVerified) throw new Error('该邮箱已完成验证');
    await emailCodes.send('bind', email, user.id);
  }

  function updateEmail(user, password, input, code) {
    const email = emailChangeTarget(user, password, input);
    if (email && (email !== user.email || !user.emailVerified)) {
      if (!emailCodes.enabled) throw new Error('邮件验证码尚未启用，暂时无法绑定邮箱');
      emailCodes.consume('bind', email, code, user.id);
    }
    user.email = email;
    user.emailVerified = Boolean(email);
    persist();
  }

  function rotateRecoveryCode(user, password) {
    if (!matchesSecret(password, user.salt, user.passwordHash)) throw new Error('当前密码不正确');
    const recoveryCode = newRecoveryCode(user);
    persist();
    return recoveryCode;
  }

  function recoverPassword(usernameInput, code, nextPassword) {
    const user = state.users.find((item) => item.username.toLowerCase() === String(usernameInput || '').trim().toLowerCase());
    if (!user || !matchesSecret(String(code || '').replace(/[\s-]/g, '').toUpperCase(), user.recoverySalt, user.recoveryHash)) return null;
    validPassword(nextPassword);
    user.salt = randomBytes(16).toString('hex');
    user.passwordHash = scryptSync(nextPassword, user.salt, 64).toString('hex');
    user.sessionVersion = (user.sessionVersion || 0) + 1;
    const recoveryCode = newRecoveryCode(user);
    persist();
    return { user, recoveryCode };
  }

  function issueCookie(user) {
    const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const body = `${user.id}.${expires}.${user.sessionVersion || 0}`;
    const signature = createHmac('sha256', state.sessionSecret).update(body).digest('hex');
    return `wr_session=${body}.${signature}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`;
  }

  function clearCookie() {
    return `wr_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`;
  }

  function userFromRequest(request) {
    const value = (request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('wr_session='))?.slice(11);
    const parts = value?.split('.');
    if (!parts || parts.length !== 4) return null;
    const [id, expires, version, signature] = parts;
    if (!/^\d+$/.test(expires) || Number(expires) <= Date.now() / 1000 || !/^\d+$/.test(version) || !/^[a-f0-9]{64}$/.test(signature)) return null;
    const expected = createHmac('sha256', state.sessionSecret).update(`${id}.${expires}.${version}`).digest();
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) return null;
    return state.users.find((user) => user.id === id && (user.sessionVersion || 0) === Number(version)) || null;
  }

  return { state, persist, publicWorkspace, register, requestRegistrationEmailCode, verifyLogin, changePassword, updateEmail, requestBindEmailCode, rotateRecoveryCode, recoverPassword, issueCookie, clearCookie, userFromRequest };
}
