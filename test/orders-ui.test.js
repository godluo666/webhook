import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/orders-ui.js',import.meta.url),'utf8');
test('order editor renders optional login verification inputs for new and saved accounts',()=>{
  for(const account of [undefined,{monitorId:'monitor',loginUrl:'https://shop.example/login',checkUrl:'https://shop.example/account',loggedInSelector:'#account-name',status:'saved'}]){
    const root={innerHTML:'',querySelectorAll:()=>[]};
    const context=vm.createContext({window:{addEventListener(){}},document:{addEventListener(){}},appState:{monitors:[{id:'monitor',url:'https://shop.example/product'}],orderAccounts:account?[account]:[]},$:selector=>selector==='#order-addon'?root:null,escapeHtml:value=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;')});
    vm.runInContext(source,context);
    vm.runInContext("orderMonitorId='monitor';openOrderEditor();",context);
    for(const [id,value] of [['order-login-url',account?.loginUrl||'https://shop.example/product'],['order-check-url',account?.checkUrl||''],['order-login-selector',account?.loggedInSelector||'']]){
      const input=root.innerHTML.match(new RegExp('<input id="'+id+'"[^>]*>','g'));
      assert.equal(input?.length,1,id+' must exist exactly once before starting login');
      assert.ok(input[0].includes('value="'+value+'"'));
    }
    assert.match(root.innerHTML,/data-order-login-settings-panel class="hidden"/);
  }
});
