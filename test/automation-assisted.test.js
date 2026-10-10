import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssistedPlanner,planningObservation} from '../automation/agent/local-planner.js';
import {createPlanner} from '../automation/agent/planner.js';
import {runCommerceAgent} from '../automation/agent/executor.js';
import {createOrderService,validateOrderTask,validateOrderProgram,orderProgramHash} from '../lib/orders.js';

const order={url:'https://shop.example/checkout',product:'Product A',quantity:1,maxTotal:20,currency:'USD',executionMode:'submit'};
const program=()=>validateOrderProgram({summary:'Purchase monthly',workflow:{version:2,requirements:[{name:'Cycle',value:'Monthly'}]}});
function fixture({unknown=false,dryRun=true,rejectFill=false,expectedQuantity=1,monthlyCode='m',total=10,decorate=page=>page}={}){
  let quantity='0',cycle='y',epoch=0,current;
  const session={dryRun,trace:[],receipt:null,submissionStarted:false,paymentStarted:false,calls:[]};
  session.methods={
    observe:async()=>{
      const elements=[
        {tag:'h1',role:'heading',text:'Product A',accessibleName:'Product A'},
        {tag:'input',role:'spinbutton',name:unknown?'units':'quantity',label:unknown?'Units':'Quantity',value:quantity},
        {tag:'select',role:'combobox',name:'billingcycle',label:unknown?'Plan':'Cycle',value:cycle===monthlyCode?'Monthly':'Yearly',options:[{value:'y',text:'Yearly',selected:cycle==='y'},{value:monthlyCode,text:'Monthly',selected:cycle===monthlyCode}]},
        {tag:'span',id:'total',text:'USD '+total.toFixed(2),accessibleName:'USD '+total.toFixed(2)},
        {tag:'span',text:'USD',accessibleName:'USD'},
        {tag:'button',role:'button',text:'Place order',accessibleName:'Place order'}
      ].map((el,i)=>({...el,ref:'e'+(epoch*10+i),visible:true}));
      current={url:order.url,title:'Checkout',observationId:'page-'+epoch++,text:'Product A USD 10.00',html:'PRIVATE_HTML',domTree:[{private:'PRIVATE_TREE'}],elements};
      current=decorate(current);return structuredClone(current);
    },
    resolveSemantic:async target=>{assert.ok(current.elements.some(el=>el.ref===target.ref),'must bind fresh observed ref');return {selector:target.ref,strategy:'label'};},
    readSemantic:async target=>{const el=current.elements.find(el=>el.ref===target.ref);return {...el,...(el.tag==='select'?{value:cycle===monthlyCode?'Monthly':'Yearly',selectedValue:cycle}:{}),...(el.tag==='input'?{value:quantity}:{})};},
    fill:async(ref,value)=>{assert.equal(current.elements.find(el=>el.ref===ref)?.tag,'input');session.calls.push('fill');if(!rejectFill)quantity=String(value);},
    select:async(ref,value)=>{assert.equal(current.elements.find(el=>el.ref===ref)?.tag,'select');session.calls.push('select');cycle=value;},
    submit:async()=>{
      assert.equal(quantity,String(expectedQuantity));assert.equal(cycle,monthlyCode);
      session.calls.push('review');if(!dryRun)session.submissionStarted=true;
      session.receipt={status:dryRun?'prepared':'ordered',review:{product:'Product A',quantity:expectedQuantity,total,currency:'USD',configuration:[{name:'Cycle',value:'Monthly'}]}};
      return session.receipt;
    }
  };
  session.snapshot=session.methods.observe;session.close=async()=>{};return session;
}
function batch(page){
  const t=(meaning,el)=>({meaning,ref:el.ref,confidence:0.95}),el=index=>page.elements[index];
  return {steps:[
    {action:'fill',reason:'Set authorized quantity',target:t('quantity',el(1)),value:'1'},
    {action:'select',reason:'Select monthly billing',target:t('billing_cycle',el(2)),value:'m'},
    {action:'review',reason:'Check the current checkout',bindings:{submit:t('submit_order',el(5)),product:t('product',el(0)),quantity:t('quantity',el(1)),total:t('total',el(3)),currency:t('currency',el(4))},configuration:[{name:'Cycle',target:t('billing_cycle',el(2))}]}
  ]};
}
function serviceFixture({ambiguous=false}={}){
  const task=validateOrderTask({...order,instruction:'Cycle Monthly',monitorId:'m'});
  const user={id:'u',settings:{},monitors:[{id:'m',kind:'webpage'}],orderTasks:[task],orderAccounts:[{monitorId:'m',loginUrl:order.url,revision:1,status:'saved',session:{state:{cookies:[],origins:[]},check:{url:order.url}}}]};
  let business=0,assistance=0,opened=0,submitted=0;const sessions=[];
  const service=createOrderService({persist:()=>{},
    requestAI:async(_user,messages)=>{
      if(messages[0].content.includes('仅返回 JSON {summary')){business++;return program();}
      assistance++;
      const content=typeof messages[1].content==='string'?messages[1].content:messages[1].content[0].text;
      const page=JSON.parse(content).page;
      assert.equal(page.html,undefined);assert.equal(page.domTree,undefined);
      if(ambiguous)return {action:'fill',reason:'Unsure which quantity control',target:{meaning:'quantity',ref:page.elements[1].ref,confidence:0.6},value:'1'};
      return batch(page);
    },
    openBrowser:async(current,options)=>{
      opened++;const session=fixture({unknown:true,dryRun:!!current.dryRun});sessions.push(session);
      const submit=session.methods.submit;
      session.methods.submit=async checks=>{if(!current.dryRun){await options.onBeforeSubmit({product:'Product A',quantity:1,total:10,currency:'USD'});submitted++;}return submit(checks);};
      return session;
    }
  });
  return {task,user,service,sessions,get business(){return business;},get assistance(){return assistance;},get opened(){return opened;},get submitted(){return submitted;}};
}
test('a mapped page follows the fixed business template without more AI',async()=>{
  const recipes=[];
  await runCommerceAgent(program(),order,fixture(),{plan:createAssistedPlanner(async input=>batch(input.observation),{recipes})});
  let calls=0;const session=fixture(),sources=[];
  const plan=createAssistedPlanner(async()=>{calls++;throw new Error('AI is unnecessary');},{recipes,onEvent:(_action,event)=>sources.push(event.source)});
  const result=await runCommerceAgent(program(),order,session,{plan});
  assert.equal(result.status,'prepared');assert.equal(calls,0);
  assert.deepEqual(session.calls,['fill','select','review']);assert.deepEqual(sources,['learned','learned','learned']);
});
test('one unknown-page AI explanation drives multiple code actions and is reused with fresh refs',async()=>{
  let calls=0;const recipes=[],sources=[];
  const assist=createPlanner(async messages=>{calls++;return batch(JSON.parse(messages[1].content).page);});
  const first=fixture({unknown:true});
  await runCommerceAgent(program(),order,first,{plan:createAssistedPlanner(assist,{recipes,onEvent:(_action,event)=>sources.push(event.source)})});
  assert.equal(calls,1);assert.deepEqual(sources,['ai_assistance','assisted_flow','assisted_flow']);assert.equal(recipes.length,3);
  assert.doesNotMatch(JSON.stringify(recipes),/"ref"|selector|PRIVATE_HTML|PRIVATE_TREE/);
  const second=fixture({unknown:true});
  await runCommerceAgent(program(),order,second,{plan:createAssistedPlanner(async()=>{throw new Error('must reuse discovered flow');},{recipes})});
  assert.deepEqual(second.calls,['fill','select','review']);assert.equal(calls,1);
});
test('two preflights and the approved execution reuse the compiled flow without more AI calls',async()=>{
  const f=serviceFixture();await f.service.generate(f.user,f.task);
  assert.equal(f.business,1);assert.equal(f.assistance,1);assert.equal(f.task.trial.preflightPasses,2);assert.equal(f.task.program.runtimePlan.length,3);assert.equal(f.submitted,0);
  const approved=orderProgramHash(f.task),compiled=JSON.stringify(f.task.program.runtimePlan);
  f.service.approve(f.user,f.task,approved);await f.service.execute(f.user,f.task);
  assert.equal(f.task.status,'ordered');assert.equal(f.assistance,1);assert.equal(f.submitted,1);assert.equal(orderProgramHash(f.task),approved);assert.equal(JSON.stringify(f.task.program.runtimePlan),compiled);
  assert.deepEqual(f.sessions.slice(1).map(session=>session.calls),Array.from({length:3},()=>['fill','select','review']));
  await assert.rejects(f.service.execute(f.user,f.task),/已经执行/);assert.equal(f.submitted,1);
});
test('uncertain AI evidence becomes an explicit question instead of regenerating the whole workflow',async()=>{
  const f=serviceFixture({ambiguous:true});
  await assert.rejects(f.service.generate(f.user,f.task),{code:'AGENT_NEEDS_INPUT'});
  assert.equal(f.business,1);assert.equal(f.assistance,2);assert.equal(f.opened,2);assert.equal(f.submitted,0);
  assert.equal(f.task.failure.category,'needs_input');assert.equal(f.task.failure.orderRequestSent,'no');assert.ok(f.task.input.candidates.some(item=>item.label==='Units'));assert.ok(f.task.input.question);
  assert.equal(f.task.trial,null);assert.equal(f.task.enabled,false);
});
test('a failed mapped action asks AI to repair only the current obstacle',async()=>{
  const recipes=[];
  await runCommerceAgent(program(),order,fixture(),{plan:createAssistedPlanner(async input=>batch(input.observation),{recipes})});
  const session=fixture({rejectFill:true});let assistance=0;
  const plan=createAssistedPlanner(async()=>{assistance++;return {action:'stop',reason:'网站拒绝数量修改，请确认是否需要先选择套餐'};},{recipes});
  await assert.rejects(runCommerceAgent(program(),order,session,{plan}),error=>error.code==='AGENT_NEEDS_INPUT'&&Boolean(error.orderInput.question));
  assert.equal(assistance,1);assert.deepEqual(session.calls,['fill']);assert.equal(session.receipt,null);
});
test('semantic compression preserves late controls and hidden invoice metadata',()=>{
  const page={url:order.url,html:'huge',domTree:[{}],elements:Array.from({length:1400},(_,i)=>({ref:'e'+i,tag:'span',text:'text '+i,visible:true}))};
  page.elements.push({ref:'e1400',tag:'button',role:'button',text:'Place order',visible:true},{ref:'e1401',tag:'input',type:'hidden',name:'invoiceid',visible:false});
  const compact=planningObservation(page);
  assert.equal(compact.elements.length,1402);assert.equal(compact.elements.at(-1).name,'invoiceid');assert.equal(compact.html,undefined);assert.equal(compact.domTree,undefined);
});
test('ambiguous current controls invalidate learned actions rather than choosing the first match',async()=>{
  const recipes=[];
  await runCommerceAgent(program(),order,fixture({unknown:true}),{plan:createAssistedPlanner(createPlanner(async messages=>batch(JSON.parse(messages[1].content).page)),{recipes})});
  let assisted=0;const session=fixture({unknown:true});
  const observe=session.methods.observe;
  session.methods.observe=async()=>{const page=await observe();page.elements.push({...page.elements[1],ref:'e999'});return page;};
  const plan=createAssistedPlanner(async()=>{assisted++;return {action:'stop',reason:'Two matching quantity inputs; please choose a package'};},{recipes});
  await assert.rejects(runCommerceAgent(program(),order,session,{plan}),{code:'AGENT_NEEDS_INPUT'});
  assert.equal(assisted,1);assert.deepEqual(session.calls,[]);
});


