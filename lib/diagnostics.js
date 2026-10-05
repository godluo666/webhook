import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const read = async file => {try{return await fs.readFile(file,'utf8');}catch{return null;}};
export function parseCounters(text) {return Object.fromEntries(String(text||'').trim().split('\n').map(line=>line.trim().split(/\s+/)).filter(parts=>parts.length>=2&&!Number.isNaN(Number(parts[1]))).map(([key,value])=>[key,Number(value)]));}
export function parsePressure(text) {return Object.fromEntries(String(text||'').trim().split('\n').filter(line=>/^(some|full) /.test(line)).map(line=>{const [key,...values]=line.split(/\s+/);return [key,Object.fromEntries(values.map(value=>{const [name,number]=value.split('=');return [name,Number(number)];}))];}));}
export function cpuDelta(before,after) {
 const parse=text=>String(text||'').split('\n')[0].trim().split(/\s+/).slice(1,9).map(Number);
 const a=parse(before),b=parse(after);if(a.length!==8||b.length!==8)return null;
 const delta=b.map((value,i)=>Math.max(0,value-a[i])),total=delta.reduce((a,b)=>a+b,0);if(!total)return null;
 const pct=value=>Math.round(value/total*10000)/100;
 return {busyPercent:pct(total-delta[3]-delta[4]-delta[7]),ioWaitPercent:pct(delta[4]),stealPercent:pct(delta[7])};
}
async function pressures(prefix) {
 return Object.fromEntries(await Promise.all(['cpu','memory','io'].map(async key=>[key,parsePressure(await read(prefix(key)))])));
}
async function processes() {
 const ids=(await fs.readdir('/proc')).filter(id=>/^\d+$/.test(id)),summary={processes:ids.length,threads:0,states:{},blocked:[],zombies:0};
 // Four readers keep diagnostics from creating their own burst of filesystem work.
 let index=0;
 await Promise.all(Array.from({length:4},async()=>{while(index<ids.length){const pid=ids[index++],status=await read('/proc/'+pid+'/status');if(!status)continue;
  const name=status.match(/^Name:\s*(.*)$/m)?.[1]||'',rssKb=Number(status.match(/^VmRSS:\s*(\d+)/m)?.[1]||0);
  let tasks;try{tasks=await fs.readdir('/proc/'+pid+'/task');}catch{continue;}
  summary.threads+=tasks.length;
  for(const tid of tasks){const stat=await read('/proc/'+pid+'/task/'+tid+'/stat');const state=stat?.slice(stat.lastIndexOf(')')+2).split(' ')[0];if(!state)continue;
   summary.states[state]=(summary.states[state]||0)+1;if(state==='Z')summary.zombies++;
   if(state==='D'&&summary.blocked.length<50)summary.blocked.push({pid:Number(pid),tid:Number(tid),name,rssKb,wait:(await read('/proc/'+pid+'/task/'+tid+'/wchan'))?.trim()||'unavailable'});
  }
 }}));return summary;
}
export async function collectDiagnostics() {
 if(process.platform!=='linux')return {available:false,reason:'负载诊断需要在发生问题的 Linux 主机或容器内运行；当前平台为 '+process.platform};
 const before=await read('/proc/stat'),vmBefore=parseCounters(await read('/proc/vmstat')),cgBefore=parseCounters(await read('/sys/fs/cgroup/cpu.stat'));
 await new Promise(resolve=>setTimeout(resolve,1000));
 const [after,memory,pressure,cgroupPressure,processSummary,vm,cpuStat]=await Promise.all([read('/proc/stat'),read('/proc/meminfo'),pressures(key=>'/proc/pressure/'+key),pressures(key=>'/sys/fs/cgroup/'+key+'.pressure'),processes(),read('/proc/vmstat'),read('/sys/fs/cgroup/cpu.stat')]);
 const current=parseCounters(vm),cg=parseCounters(cpuStat),events=parseCounters(await read('/sys/fs/cgroup/memory.events'));
 let temporary=null;try{const stat=await fs.statfs(process.env.MONITOR_TEMP_DIR||os.tmpdir());temporary={tmpfs:stat.type===0x01021994,availableBytes:stat.bavail*stat.bsize};}catch{const stat=await fs.statfs(os.tmpdir());temporary={tmpfs:stat.type===0x01021994,availableBytes:stat.bavail*stat.bsize};}
 const hints=[];if((pressure.io.some?.avg10||0)>1||(cgroupPressure.io.some?.avg10||0)>1)hints.push('观察到 I/O 等待压力，结合 blocked.wait 检查磁盘、挂载和浏览器临时目录。');
 if((pressure.memory.some?.avg10||0)>1||(cgroupPressure.memory.some?.avg10||0)>1||current.pswpin>vmBefore.pswpin||current.pswpout>vmBefore.pswpout)hints.push('观察到内存等待或换页，检查可用内存、容器限额和同时打开的浏览器。');
 if(cg.nr_throttled>cgBefore.nr_throttled)hints.push('采样期间容器 CPU 被限额节流，即使宿主总 CPU 不高也可能排队。');
 if(processSummary.blocked.length)hints.push('存在不可中断等待线程，查看 wait；单凭 load 无法确定具体瓶颈。');
 return {available:true,at:new Date().toISOString(),scope:'load、CPU 和 hostPressure 为宿主指标；visibleProcesses 和 cgroup 为当前 PID/cgroup 命名空间，不代表宿主全部进程。',host:{cpuCount:os.cpus().length,availableParallelism:os.availableParallelism(),load:os.loadavg(),cpu:cpuDelta(before,after),memory:parseCounters(memory),pressure,vmDelta:Object.fromEntries(['pgmajfault','pswpin','pswpout'].map(key=>[key,Math.max(0,(current[key]||0)-(vmBefore[key]||0))]))},cgroup:{memoryCurrent:await read('/sys/fs/cgroup/memory.current'),memoryMax:await read('/sys/fs/cgroup/memory.max'),memoryEvents:events,cpuStat:cg,throttledDuringSample:Math.max(0,(cg.nr_throttled||0)-(cgBefore.nr_throttled||0)),pressure:cgroupPressure},visibleProcesses:processSummary,temporary,hints};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)console.log(JSON.stringify(await collectDiagnostics(),null,2));
