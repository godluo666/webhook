import {BUSINESS_PROMPT} from '../automation/agent/planner.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {createOrderBrowser} from '../lib/order-browser.js';
import {validateOrderProgram,validateOrderTask,createOrderService,orderProgramHash} from '../lib/orders.js';
import {runCommerceAgent} from '../automation/agent/executor.js';
const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'&&fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':null);
const target=(page,meaning,predicate)=>{
  const candidates=page.elements.filter(predicate);assert.equal(candidates.length,1,'Unique semantic evidence: '+meaning);
  return {meaning,ref:candidates[0].ref,confidence:0.95};
};
const text=(page,meaning,value)=>target(page,meaning,el=>el.text===value&&['button','h1','h2','span','p','a'].includes(el.tag));
const quantity=page=>target(page,'quantity',el=>el.label==='Quantity'&&el.tag==='input');
const checkout=page=>({submit:text(page,'submit_order','Place order'),product:text(page,'product','Product A'),quantity:quantity(page),total:text(page,'total',page.text.includes('USD 8.00')?'USD 8.00':'USD 10.00'),currency:text(page,'currency','USD')});
const coupon=page=>({...checkout(page),input:target(page,'coupon_input',el=>el.placeholder==='Coupon code'),apply:text(page,'apply_coupon','Apply coupon'),appliedCode:target(page,'applied_coupon',el=>el.name===null&&el.id?.startsWith('proof-')),discount:target(page,'discount',el=>el.id?.startsWith('discount-'))});
test('真实浏览器在未知后续页面和变化 DOM 上探索、提交、付款及优惠重绑定',{skip:!executable,timeout:90000},async t=>{
  const requests=[],counts={orders:0,payments:0,coupons:0},evidence=[];
  const html=(route,variant,discount=false)=>{
    const id=randomUUID(),heading=variant==='b'?'h2':'h1',wrap=variant==='b'?'article':'main';
    const gateway=variant==='w'?'<label>Payment<select name="paymentmethod"><option value="balance">Account balance</option><option value="alipay">Alipay</option></select></label>':'';
    const title='<'+heading+' id="title-'+id+'">Product A</'+heading+'>';
    if(route==='/catalog'){const card=variant==='b'?'div':'article';return '<title>Store category</title><a href="/logout">Log out</a><main><h1>Server products</h1><'+card+'><h2>Product B</h2><p>32G RAM · 2 Available</p><a href="/start?v='+variant+'&other=1">Order Now</a></'+card+'><'+card+'><h2>Product A</h2><p>64G RAM · 4 Available</p><a href="/start?v='+variant+'">Order Now</a></'+card+'></main>';}
    if(route==='/start')return '<a href="/logout">Log out</a><'+wrap+'>'+title+'<form method="post" action="/basket?v='+variant+'"><label>Quantity<input id="qty-'+id+'" name="quantity" value="0"></label><button>Add to cart</button></form></'+wrap+'>';
    if(route==='/invoice')return '<main><span>USD 10.00</span><span>USD</span><span>100.00</span><form method="post" action="/charge"><input type="hidden" name="invoiceid" value="42">'+gateway+'<button>Pay invoice from account balance</button></form></main>';
    const promo='<form method="post" action="/promo?v='+variant+'"><input name="promocode" placeholder="Coupon code"><button>Apply coupon</button></form><span id="proof-'+id+'" '+(!discount?'hidden':'')+'>SAVE20</span><span id="discount-'+id+'" '+(!discount?'hidden':'')+'>2.00</span>';
    return '<'+wrap+'>'+title+'<span>USD '+(discount?'8.00':'10.00')+'</span><span>USD</span>'+promo+'<form method="post" action="/finish?v='+variant+'"><input type="hidden" name="csrf" value="private-csrf-token"><label>Quantity<input id="qty-'+id+'" name="quantity" value="1"></label><label>Cycle<select name="billingcycle"><option value="m">Monthly</option></select></label>'+gateway+'<button aria-label="Place order">Place order</button></form></'+wrap+'>';
  };
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://local'),variant=url.searchParams.get('v')||'a';let body='';for await(const chunk of req)body+=chunk;requests.push({path:url.pathname,method:req.method,body});
    res.setHeader('content-type','text/html; charset=utf-8');
    if(url.searchParams.has('other'))return res.end('<h1>Wrong product selected</h1>');
    if(url.pathname==='/basket'){res.writeHead(303,{location:'/checkout?v='+variant});return res.end();}
    if(url.pathname==='/promo'){counts.coupons++;res.writeHead(303,{location:'/checkout?v='+variant+'&discount=1'});return res.end();}
    if(url.pathname==='/finish'){counts.orders++;return res.end('<p>Order confirmed</p><p>Order number: ORD-'+counts.orders+'</p><a href="/invoice?id=42&v='+variant+'">View invoice #42</a>');}
    if(url.pathname==='/charge'){counts.payments++;return res.end('<p>Payment successful</p><p>Invoice #42 paid</p>');}
    res.end(html(url.pathname,variant,url.searchParams.has('discount')));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  const launch=options=>chromium.launch({...options,executablePath:executable});
  const business=validateOrderProgram({summary:'Generic commerce',workflow:{version:2,requirements:[{name:'Cycle',value:'Monthly'}]}});
  const baseOrder={product:'Product A',quantity:1,maxTotal:20,currency:'USD',paymentMethod:{kind:'balance',name:'账户余额'},executionMode:'submit'};
  const plan=async({observation:page,context,order})=>{
    const action=step=>({reason:'Observed merchant semantics',...step});
    if(page.title==='Store category')return action({action:'click',target:target(page,'purchase',el=>el.role==='link'&&el.text==='Order Now'&&el.contextText.includes('Product A'))});
    if(context.pendingVerification==='cart')return action({action:'verify_cart',bindings:{product:text(page,'product','Product A'),quantity:quantity(page)}});
    if(context.pendingVerification==='coupon')return action({action:'verify_coupon',bindings:coupon(page)});
    if(page.elements.some(el=>el.text==='Add to cart')){
      const q=page.elements.find(el=>el.label==='Quantity'&&el.tag==='input');
      return q.value!=='1'?action({action:'fill',target:quantity(page),value:'1'}):action({action:'cart',target:text(page,'add_to_cart','Add to cart')});
    }
    if(context.receipt?.status==='ordered'){
      if(page.elements.some(el=>el.text==='View invoice #42'))return action({action:'invoice',target:text(page,'invoice','View invoice #42')});
      return action({action:'pay',...(order.paymentMethod.kind==='website'?{paymentMethod:{target:target(page,'payment_method',el=>el.name==='paymentmethod'),value:'alipay'}}:{}),bindings:{pay:text(page,'pay','Pay invoice from account balance'),invoice:target(page,'invoice_id',el=>el.name==='invoiceid'),total:text(page,'total','USD 10.00'),currency:text(page,'currency','USD'),balance:text(page,'balance','100.00'),balanceCurrency:text(page,'balance_currency','USD')}});
    }
    if(order.couponCode&&!context.couponApplied)return action({action:'apply_coupon',bindings:coupon(page)});
    if(order.paymentMethod.kind==='website'){
      const gateway=page.elements.find(el=>el.name==='paymentmethod');
      if(gateway?.value!=='Alipay')return action({action:'choosePayment',target:target(page,'payment_method',el=>el.name==='paymentmethod'),value:'alipay'});
    }
    const bindings=checkout(page);
    if(order.couponCode){bindings.appliedCode=coupon(page).appliedCode;bindings.discount=coupon(page).discount;}
    return action({action:'review',bindings,configuration:[{name:'Cycle',target:target(page,'billing_cycle',el=>el.tag==='select'&&el.label==='Cycle')}]});
  };
  try{
    for(const variant of ['a','b'])await t.test('探索不同 DOM '+variant+'，试跑不提交',async()=>{
      const order={...baseOrder,url:base+'/catalog?v='+variant,dryRun:true},session=await createOrderBrowser(order,{launch,onEvidence:async data=>{evidence.push(data);return {id:randomUUID()};}});
      try{
        const observed=await session.methods.observe();assert.ok(observed.html);assert.ok(observed.domTree.length);assert.equal(observed.forms.length,0);assert.equal(observed.elements.filter(el=>el.role==='link'&&el.text==='Order Now').length,2);assert.ok(observed.elements.some(el=>el.contextText.includes('Product A')&&el.contextText.includes('64G RAM')));
        const result=await runCommerceAgent(business,order,session,{plan});assert.equal(result.status,'prepared');assert.equal(result.review.quantity,1);assert.deepEqual(result.review.configuration,[{name:'Cycle',value:'Monthly'}]);assert.equal(counts.orders,0);
        assert.doesNotMatch(JSON.stringify(evidence.at(-1).observation),/private-csrf-token/);assert.match(evidence.at(-1).image,/^data:image\/png;base64,/);
      }finally{await session.close();}
    });
    await t.test('最终提交读取新页面的订单号，不需要未来 selector',async()=>{
      let confirmed=0;const order={...baseOrder,url:base+'/start?v=b'},session=await createOrderBrowser(order,{launch,onBeforeSubmit:async review=>{assert.equal(review.total,10);confirmed++;}});
      try{const result=await runCommerceAgent(business,order,session,{plan});assert.equal(result.status,'ordered');assert.equal(result.orderId,'ORD-1');assert.equal(confirmed,1);assert.equal(counts.orders,1);}finally{await session.close();}
    });
    await t.test('仅在当前原账单观察之后生成付款动作，提交/付款各一次',async()=>{
      let approved=0;const order={...baseOrder,url:base+'/start?v=a',executionMode:'pay'},session=await createOrderBrowser(order,{launch,onBeforeSubmit:async()=>approved++,onBeforePayment:async reviewed=>{assert.equal(reviewed.invoiceId,'42');approved++;}});
      try{const result=await runCommerceAgent(business,order,session,{plan});assert.equal(result.status,'paid');assert.equal(approved,2);assert.equal(counts.orders,2);assert.equal(counts.payments,1);}finally{await session.close();}
    });
    await t.test('网站付款方式经过多次观察仍保持实际选择',async()=>{
      const order={...baseOrder,url:base+'/start?v=w',executionMode:'pay',paymentMethod:{kind:'website',name:'Alipay'}},session=await createOrderBrowser(order,{launch});
      try{const result=await runCommerceAgent(business,order,session,{plan});assert.equal(result.status,'paid');assert.equal(result.paymentMethod.label,'Alipay');assert.equal(counts.orders,3);assert.equal(counts.payments,2);}finally{await session.close();}
    });
    await t.test('优惠应用跳转后所有 ID 变化，重新理解页面核验优惠和实际总价',async()=>{
      const order={...baseOrder,url:base+'/checkout?v=b',couponCode:'SAVE20',dryRun:true},session=await createOrderBrowser(order,{launch});
      try{const result=await runCommerceAgent(business,order,session,{plan});assert.equal(result.status,'prepared');assert.equal(result.review.total,8);assert.equal(result.review.coupon.discount,2);assert.equal(counts.coupons,1);assert.equal(counts.orders,3);}finally{await session.close();}
    });
        await t.test('服务层使用真实浏览器探索两次、保存经验、审批后提交一次',async()=>{
      const task=validateOrderTask({...baseOrder,url:base+'/catalog?v=b',monitorId:'native-monitor'}),user={id:'native-agent-user',settings:{},monitors:[{id:'native-monitor',kind:'webpage'}],orderTasks:[task],orderAccounts:[{monitorId:'native-monitor',loginUrl:task.url,revision:1,status:'saved',session:{state:{cookies:[],origins:[]},check:{url:task.url}}}]};
      let businessAttempts=0,listingRefusals=0;
      const service=createOrderService({persist:()=>{},openBrowser:(order,options)=>createOrderBrowser(order,{...options,launch}),requestAI:async(_user,messages)=>{
        if(messages[0].content===BUSINESS_PROMPT){const input=JSON.parse(messages[1].content);assert.equal(input.phase,'business_sop');assert.equal(input.discovery.followPagesAtRuntime,true);if(++businessAttempts===1)return {error:'Insufficient evidence: the category listing does not include cart or checkout DOM. Please provide confirmation page snapshots and checkout selectors.'};assert.match(input.feedback.error,/业务 SOP 不需要未来页面/);return {summary:'动态探索与核验',workflow:{version:2,requirements:[{name:'Cycle',value:'Monthly'}]}};}
        const content=messages[1].content,input=JSON.parse(Array.isArray(content)?content.find(part=>part.type==='text').text:content);if(input.page.title==='Store category'&&listingRefusals++===0)return {action:'stop',reason:'Insufficient evidence: cannot determine checkout selectors without cart and confirmation page snapshots.'};return plan({observation:input.page,context:input.context,order:input.order});
      }});
      const original=counts.orders;await service.discover(user,task);assert.equal(task.status,'ready');assert.equal(task.enabled,false);assert.equal(task.trial.preflightPasses,2);assert.equal(task.program.code,undefined);assert.equal(counts.orders,original);assert.equal(businessAttempts,2);assert.ok(user.orderExecutionLogs[0].events.some(event=>event.action==='重新观察并修复'));
      service.approve(user,task,orderProgramHash(task));await service.execute(user,task);assert.equal(task.status,'ordered');assert.equal(counts.orders,original+1);assert.equal((await service.profile(user,task)).outcomes.ordered,1);
    });
    assert.equal(requests.filter(req=>req.path==='/charge').length,2);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
