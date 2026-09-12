/** Isolated selection-catalog prototype. No production archive/client imports. */
import initialize from '../../sqlite/dist/sqlite3.mjs';
import wasmUrl from '../../sqlite/dist/sqlite3.wasm?url';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
export interface Selection {archiveId:string;selectionRevision:number}
export interface Activation {operationId:string;expected:Selection;sourceSyncHighWater:number;candidate:{archiveId:string;manifestSha256:string};reviewToken:string;jobId:string}
export interface Receipt {operationId:string;payloadSha256:string;previous:Selection;selected:Selection;sourceSyncHighWater:number;candidateManifestSha256:string;reviewToken:string;jobId:string}
export type OperationStatus={status:'not_found'}|{status:'prepared'|'interrupted'|'failed';payloadSha256:string;reason:string|null}|{status:'committed';payloadSha256:string;receipt:Receipt};
export interface SqlDb {exec(sql:string|{sql:string;bind?:unknown[];rowMode?:string;returnValue?:string}):unknown;selectValue(sql:string,bind?:unknown[]):unknown;close():void}
interface Pool {OpfsSAHPoolDb:new(name:string,flags?:string)=>SqlDb;getFileNames():string[];pauseVfs():void;unpauseVfs():Promise<unknown>}
export interface SelectionSqlite {installOpfsSAHPoolVfs(args:{name:string;directory:string;initialCapacity:number}):Promise<Pool>}
export interface Timing {waitMs:number;openMs:number;workMs:number;closeMs:number}
export interface ReviewedActivationHooks {
  withReviewedCandidate(commitSelection:()=>Receipt):Promise<unknown>;
  signal?:AbortSignal;
  proof?:ActivationHooks['proof'];
}
export interface ActivationHooks {
  signal?:AbortSignal;
  sourceHighWater():number|Promise<number>;
  validateCandidate():Promise<void>;
  /** Fault injection only. Never wired to a production request. */
  proof?:{afterIntent?():Promise<void>;inTransaction?(db:SqlDb):void;afterCommit?():Promise<void>};
}
const filename='/selection.sqlite3',applicationId=0x51585350;
const ddl=[
 'CREATE TABLE selection (id INTEGER PRIMARY KEY CHECK(id=1), archive_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), operation_id TEXT)',
 "CREATE TABLE operations (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(length(payload)<=16384), digest TEXT NOT NULL CHECK(length(digest)=64), state TEXT NOT NULL CHECK(state IN('prepared','interrupted','failed','committed')), reason TEXT CHECK(reason IS NULL OR length(reason)<=512), receipt TEXT CHECK(receipt IS NULL OR length(receipt)<=16384))",
 'CREATE INDEX operations_state ON operations(state)',
 'CREATE TABLE retained (archive_id TEXT PRIMARY KEY, first_revision INTEGER NOT NULL CHECK(first_revision>=0))',
];
export class SelectionError extends Error {constructor(readonly code:'CONFLICT'|'UNAVAILABLE'|'INVALID_REQUEST'|'UNKNOWN_OUTCOME'|'OVERLOADED'|'CANCELLED',message:string){super(message);}}
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
function assertSelection(value:Selection){if(!value||!validId(value.archiveId)||!count(value.selectionRevision))throw new SelectionError('INVALID_REQUEST','Invalid selection fence.');}
function encode(args:Activation):string{if(!args||!uuid(args.operationId)||!uuid(args.reviewToken)||!uuid(args.jobId)||!count(args.sourceSyncHighWater)||!args.candidate||!validId(args.candidate.archiveId)||!hex(args.candidate.manifestSha256))throw new SelectionError('INVALID_REQUEST','Invalid activation payload.');assertSelection(args.expected);if(args.candidate.archiveId===args.expected.archiveId)throw new SelectionError('INVALID_REQUEST','Candidate must be isolated from the source.');return JSON.stringify({operationId:args.operationId,expected:{archiveId:args.expected.archiveId,selectionRevision:args.expected.selectionRevision},sourceSyncHighWater:args.sourceSyncHighWater,candidate:{archiveId:args.candidate.archiveId,manifestSha256:args.candidate.manifestSha256},reviewToken:args.reviewToken,jobId:args.jobId});}
const rows=(db:SqlDb,sql:string,bind:unknown[]=[])=>db.exec({sql,bind,rowMode:'object',returnValue:'resultRows'}) as Record<string,unknown>[];
function transaction<T>(db:SqlDb,work:()=>T):T{db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(error){try{db.exec('ROLLBACK');}catch{/* preserve original; caller closes the connection */}throw error;}}
let initialized:Promise<SelectionSqlite>|undefined;
export function loadSelectionSqlite():Promise<SelectionSqlite>{if(!initialized){(globalThis as typeof globalThis&{sqlite3ApiConfig:unknown}).sqlite3ApiConfig={disable:{vfs:{opfs:true,'opfs-wl':true}}};initialized=initialize({locateFile:(file:string)=>file.endsWith('.wasm')?wasmUrl:file}) as Promise<SelectionSqlite>;}return initialized;}
export class SelectionCatalog {
  private pool:Pool|undefined;private pending=0;
  readonly gate:string;readonly directory:string;lastTiming:Timing|null=null;
  constructor(readonly namespace:string,readonly initialArchiveId:string){if(!/^selection-proof-[0-9a-f-]{36}$/.test(namespace)||!validId(initialArchiveId))throw new SelectionError('INVALID_REQUEST','This prototype only accepts isolated selection-proof namespaces.');this.gate=`quixi:${namespace}:selection`;this.directory=`/${namespace}/catalog`;}
  candidateLock(archiveId:string):string {if(!validId(archiveId))throw new SelectionError('INVALID_REQUEST','Invalid archive identity.');return `quixi:${this.namespace}:archive:${archiveId}:owner`;}
  private module(){return loadSelectionSqlite();}
  private async open():Promise<SqlDb>{
    const root=await navigator.storage.getDirectory();let fresh=false;
    try{await root.getDirectoryHandle(this.namespace);}catch(error){if(!(error instanceof DOMException&&error.name==='NotFoundError'))throw error;fresh=true;await root.getDirectoryHandle(this.namespace,{create:true});}
    let db:SqlDb|undefined;
    try{if(!this.pool)this.pool=await(await this.module()).installOpfsSAHPoolVfs({name:`selection-${crypto.randomUUID()}`,directory:this.directory,initialCapacity:4});else await this.pool.unpauseVfs();
      if(!fresh&&!this.pool.getFileNames().includes(filename))throw new SelectionError('UNAVAILABLE','Existing selection catalog is absent or unreadable; recovery is required.');
      db=new this.pool.OpfsSAHPoolDb(filename,fresh?'c':'w');db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
      if(fresh)transaction(db,()=>{for(const sql of ddl)db!.exec(sql);db!.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=1;`);db!.exec({sql:'INSERT INTO selection VALUES(1,?,0,NULL)',bind:[this.initialArchiveId]});db!.exec({sql:'INSERT INTO retained VALUES(?,0)',bind:[this.initialArchiveId]});});
      if(Number(db.selectValue('PRAGMA application_id'))!==applicationId||Number(db.selectValue('PRAGMA user_version'))!==1)throw new SelectionError('UNAVAILABLE','Selection catalog identity or schema is invalid.');
      const schema=rows(db,"SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").map(row=>String(row.sql));if(JSON.stringify(schema)!==JSON.stringify([...ddl].sort((a,b)=>a.split(' ')[2]!.localeCompare(b.split(' ')[2]!))))throw new SelectionError('UNAVAILABLE','Selection schema differs from the approved prototype.');
      this.current(db);db.exec("UPDATE operations SET state='interrupted',reason='Prior storage worker ended before atomic selection commit.' WHERE state='prepared'");return db;
    }catch(error){try{db?.close();}finally{this.pool?.pauseVfs();}throw new SelectionError('UNAVAILABLE',`Selection catalog could not be opened; retained archives were not replaced. ${String(error).slice(0,512)}`);}
  }
  private current(db:SqlDb):Selection {const row=rows(db,'SELECT archive_id,revision,operation_id FROM selection WHERE id=1')[0];if(!row)throw new SelectionError('UNAVAILABLE','Selection head is missing.');const result={archiveId:String(row.archive_id),selectionRevision:Number(row.revision)};assertSelection(result);if(row.operation_id!==null){const receipt=this.operation(db,String(row.operation_id));if(receipt.status!=='committed'||JSON.stringify(receipt.receipt.selected)!==JSON.stringify(result))throw new SelectionError('UNAVAILABLE','Selection head has no matching committed receipt.');}else if(result.selectionRevision!==0)throw new SelectionError('UNAVAILABLE','Unreceipted selection revision.');return result;}
  private operation(db:SqlDb,id:string,payload?:string):OperationStatus {if(!uuid(id))throw new SelectionError('INVALID_REQUEST','Invalid operation identity.');const row=rows(db,'SELECT payload,digest,state,reason,receipt FROM operations WHERE id=?',[id])[0];if(!row)return{status:'not_found'};if(payload!==undefined&&row.payload!==payload)throw new SelectionError('CONFLICT','Operation identity already belongs to a different full review payload.');if(typeof row.payload!=='string'||row.payload.length>16_384||bytesToHex(sha256(new TextEncoder().encode(row.payload)))!==row.digest)throw new SelectionError('UNAVAILABLE','Operation payload digest differs.');if(row.state==='committed'){if(typeof row.receipt!=='string'||row.receipt.length>16_384)throw new SelectionError('UNAVAILABLE','Invalid committed receipt.');const receipt=JSON.parse(row.receipt) as Receipt;const original=JSON.parse(row.payload) as Activation;const expected:Receipt={operationId:id,payloadSha256:String(row.digest),previous:original.expected,selected:{archiveId:original.candidate.archiveId,selectionRevision:original.expected.selectionRevision+1},sourceSyncHighWater:original.sourceSyncHighWater,candidateManifestSha256:original.candidate.manifestSha256,reviewToken:original.reviewToken,jobId:original.jobId};if(JSON.stringify(receipt)!==JSON.stringify(expected))throw new SelectionError('UNAVAILABLE','Receipt identity differs.');return{status:'committed',payloadSha256:String(row.digest),receipt};}if(!['prepared','interrupted','failed'].includes(String(row.state))||row.receipt!==null)throw new SelectionError('UNAVAILABLE','Invalid intent state.');return{status:row.state as 'prepared'|'interrupted'|'failed',payloadSha256:String(row.digest),reason:row.reason===null?null:String(row.reason)};}
  private async gated<T>(work:(db:SqlDb)=>Promise<T>|T):Promise<T>{if(this.pending>=16)throw new SelectionError('OVERLOADED','Selection request admission is full.');this.pending++;const start=performance.now();try{return await navigator.locks.request(this.gate,{mode:'exclusive'},async()=>{const entered=performance.now(),db=await this.open(),opened=performance.now();try{return await work(db);}finally{const worked=performance.now();try{db.close();}finally{this.pool!.pauseVfs();this.lastTiming={waitMs:entered-start,openMs:opened-entered,workMs:worked-opened,closeMs:performance.now()-worked};}}});}finally{this.pending--;}}
  read():Promise<Selection>{return this.gated(db=>this.current(db));}
  status(operationId:string,payload?:Activation):Promise<OperationStatus>{const encoded=payload===undefined?undefined:encode(payload);if(payload&&payload.operationId!==operationId)throw new SelectionError('INVALID_REQUEST','Status payload operation identity differs.');return this.gated(db=>this.operation(db,operationId,encoded));}
  guard<T>(expected:Selection,effect:()=>Promise<T>):Promise<T>{assertSelection(expected);expected={...expected};return this.gated(async db=>{this.assertCurrent(db,expected);return effect();});}
  private assertCurrent(db:SqlDb,expected:Selection){const current=this.current(db);if(current.archiveId!==expected.archiveId||current.selectionRevision!==expected.selectionRevision)throw new SelectionError('CONFLICT','Archive selection changed; this context cannot write.');}
  activate(args:Activation,hooks:ActivationHooks):Promise<Receipt>{
    args=JSON.parse(encode(args)) as Activation;
    // Legacy proof adapter. Production ArchiveRepository already owns this lock.
    return this.activateReviewed(args,{...(hooks.signal?{signal:hooks.signal}:{}),...(hooks.proof?{proof:hooks.proof}:{}),withReviewedCandidate:async commit=>{
      if(await hooks.sourceHighWater()!==args.sourceSyncHighWater)throw new SelectionError('CONFLICT','Source sync high-water changed after review.');
      return navigator.locks.request(this.candidateLock(args.candidate.archiveId),{mode:'exclusive',ifAvailable:true},async lock=>{
        if(!lock)throw new SelectionError('CONFLICT','Candidate owner is already active.');await hooks.validateCandidate();
        if(await hooks.sourceHighWater()!==args.sourceSyncHighWater)throw new SelectionError('CONFLICT','Source changed during candidate validation.');return commit();
      });
    }});
  }
  /** One selection gate; the external reviewed barrier alone owns candidate lock.
   * The synchronous publication closure cannot escape or be reused. */
  activateReviewed(args:Activation,hooks:ReviewedActivationHooks):Promise<Receipt>{
    const payload=encode(args),digest=bytesToHex(sha256(new TextEncoder().encode(payload)));args=JSON.parse(payload) as Activation;
    const stopped=()=>{if(hooks.signal?.aborted)throw new SelectionError('CANCELLED','Selection activation cancelled before publication.');};
    return this.gated(async db=>{
      const prior=this.operation(db,args.operationId,payload);if(prior.status==='committed')return prior.receipt;
      stopped();this.assertCurrent(db,args.expected);if(args.expected.selectionRevision===Number.MAX_SAFE_INTEGER)throw new SelectionError('CONFLICT','Selection revision exhausted.');
      transaction(db,()=>db.exec({sql:"INSERT INTO operations VALUES(?,?,?,'prepared',NULL,NULL) ON CONFLICT(id) DO UPDATE SET state='prepared',reason=NULL",bind:[args.operationId,payload,digest]}));
      let receipt:Receipt|undefined,valid=false,used=false;
      const commitSelection=():Receipt=>{
        if(!valid||used)throw new SelectionError('CONFLICT','Selection publication callback expired or was already used.');used=true;stopped();this.assertCurrent(db,args.expected);
        const next:Receipt={operationId:args.operationId,payloadSha256:digest,previous:args.expected,selected:{archiveId:args.candidate.archiveId,selectionRevision:args.expected.selectionRevision+1},sourceSyncHighWater:args.sourceSyncHighWater,candidateManifestSha256:args.candidate.manifestSha256,reviewToken:args.reviewToken,jobId:args.jobId};
        transaction(db,()=>{db.exec({sql:'UPDATE selection SET archive_id=?,revision=?,operation_id=? WHERE id=1',bind:[next.selected.archiveId,next.selected.selectionRevision,args.operationId]});db.exec({sql:"UPDATE operations SET state='committed',reason=NULL,receipt=? WHERE id=?",bind:[JSON.stringify(next),args.operationId]});db.exec({sql:'INSERT OR IGNORE INTO retained VALUES(?,?)',bind:[next.selected.archiveId,next.selected.selectionRevision]});hooks.proof?.inTransaction?.(db);});receipt=next;return structuredClone(next);
      };
      try{
        await hooks.proof?.afterIntent?.();stopped();valid=true;
        try{await hooks.withReviewedCandidate(commitSelection);}finally{valid=false;}
        if(!receipt)throw new SelectionError('CONFLICT','Reviewed barrier returned without publishing a selection.');
        await hooks.proof?.afterCommit?.();return receipt;
      }catch(error){valid=false;if(receipt)return receipt; // Postcommit cleanup/cancellation cannot undo known success.
        const failure=hooks.signal?.aborted?new SelectionError('CANCELLED','Selection activation cancelled before publication.'):error;
        try{db.exec({sql:"UPDATE operations SET state='failed',reason=? WHERE id=? AND state='prepared'",bind:[String(failure).slice(0,512),args.operationId]});}catch{/* Next owner distinguishes interrupted from committed using the SQL receipt. */}throw failure;
      }
    });
  }
  /** Explicit full check; not on the generation hot path. */
  integrity():Promise<string>{return this.gated(db=>String(db.selectValue('PRAGMA integrity_check')));}
}
