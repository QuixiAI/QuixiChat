/** Deliberately pre-selection writer: no catalog import, fence or revision. Test only. */
import initialize from '../../sqlite/dist/sqlite3.mjs';import wasmUrl from '../../sqlite/dist/sqlite3.wasm?url';
import type {SqlDb} from '../../src/selection/catalog.ts';
let database:SqlDb|undefined,release:(()=>void)|undefined,owner:Promise<void>|undefined;
const reply=(id:string,result:unknown)=>postMessage({id,ok:true,result});
onmessage=async({data})=>{try{
 if(data.command==='open'){
  if(!/^selection-proof-[0-9a-f-]{36}$/.test(data.args.namespace))throw new Error('Legacy fixture requires isolated namespace');
  const {namespace,archiveId}=data.args;if(!['a','b','c'].includes(archiveId))throw new Error('Invalid legacy fixture archive');
  postMessage({event:'legacy-owner-requested'});
  owner=navigator.locks.request(`quixi:${namespace}:archive:${archiveId}:owner`,async()=>{
   const held=new Promise<void>(resolve=>{release=resolve;});
   (globalThis as typeof globalThis&{sqlite3ApiConfig:unknown}).sqlite3ApiConfig={disable:{vfs:{opfs:true,'opfs-wl':true}}};
   const sqlite=await initialize({locateFile:(file:string)=>file.endsWith('.wasm')?wasmUrl:file}) as {installOpfsSAHPoolVfs(args:unknown):Promise<{OpfsSAHPoolDb:new(path:string)=>SqlDb;pauseVfs():void}>};
   const pool=await sqlite.installOpfsSAHPoolVfs({name:`legacy-${crypto.randomUUID()}`,directory:`/${namespace}-fixtures/${archiveId}`,initialCapacity:2});
   try{database=new pool.OpfsSAHPoolDb('/fixture.sqlite3');database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');if(data.args.writeOnAcquire)database.exec("INSERT INTO events(text) VALUES('legacy queued generation checkpoint')");reply(data.id,{sequence:Number(database.selectValue('SELECT max(sequence) FROM events'))});await held;}finally{database?.close();database=undefined;pool.pauseVfs();}
  });void owner.catch(error=>postMessage({id:data.id,ok:false,error:String(error)}));return;
 }
 if(data.command==='write'){if(!database)throw new Error('Legacy owner not ready');database.exec("INSERT INTO events(text) VALUES('legacy ignores selection revision')");reply(data.id,{sequence:Number(database.selectValue('SELECT max(sequence) FROM events'))});return;}
 if(data.command==='close'){release?.();await owner;reply(data.id,null);return;}
 throw new Error('Unknown legacy fixture command');
}catch(error){postMessage({id:data.id,ok:false,error:String(error)});}};