test('familiar field words never trigger speculative actions before a page is mapped',async()=>{
  const session=fixture();let calls=0;
  const plan=createAssistedPlanner(async()=>{calls++;return {action:'stop',reason:'Please identify the intended offer'};});
  await assert.rejects(runCommerceAgent(program(),order,session,{plan}),{code:'AGENT_NEEDS_INPUT'});
  assert.equal(calls,1);assert.deepEqual(session.calls,[]);
});
test('the same business template works with arbitrary merchant labels',async()=>{
  const recipes=[];let calls=0;
  const decorate=page=>{
    page.title='Ihr Angebot';
    Object.assign(page.elements[1],{name:'p_7a9',label:'Stückzahl'});
    Object.assign(page.elements[2],{name:'p_a14',label:'Vertragsperiode'});
    Object.assign(page.elements[5],{text:'Jetzt verbindlich bestellen',accessibleName:'Jetzt verbindlich bestellen'});
    return page;
  };
  for(let pass=0;pass<2;pass++){
    const session=fixture({decorate});
    await runCommerceAgent(program(),order,session,{plan:createAssistedPlanner(async input=>{calls++;return batch(input.observation);},{recipes})});
    assert.deepEqual(session.calls,['fill','select','review']);
  }
  assert.equal(calls,1);
});
test('layout, title, incidental query, field names, amounts and option values may change without replanning',async()=>{
  const recipes=[];
  await runCommerceAgent(program(),order,fixture({unknown:true}),{plan:createAssistedPlanner(async input=>batch(input.observation),{recipes})});
  const session=fixture({unknown:true,monthlyCode:'option-current-983',total:12,decorate:page=>{
    page.title='Updated page';page.url+='?view=redesigned&visit=new';
    page.elements[1].name='generated-field-91';page.elements[2].name='generated-field-92';
    page.elements[0].tag='h2';page.elements[3].tag='div';
    page.elements.unshift({ref:'e9000',role:'link',tag:'a',text:'New help link',accessibleName:'New help link',visible:true,href:'/help'});
    page.elements.reverse();return page;
  }});
  const result=await runCommerceAgent(program(),order,session,{plan:createAssistedPlanner(async()=>{throw new Error('Layout-only changes do not require AI');},{recipes})});
  assert.equal(result.review.total,12);assert.deepEqual(session.calls,['fill','select','review']);
});
test('task parameters supply values while merchant option identifiers are bound at runtime',async()=>{
  const recipes=[];
  await runCommerceAgent(program(),order,fixture({unknown:true}),{plan:createAssistedPlanner(async input=>{
    const result=batch(input.observation);result.steps[0].valueFrom='quantity';result.steps[1].valueFrom={requirement:'Cycle'};return result;
  },{recipes})});
  const session=fixture({unknown:true,expectedQuantity:2,monthlyCode:'monthly-now'});
  const result=await runCommerceAgent(program(),{...order,quantity:2},session,{plan:createAssistedPlanner(async()=>{throw new Error('Values must come from the task');},{recipes})});
  assert.equal(result.review.quantity,2);
});
test('missing bindings in a known page request a local repair before any action',async()=>{
  const recipes=[];
  await runCommerceAgent(program(),order,fixture({unknown:true}),{plan:createAssistedPlanner(async input=>batch(input.observation),{recipes})});
  const session=fixture({unknown:true,decorate:page=>{
    page.elements[1].name='brand-new';page.elements[1].label='別の入力';return page;
  }});
  let calls=0;
  await runCommerceAgent(program(),order,session,{plan:createAssistedPlanner(async input=>{calls++;assert.deepEqual(session.calls,[]);return batch(input.observation);},{recipes})});
  assert.equal(calls,1);assert.deepEqual(session.calls,['fill','select','review']);
});
test('the fixed template enforces verification boundaries independently of page labels',async()=>{
  const session=fixture({unknown:true}),observation=await session.methods.observe();
  const plan=createAssistedPlanner(async input=>batch(input.observation));
  await assert.rejects(plan({order,workflow:program().workflow,observation,history:[],context:{pendingVerification:'cart'}}),{code:'AGENT_STEP_UNVERIFIED'});
  assert.deepEqual(session.calls,[]);
});


