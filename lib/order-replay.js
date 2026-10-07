import {load} from 'cheerio';
import {runOrderPaymentCode} from './order-workflow.js';
import {parseOrderTotal} from './order-browser.js';

// Static, offline DOM replay. Cheerio never executes merchant JS or sends a request.
// Results belong to this fixture, never to a live task's approval or payment state.
export async function replayOrderPayment({paymentCode,order={},receipt,pages,confirmationPage}) {
  if(!Number.isFinite(order.maxTotal)||order.maxTotal<=0)throw new Error('回放需要有效的订单金额上限');
  if(!Array.isArray(pages)||!pages.length||pages.length>2)throw new Error('回放需要订单确认页和可选的关联账单页，最多两页');
  for(const page of [...pages,...(confirmationPage?[confirmationPage]:[])]){
    if(typeof page.html!=='string'||page.html.length>1_000_000)throw new Error('回放 HTML 缺失或过大');
    if(!['http:','https:'].includes(new URL(page.url).protocol))throw new Error('回放页面地址无效');
  }
  if(confirmationPage&&new URL(confirmationPage.url).origin!==new URL(pages[0].url).origin)throw new Error('付款结果回放页面必须与原订单同源');
  let index=0,$=load(pages[0].html),checks;
  const one=selector=>{if(typeof selector!=='string'||!selector||selector.length>500)throw new Error('回放选择器无效');const field=$(selector);if(field.length!==1)throw new Error('回放元素不存在或不唯一：'+selector);return field;};
  const methods={
    exists:async selector=>$(selector).length===1,
    text:async selector=>one(selector).text(),
    wait:async selector=>{one(selector);return true;},
    snapshot:async selector=>{
      const root=selector?one(selector):$('body');
      const nodes=root.find('a,button,input,select,textarea,form,[id],label').toArray();
      return {url:pages[index].url,title:$('title').text(),text:root.text().slice(0,12000),truncated:{elements:nodes.length>160},elements:nodes.slice(0,160).map(node=>{const el=$(node);return {tag:node.name,id:el.attr('id')||'',name:el.attr('name'),type:el.attr('type'),text:node.name==='input'?'':el.text().trim().slice(0,120),href:el.attr('href'),action:el.attr('action'),label:el.attr('aria-label')||'',value:el.attr('type')==='radio'?el.attr('value'):undefined,options:node.name==='select'?el.find('option').toArray().map(o=>({value:$(o).attr('value'),text:$(o).text()})):undefined};})};
    },
    invoice:async selector=>{
      const link=one(selector),target=new URL(link.attr('href'),pages[index].url);
      if(link[0].name!=='a'||index!==0||!pages[1]||target.origin!==new URL(pages[0].url).origin||target.href!==pages[1].url)throw new Error('回放账单必须对应提供的同源关联页面');
      index++;$=load(pages[index].html);return {...receipt,url:pages[index].url};
    },
    pay:async value=>{
      checks=value;
      for(const key of ['paySelector','invoiceSelector','totalSelector','currencySelector'])one(checks[key]);
      if(typeof checks.confirmationSelector!=='string'||!checks.confirmationSelector)throw new Error('缺少付款结果选择器');
      const invoice=one(checks.invoiceSelector);
      if(!invoice.attr('name')||!invoice.closest('form').length||invoice.closest('form')[0]!==one(checks.paySelector).closest('form')[0])throw new Error('回放的付款控件与账单字段不属于同一表单');
      if(!receipt?.invoiceId||String(invoice.val())!==String(receipt.invoiceId))throw new Error('回放账单号与原订单不符');
      const total=parseOrderTotal(one(checks.totalSelector).text());
      const currency=(one(checks.currencySelector).text()||one(checks.currencySelector).val()||'').match(/\b[A-Z]{3}\b/g);
      if(total!==receipt.review?.total||total>order.maxTotal||currency?.length!==1||currency[0]!==receipt.review?.currency)throw new Error('回放金额或币种与原订单不符');
      return {status:'replayed'};
    }
  };
  await runOrderPaymentCode(paymentCode,order,methods,receipt);
  if(index!==pages.length-1)throw new Error('提供的关联账单页未被定位代码使用');
  if(confirmationPage){const result=load(confirmationPage.html)(checks.confirmationSelector);if(result.length!==1||!result.text().trim())throw new Error('回放的付款结果页不能匹配结果选择器');}
  return {status:'replayed',invoicePages:pages.length,confirmationSelector:confirmationPage?'matched':'unverified',financialRequests:0,livePaymentVerified:false};
}
