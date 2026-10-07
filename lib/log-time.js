export const LOG_TIME_ZONE='Asia/Shanghai';
const formatter=new Intl.DateTimeFormat('sv-SE',{timeZone:LOG_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hourCycle:'h23',timeZoneName:'longOffset'});
export function shanghaiTimestamp(value=Date.now()){
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return null;
  const parts=Object.fromEntries(formatter.formatToParts(date).map(part=>[part.type,part.value]));
  const offset=parts.timeZoneName.replace('GMT','')||'+00:00';
  return parts.year+'-'+parts.month+'-'+parts.day+'T'+parts.hour+':'+parts.minute+':'+parts.second+'.'+parts.fractionalSecond+offset;
}
// Convert exported timestamp fields, including old UTC logs, without mutating stored records.
export function shanghaiLogTimes(value){
  if(Array.isArray(value))return value.map(shanghaiLogTimes);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,typeof item==='string'&&/^(?:at|.*At|.*_at)$/.test(key)&&/^\d{4}-\d{2}-\d{2}T/.test(item)?shanghaiTimestamp(item)||item:shanghaiLogTimes(item)]));
  return value;
}
