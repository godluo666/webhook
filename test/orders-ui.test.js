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

test('generation polling retries lost progress responses without resubmitting generation',async()=>{
  const calls=[],responses=[Object.assign(new Error('lost response'),{code:'RADAR_CONNECTION_FAILED'}),{task:{status:'generating'}},{task:{status:'ready'}}];
  const context=vm.createContext({window:{addEventListener(){}},document:{addEventListener(){}},AbortSignal,setTimeout:callback=>callback(),api:async(...args)=>{calls.push(args);const next=responses.shift();if(next instanceof Error)throw next;return next;}});
  vm.runInContext(source,context);
  const result=await context.waitForOrderGeneration('/api/order-tasks/task',{task:{status:'generating'}},()=>true);
  assert.equal(result.task.status,'ready');assert.equal(calls.length,3);
  for(const [path,method] of calls){assert.equal(path,'/api/order-tasks/task');assert.equal(method,'GET');}
  assert.match(source,/api\(path\+'\/generate','POST',\{background:true\}\)/);
});

test('unresolved steps show a concrete confirmation question and candidates',()=>{
  const context=vm.createContext({window:{addEventListener(){}},document:{addEventListener(){}},escapeHtml:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;')});
  vm.runInContext(source,context);
  const html=context.orderValidationReport({status:'needs_validation',executionMode:'prepare',validation:{syntax:'passed'},input:{question:'请选择套餐',reason:'两个同名购买按钮',candidates:[{label:'购买 <script>',context:'套餐 A',options:['月付','年付']}]},failure:{stage:'planning',category:'needs_input',orderRequestSent:'no',suggestion:'请确认'}});
  assert.match(html,/需要你确认/);assert.match(html,/请选择套餐/);assert.match(html,/套餐 A/);assert.match(html,/月付、年付/);assert.doesNotMatch(html,/<script>/);
});
