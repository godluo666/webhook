import {runCommerceAgent} from '../agent/executor.js';
export function discoverCommerceSite(program,order,session,options){
  if(session.dryRun!==true||session.submissionStarted||session.paymentStarted)throw new Error("探索不能复用已经提交或付款的浏览器");
  return runCommerceAgent(program,order,session,options);
}
