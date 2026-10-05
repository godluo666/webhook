import { randomUUID } from 'node:crypto';
import { validateSourceProxy, proxyEndpoint } from './source-proxy.js';

export function initializeProxyProfiles(settings) {
  const legacy = !Array.isArray(settings.sourceProxies);
  settings.sourceProxies = legacy ? [] : settings.sourceProxies;
  if (legacy && settings.sourceProxy && !settings.sourceProxies.some(item => item.url === settings.sourceProxy)) {
    const item = { id: randomUUID(), name: '原默认代理', url: settings.sourceProxy, test: settings.sourceProxyTest || null };
    settings.sourceProxies.push(item); settings.sourceProxyId = item.id;
  }
}
export function publicProxyProfiles(settings) {
  return (settings.sourceProxies || []).map(({id,name,url,test}) => ({id,name,endpoint:proxyEndpoint(url),test:test || null}));
}
export function findProxyProfile(user, id) {
  const item = user.settings.sourceProxies?.find(item => item.id === id);
  if (!item) throw Object.assign(new Error('所选代理已不存在，请重新选择'), {status:404,code:'SOURCE_PROXY_NOT_FOUND'});
  return item;
}
// A rule keeps a private copy: deleting a shortcut never changes its route.
export function selectedProxyUrl(user, input = {}, saved = null) {
  if (input.sourceProxyId) return findProxyProfile(user, input.sourceProxyId).url;
  if (input.sourceProxy === null) return '';
  return String(input.sourceProxy || '').trim() ? validateSourceProxy(input.sourceProxy) : saved?.sourceProxy || '';
}
export function saveProxyProfile(settings, url, name, test) {
  const normalized = validateSourceProxy(url), label = String(name || proxyEndpoint(normalized)).trim();
  if (!label || label.length > 60 || /[\r\n<>]/.test(label)) throw new Error('代理名称需要 1–60 个字符');
  const items = settings.sourceProxies ||= [];
  let item = items.find(item => item.url === normalized);
  if (!item && items.length >= 32) throw new Error('最多保存 32 条代理，请先删除不需要的条目');
  if (!item) { item = {id:randomUUID(),url:normalized}; items.push(item); }
  Object.assign(item,{name:label,test});
  return item;
}
