// Reserve capacity for triggered orders. Closing still owns a slot until exit,
// but immediate follow-up operations may wait briefly for that exit.
export function createBrowserSlots({max=4,backgroundMax=2}={}) {
  let active=0,background=0,closing=0,verifying=0;
  const waiters=new Set();
  const slots={
    acquire(financial=false,{verification=false}={}) {
      if(active>=max || verification&&verifying>=1 || !financial&&!verification&&background>=backgroundMax) throw Object.assign(new Error('浏览器服务繁忙，请关闭不需要的登录页面后重试'),{code:'ORDER_BROWSER_BUSY'});
      active++;if(verification)verifying++;else if(!financial)background++;
      let released=false,isClosing=false;
      const release=()=>{if(released)return;released=true;active--;if(verification)verifying--;else if(!financial)background--;if(isClosing)closing--;for(const wake of [...waiters])wake();};
      release.closing=()=>{if(!released&&!isClosing){isClosing=true;closing++;}};
      return release;
    },
    async acquireWhenClosing(financial=false,{signal,timeoutMs=5000,verification=false}={}) {
      const deadline=Date.now()+timeoutMs;
      for(;;){signal?.throwIfAborted();try{return slots.acquire(financial,{verification});}catch(error){
        const remaining=deadline-Date.now();if(!closing&&!verifying||remaining<=0||waiters.size>=8)throw error;
        await new Promise((resolve,reject)=>{
          let timer;const cleanup=()=>{clearTimeout(timer);waiters.delete(wake);signal?.removeEventListener('abort',abort);};
          const wake=()=>{cleanup();resolve();},abort=()=>{cleanup();reject(signal.reason);};
          waiters.add(wake);timer=setTimeout(()=>{cleanup();reject(error);},remaining);timer.unref?.();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
        });
      }}
    },
    get active(){return active;},get background(){return background;},get waiting(){return waiters.size;}
  };return slots;
}