test('a repeated button caption does not transfer an action to another product or form',async()=>{
  const recipes=[],base={order,workflow:program().workflow,history:[],context:{couponApplied:true}};
  const observation={url:'https://shop.example/cart?step=one',elements:[{ref:'e0',role:'button',tag:'button',text:'Continue',accessibleName:'Continue',contextText:'Product A 64 GB',visible:true}]};
  const first=createAssistedPlanner(async()=>({action:'click',reason:'Continue the selected product',target:{meaning:'continue_product',ref:'e0',confidence:0.95}}),{recipes});
  await first({...base,observation});first.remember();
  let repaired=0;
  const next=createAssistedPlanner(async()=>{repaired++;return {action:'stop',reason:'This control now belongs to a different product'};},{recipes});
  const result=await next({...base,observation:{...observation,url:'https://shop.example/cart?step=two',elements:[{...observation.elements[0],ref:'e9',contextText:'Product A 128 GB'}]}});
  assert.equal(result.action,'stop');assert.equal(repaired,1);
});


test('a clarification inside coupon verification remains an explicit question',async()=>{
  const session=fixture(),observed=await session.methods.observe(),t=(meaning,index)=>({meaning,ref:observed.elements[index].ref,confidence:0.95});
  let plans=0;
  session.methods.applyCoupon=async(_coupon,_checkout,{rebind})=>rebind();
  const plan=async input=>{
    plans++;
    if(input.context.pendingVerification==='coupon')return {action:'stop',reason:'请确认页面上两个优惠结果哪一个属于本商品'};
    const page=input.observation,bind=(meaning,index)=>({...t(meaning,index),ref:page.elements[index].ref});
    return {action:'apply_coupon',reason:'Apply authorized coupon',bindings:{input:bind('coupon_input',1),apply:bind('coupon_apply',5),appliedCode:bind('coupon_proof',0),discount:bind('discount',3),submit:bind('submit_order',5),product:bind('product',0),quantity:bind('quantity',1),total:bind('total',3),currency:bind('currency',4)}};
  };
  await assert.rejects(runCommerceAgent(program(),{...order,couponCode:'SAVE'},session,{plan}),error=>error.code==='AGENT_NEEDS_INPUT'&&error.orderInput.reason.includes('两个优惠结果'));
  assert.equal(plans,2);assert.equal(session.receipt,null);
});
