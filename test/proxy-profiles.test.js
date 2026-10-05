import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeProxyProfiles,publicProxyProfiles,selectedProxyUrl,saveProxyProfile} from '../lib/proxy-profiles.js';
test('旧单代理自动迁移，删除快捷条目后重启不复活，公开视图隐藏凭据',()=>{
 const settings={sourceProxy:'http://user:secret@127.0.0.1:8080/'};initializeProxyProfiles(settings);assert.equal(settings.sourceProxies.length,1);
 assert.equal(JSON.stringify(publicProxyProfiles(settings)).includes('secret'),false);const id=settings.sourceProxies[0].id;
 assert.equal(selectedProxyUrl({settings},{sourceProxyId:id}),settings.sourceProxy);
 settings.sourceProxies=[];settings.sourceProxyId=null;initializeProxyProfiles(settings);assert.equal(settings.sourceProxies.length,0);
 assert.throws(()=>selectedProxyUrl({settings},{sourceProxyId:id}),error=>error.code==='SOURCE_PROXY_NOT_FOUND');
 assert.equal(selectedProxyUrl({settings},{},{sourceProxy:settings.sourceProxy}),settings.sourceProxy);
});
test('代理条目去重、名称校验与有界列表',()=>{
 const settings={};for(let i=0;i<32;i++)saveProxyProfile(settings,'http://localhost:'+(8000+i),'节点 '+i,null);
 assert.throws(()=>saveProxyProfile(settings,'http://localhost:9000','溢出',null));
 saveProxyProfile(settings,'http://localhost:8000','新名称',null);assert.equal(settings.sourceProxies.length,32);assert.equal(settings.sourceProxies[0].name,'新名称');
 assert.throws(()=>saveProxyProfile(settings,'http://localhost:8000','<坏名称>',null));
});
