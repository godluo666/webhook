// One unreferenced expiry timer per non-empty cache, cleared when it becomes empty.
export class ExpiringMap extends Map {
  constructor({ttlMs,maxEntries=200,expiresAt,now=Date.now}={}){super();this.ttlMs=ttlMs;this.maxEntries=maxEntries;this.expiresAt=expiresAt;this.now=now;this.deadlines=new Map();this.timer=null;this.nextAt=null;}
  set(key,value){const deadline=this.expiresAt?this.expiresAt(value):this.now()+this.ttlMs;if(!Number.isFinite(deadline))throw new Error('Cache expiry is required');super.set(key,value);this.deadlines.set(key,deadline);while(super.size>this.maxEntries){const oldest=super.keys().next().value;super.delete(oldest);this.deadlines.delete(oldest);}this.arm();return this;}
  get(key){if(!this.has(key))return undefined;return super.get(key);}
  has(key){if(!super.has(key))return false;if(this.deadlines.get(key)<=this.now()){this.delete(key);return false;}return true;}
  delete(key){const deleted=super.delete(key);this.deadlines.delete(key);this.arm();return deleted;}
  clear(){super.clear();this.deadlines.clear();clearTimeout(this.timer);this.timer=null;this.nextAt=null;}
  prune(){const now=this.now();for(const [key,deadline]of this.deadlines)if(deadline<=now){super.delete(key);this.deadlines.delete(key);}this.arm();}
  arm(){let next=null;for(const deadline of this.deadlines.values())if(next===null||deadline<next)next=deadline;if(next===this.nextAt&&this.timer)return;clearTimeout(this.timer);this.timer=null;this.nextAt=next;if(next!==null){this.timer=setTimeout(()=>{this.timer=null;this.nextAt=null;this.prune();},Math.max(1,next-this.now()));this.timer.unref();}}
}
