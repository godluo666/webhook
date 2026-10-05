// Bound CDP operations that do not have their own Playwright timeout.
export function isBrowserClosedError(error) {
  return /Target (?:page, context or browser has been closed|closed)|Browser (?:has been |is )?closed|browserContext.*closed|Connection closed/i.test(String(error?.message || ''));
}
export async function browserOperation(operation, {timeoutMs=15000, signal, code='BROWSER_TIMEOUT', message='浏览器操作超时', onTimeout}={}) {
  signal?.throwIfAborted();
  let timer,abort;
  const failure=new Promise((_,reject)=>{
    timer=setTimeout(()=>{reject(Object.assign(new Error(message),{code}));if(onTimeout)void Promise.resolve().then(onTimeout).catch(()=>{});},Math.max(1,timeoutMs));
    abort=()=>reject(signal.reason);signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
  });
  try { return await Promise.race([operation(),failure]); }
  finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

// Navigation can replace the execution context while a read is in flight.
// Retry only that read, never a click, submission, navigation or payment.
export async function settledBrowserRead(operation,options={}){
  let active=true;
  try{return await browserOperation(async()=>{
    while(active){options.signal?.throwIfAborted();try{return await operation();}
      catch(error){if(!/Execution context was destroyed|Cannot find context|Unable to retrieve content because the page is navigating/i.test(String(error.message)))throw error;}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  },options);}finally{active=false;}
}
