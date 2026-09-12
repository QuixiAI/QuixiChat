import type {ImportRun,ImportWorkItem,StorageOperations} from '@quixi/core/contracts';
import type {JsonObject,QuixiId} from '@quixi/core/model';
import type {ImportRuntime} from './types.ts';

export class ImportPausedError extends Error {constructor(){super('Import paused; durable source and work checkpoints are retained');this.name='ImportPausedError';}}
export class ImportSession {
 constructor(readonly runtime:ImportRuntime,readonly run:ImportRun){}
 check():void{if(this.runtime.cancelled())throw new ImportPausedError();}
 async request<K extends keyof StorageOperations>(operation:K,args:StorageOperations[K]['args']):Promise<StorageOperations[K]['result']>{this.check();return this.runtime.storage.request(this.runtime.nextId(),operation,args);}
 /** Identity allocation is persisted in storage, not derived by pretending a hash is a UUIDv4. */
 async ids(...keys:string[]):Promise<QuixiId[]>{const result=await this.request('importAllocateIds',{runId:this.run.runId,keys});return result.map(item=>item.id);}
 async id(key:string):Promise<QuixiId>{return (await this.ids(key))[0]!;}
 async operation(key:string):Promise<QuixiId>{return this.id(JSON.stringify(['operation',key]));}
}

export class WorkCheckpoint {
 constructor(readonly session:ImportSession,readonly groupKey:string,readonly key:string,private revision:number,private value:JsonObject){}
 static from(session:ImportSession,groupKey:string,item:ImportWorkItem):WorkCheckpoint{return new WorkCheckpoint(session,groupKey,item.key,item.checkpointRevision,item.checkpoint);}
 get data():JsonObject{return this.value;}
 async save(value:JsonObject):Promise<void>{
  const operationId=await this.session.operation(JSON.stringify(['checkpoint',this.groupKey,this.key,this.revision]));
  const result=await this.session.request('importWorkCheckpoint',{operationId,runId:this.session.run.runId,groupKey:this.groupKey,key:this.key,expectedRevision:this.revision,checkpoint:value});
  this.revision=result.revision;this.value=result.checkpoint;
 }
}

const leaseToken=Symbol('quixi-import-run-lease');
type LeasedRuntime=ImportRuntime&{[leaseToken]?:string};
/** Upload restart is destructive to an interrupted staging handle, so one live executor must own each run. */
export async function withRunLease<T>(runtime:ImportRuntime,runId:string,work:(leased:ImportRuntime)=>Promise<T>):Promise<T>{
 if((runtime as LeasedRuntime)[leaseToken]===runId)return work(runtime);
 const enter=()=>{if(runtime.cancelled())throw new ImportPausedError();return work({...runtime,[leaseToken]:runId} as LeasedRuntime);};
 if(runtime.withRunLock)return runtime.withRunLock(runId,enter);
 if(!globalThis.navigator?.locks)throw new Error('Import requires an injected exclusive run lease or Navigator Web Locks');
 return navigator.locks.request(`quixi:import-run:${runId}`,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw new Error('This import run is active in another tab or window');return enter();});
}
