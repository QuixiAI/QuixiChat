import {SelectionCatalog,SelectionError,loadSelectionSqlite} from '../../src/selection/catalog.ts';
import type {Activation,Selection,SqlDb} from '../../src/selection/catalog.ts';
interface Pool {OpfsSAHPoolDb:new(name:string,flags?:string)=>SqlDb;pauseVfs():void;unpauseVfs():Promise<unknown>}
let catalog:SelectionCatalog,namespace:string;const pools=new Map<string,Pool>();let queue=Promise.resolve();let resumeProof:(()=>void)|undefined;let expiredCommit:(()=>unknown)|undefined;
const event=(phase:string)=>postMessage({event:phase});
const sqlite=loadSelectionSqlite;
async function fixture<T>(archiveId:string,work:(db:SqlDb)=>Promise<T>|T):Promise<T>{let pool=pools.get(archiveId);if(!pool){pool=await(await sqlite()).installOpfsSAHPoolVfs({name:`fixture-${crypto.randomUUID()}`,directory:`/${namespace}-fixtures/${archiveId}`,initialCapacity:2});pools.set(archiveId,pool);}else await pool.unpauseVfs();let db:SqlDb|undefined;try{db=new pool.OpfsSAHPoolDb('/fixture.sqlite3');db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY, text TEXT NOT NULL);');return await work(db);}finally{try{db?.close();}finally{pool.pauseVfs();}}}
const source=<T>(archiveId:string,work:()=>Promise<T>)=>navigator.locks.request(catalog.candidateLock(archiveId),{mode:'exclusive'},work);
function forever():Promise<void>{return new Promise(()=>{});}
async function damage(directory:FileSystemDirectoryHandle):Promise<boolean>{for await(const handle of (directory as unknown as {values():AsyncIterable<FileSystemHandle>}).values()){if(handle.kind==='directory'){if(await damage(handle as FileSystemDirectoryHandle))return true;}else{const file=handle as FileSystemFileHandle;const access=await file.createSyncAccessHandle();try{const bytes=new Uint8Array(Math.min(8192,access.getSize()));access.read(bytes,{at:0});const needle=new TextEncoder().encode('SQLite format 3');for(let offset=0;offset+needle.length<bytes.length;offset++){if(needle.every((value,index)=>bytes[offset+index]===value)){access.write(new Uint8Array(16).fill(0x5a),{at:offset});access.flush();return true;}}}finally{access.close();}}}return false;}
async function execute(command:string,args:Record<string,any>):Promise<unknown>{
 switch(command){
 case 'open':namespace=args.namespace;catalog=new SelectionCatalog(namespace,'a');return catalog.read();
 case 'read':return catalog.read();
 case 'status':return catalog.status(args.operationId,args.payload);
 case 'timing':return catalog.lastTiming;
 case 'admission':{const expected=await catalog.read();let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});const first=catalog.guard(expected,async()=>{entered();await hold;});await ready;const waiting=Array.from({length:15},()=>catalog.read());let rejected=false;try{await catalog.read();}catch(error){rejected=(error as SelectionError).code==='OVERLOADED';}release();await first;await Promise.all(waiting);return rejected;}
 case 'seed':for(const archiveId of ['a','b','c'])await source(archiveId,()=>fixture(archiveId,db=>{if(!db.selectValue('SELECT count(*) FROM events'))db.exec("INSERT INTO events VALUES(10,'committed sentinel')");}));return null;
 case 'fixture':return source(args.archiveId,()=>fixture(args.archiveId,db=>({highWater:Number(db.selectValue('SELECT coalesce(max(sequence),0) FROM events')),count:Number(db.selectValue('SELECT count(*) FROM events')),integrity:String(db.selectValue('PRAGMA integrity_check'))})));
 case 'guard':return source(args.expected.archiveId,()=>catalog.guard(args.expected,()=>fixture(args.expected.archiveId,async db=>{if(args.delay){event('guard-entered');await new Promise(resolve=>setTimeout(resolve,args.delay));}db.exec({sql:'INSERT INTO events(text) VALUES(?)',bind:[args.text??'generation checkpoint']});return{sequence:Number(db.selectValue('SELECT max(sequence) FROM events'))};})));
 case 'expiredCommit':{try{expiredCommit?.();return false;}catch(error){return(error as SelectionError).code==='CONFLICT';}}
 case 'refuseUnqualifiedActivation':{const snapshot=await navigator.locks.query();event('legacy-cohort-unqualified');postMessage({event:'compatibility-observation',held:snapshot.held?.filter(lock=>lock.name===catalog.candidateLock(args.activation.expected.archiveId)).length??0,pending:snapshot.pending?.filter(lock=>lock.name===catalog.candidateLock(args.activation.expected.archiveId)).length??0});throw new SelectionError('UNAVAILABLE','Activation remains disabled: writer cohort is unqualified. A lock snapshot cannot certify old contexts are closed.');}
 case 'reviewed':return source(args.activation.expected.archiveId,()=>fixture(args.activation.expected.archiveId,db=>{const cancellation=new AbortController();return catalog.activateReviewed(args.activation,{signal:cancellation.signal,withReviewedCandidate:commit=>navigator.locks.request(catalog.candidateLock(args.activation.candidate.archiveId),{mode:'exclusive',ifAvailable:true},async lock=>{
  if(!lock)throw new SelectionError('CONFLICT','Reviewed barrier could not acquire candidate owner.');
  expiredCommit=commit;
  if(args.mode==='cancel-throw'){cancellation.abort();throw new Error('Unrelated validator failure during cancellation');}
  if(args.mode==='throw')throw new Error('Validator threw before publication');
  if(args.mode==='return')return;
  if(Number(db.selectValue('SELECT max(sequence) FROM events'))!==args.activation.sourceSyncHighWater)throw new SelectionError('CONFLICT','Reviewed source high-water changed');
  await fixture(args.activation.candidate.archiveId,candidate=>{if(candidate.selectValue('PRAGMA integrity_check')!=='ok')throw new Error('Reviewed candidate integrity failed');});
  const snapshot=await navigator.locks.query();if(snapshot.held?.filter(item=>item.name===catalog.candidateLock(args.activation.candidate.archiveId)).length!==1)throw new Error('Candidate lock must have exactly one owner');
  if(args.mode==='cancel-before')cancellation.abort();const receipt=commit();
  if(args.mode==='double'){let rejected=false;try{commit();}catch(error){rejected=(error as SelectionError).code==='CONFLICT';}if(!rejected)throw new Error('Second publication was not rejected');}
  if(args.mode==='cancel-after')cancellation.abort();if(args.mode==='throw-after')throw new Error('Validator cleanup threw after publication');
  return receipt;
 })});}));
 case 'activate':return source(args.activation.expected.archiveId,()=>fixture(args.activation.expected.archiveId,db=>catalog.activate(args.activation as Activation,{
  sourceHighWater:()=>Number(db.selectValue('SELECT max(sequence) FROM events')),
  validateCandidate:()=>fixture(args.activation.candidate.archiveId,candidate=>{if(args.failValidation)throw new SelectionError('CONFLICT','Synthetic candidate hash no longer matches.');if(candidate.selectValue('PRAGMA integrity_check')!=='ok'||candidate.selectValue('SELECT text FROM events WHERE sequence=10')!=='committed sentinel')throw new Error('Candidate fixture validation failed.');}),
  proof:{afterIntent:async()=>{if(args.hang==='intent'){event('intent-durable');await forever();}if(args.pause==='intent'){event('intent-paused');await new Promise<void>(resolve=>{resumeProof=resolve;});resumeProof=undefined;}},inTransaction:selection=>{if(args.sqlFull){const count=selection.selectValue('PRAGMA page_count');selection.exec(`PRAGMA max_page_count=${count}`);selection.exec('CREATE TABLE proof_pressure(bytes BLOB); INSERT INTO proof_pressure VALUES(zeroblob(1048576));');}if(args.pressure){selection.exec('CREATE TABLE proof_pressure(bytes BLOB); INSERT INTO proof_pressure VALUES(zeroblob(8388608));');}if(args.hang==='transaction'){event('transaction-open');for(;;){/* Deliberate actual worker-termination boundary, test only. */}}},afterCommit:async()=>{if(args.hang==='reply'){event('selection-committed');await forever();}}}
 })));
 case 'holdCandidate':return source(args.archiveId,async()=>{event('candidate-held');await forever();});
 case 'integrity':return catalog.integrity();
 case 'damage':{const root=await navigator.storage.getDirectory();return navigator.locks.request(catalog.gate,async()=>damage(await root.getDirectoryHandle(namespace)));}
 default:throw new Error('Unknown proof command');
 }
}
onmessage=({data})=>{if(data.command==='resumeProof'){resumeProof?.();postMessage({id:data.id,ok:true,result:null});return;}queue=queue.then(async()=>{try{const result=await execute(data.command,data.args);postMessage({id:data.id,ok:true,result});}catch(error){const value=error as Error&{code?:string;resultCode?:number};postMessage({id:data.id,ok:false,error:{message:String(value.message),code:value.code??'IO_ERROR',resultCode:value.resultCode}});}});};
