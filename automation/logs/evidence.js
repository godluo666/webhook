import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export function createEvidenceStore({directory,maxRecords=40}){
  const owner=value=>createHash('sha256').update(value).digest('hex');
  async function save(scope,{stage,observation,image}){
    const id=randomUUID(),folder=path.join(directory,owner(scope));await fs.mkdir(folder,{recursive:true});
    await fs.writeFile(path.join(folder,id+'.json'),JSON.stringify({schemaVersion:1,id,stage,at:new Date().toISOString(),observation}),{mode:0o600});
    if(image)await fs.writeFile(path.join(folder,id+'.png'),Buffer.from(image.split(',')[1],'base64'),{mode:0o600});
    const records=(await fs.readdir(folder)).filter(name=>/^[\w-]+\.json$/.test(name));
    const dated=await Promise.all(records.map(async name=>({name,mtime:(await fs.stat(path.join(folder,name))).mtimeMs})));
    for(const old of dated.sort((a,b)=>b.mtime-a.mtime).slice(maxRecords)){await fs.rm(path.join(folder,old.name),{force:true});await fs.rm(path.join(folder,old.name.replace(/\.json$/,'.png')),{force:true});}
    return {id,stage};
  }
  async function read(scope,id,format='json'){
    if(!/^[0-9a-f-]{36}$/.test(id)||!['json','png'].includes(format))throw new Error("页面证据编号或格式无效");
    return fs.readFile(path.join(directory,owner(scope),id+'.'+format));
  }
  return {save,read};
}
