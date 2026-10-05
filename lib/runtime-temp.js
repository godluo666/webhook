import fs from 'node:fs';
import path from 'node:path';
// Existing read-only deployments may only mount .data. Keep them usable while
// updated Compose moves these transient files to bounded /tmp tmpfs.
export function configureRuntimeTemp(dataDir,{env=process.env,filesystem=fs}={}) {
 if(!env.MONITOR_TEMP_DIR)return;
 let directory=env.MONITOR_TEMP_DIR;
 const probe=()=>{filesystem.mkdirSync(directory,{recursive:true,mode:0o700});const test=filesystem.mkdtempSync(path.join(directory,'probe-'));filesystem.rmdirSync(test);};
 try{probe();}catch(error){if(!['EROFS','EACCES'].includes(error.code))throw error;directory=path.join(dataDir,'browser-tmp');probe();}
 env.MONITOR_TEMP_DIR=directory;env.TMPDIR=directory;env.XDG_CACHE_HOME=path.join(directory,'cache');env.XDG_CONFIG_HOME=path.join(directory,'config');
 return directory;
}
