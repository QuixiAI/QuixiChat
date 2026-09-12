import type { GenerationProducer, ProducerOperations, CanonicalMutation } from '@quixi/core/contracts';
import type { CanonicalSqlite, CanonicalRepository } from './canonical/repository.ts';
import { BlobStorageError } from './blobs.ts';
import { producerLockName } from '../producer-protocol.ts';
/** Local metadata is durable; liveness comes from an independent producer lock,
 * never from a wall-clock heartbeat or the storage owner's identity.
 */
export class ProducerRepository {
  private after = '';
  constructor(private readonly db:CanonicalSqlite, private readonly canonical:CanonicalRepository, private readonly archiveId:string){}
  private row(generationId:string):GenerationProducer|null {
    const rows=this.db.exec({sql:'SELECT generation_id,producer_id,state FROM quixi_generation_producers WHERE generation_id=?',bind:[generationId],rowMode:'object',returnValue:'resultRows'}) as {generation_id:string;producer_id:string;state:GenerationProducer['state']}[];
    const row=rows[0];return row?{generationId:row.generation_id,producerId:row.producer_id,state:row.state}:null;
  }
  private set(generationId:string,state:GenerationProducer['state']):void {this.db.exec({sql:'UPDATE quixi_generation_producers SET state=? WHERE generation_id=?',bind:[state,generationId]});}
  async register(args:ProducerOperations['registerGenerationProducer']['args']):Promise<GenerationProducer> {
    return navigator.locks.request(producerLockName(this.archiveId,args.generationId),{ifAvailable:true},lock=>{
      if(lock)throw new BlobStorageError('CONFLICT','Acquire the independent producer lock before registration');
      const existing=this.row(args.generationId);
      if(existing){if(existing.producerId!==args.producerId||existing.state!=='active')throw new BlobStorageError('CONFLICT','Generation producer identity is already fenced');return existing;}
      if(this.canonical.get('generations',args.generationId))throw new BlobStorageError('CONFLICT','Producer registration requires a fresh generation identity');
      if(Number(this.db.selectValue("SELECT count(*) FROM quixi_generation_producers WHERE state IN('active','released')"))>=64)throw new BlobStorageError('OVERLOADED','Too many unsettled generation producers');
      this.db.exec({sql:"INSERT INTO quixi_generation_producers VALUES(?,?,'active')",bind:[args.generationId,args.producerId]});
      return { ...args, state:'active' };
    });
  }
  release(args:ProducerOperations['releaseGenerationProducer']['args']):GenerationProducer {
    const existing=this.row(args.generationId);
    if(!existing)throw new BlobStorageError('NOT_FOUND','Generation producer was not registered');
    if(existing.producerId!==args.producerId)throw new BlobStorageError('CONFLICT','Generation producer identity differs');
    if(existing.state==='active')this.set(args.generationId,'released');
    return this.row(args.generationId)!;
  }
  /** Before an ordinary write, a lost/released producer cannot append output or
   * create a delayed attempt. Recovery writes call the canonical repository only
   * while holding the now-unowned producer lock.
   */
  async assertWritable(mutations:readonly CanonicalMutation[]):Promise<void> {
    const ids=new Set<string>();
    for(const mutation of mutations){
      if(mutation.kind==='CreateGeneration')ids.add(mutation.payload.generation.id);
      if(mutation.kind==='AppendGenerationOutput'||mutation.kind==='CompleteGeneration')ids.add(mutation.payload.generationId);
      if(mutation.kind==='AttachContent'){const message=this.canonical.get('messages',mutation.payload.messageId);if(message?.generationId)ids.add(message.generationId);}
    }
    for(const generationId of ids){
      const row=this.row(generationId);if(!row)continue; // Imported/uncoordinated histories are never guessed lost.
      if(row.state!=='active')throw new BlobStorageError('CONFLICT','Generation producer is no longer active');
      await navigator.locks.request(producerLockName(this.archiveId,generationId),{ifAvailable:true},lock=>{
        if(lock)throw new BlobStorageError('CONFLICT','Generation producer lock was released before its write');
      });
    }
  }
  async reconcile(maxProducers:number):Promise<ProducerOperations['reconcileGenerationProducers']['result']> {
    if(!Number.isSafeInteger(maxProducers)||maxProducers<1||maxProducers>32)throw new BlobStorageError('INVALID_REQUEST','Invalid reconciliation budget');
    let rows=this.db.exec({sql:"SELECT generation_id FROM quixi_generation_producers WHERE state IN('active','released') AND generation_id>? ORDER BY generation_id LIMIT ?",bind:[this.after,maxProducers],rowMode:'object',returnValue:'resultRows'}) as {generation_id:string}[];
    if(!rows.length&&this.after){this.after='';rows=this.db.exec({sql:"SELECT generation_id FROM quixi_generation_producers WHERE state IN('active','released') ORDER BY generation_id LIMIT ?",bind:[maxProducers],rowMode:'object',returnValue:'resultRows'}) as {generation_id:string}[];}
    let recovered=0;const operationIds:string[]=[];
    for(const row of rows){
      this.after=row.generation_id;
      const generation=this.canonical.get('generations',row.generation_id);
      if(generation&&generation.status!=='streaming'){this.set(row.generation_id,'finished');continue;}
      await navigator.locks.request(producerLockName(this.archiveId,row.generation_id),{ifAvailable:true},lock=>{
        if(!lock)return;
        // Hold the liveness lock through the canonical transaction and fence.
        // A replacement producer cannot begin in the check-to-commit interval.
        if(generation){
          const ids:string[]=[];
          recovered+=this.canonical.recoverInterrupted({generationIds:[generation.id],nextId:()=>{const id=crypto.randomUUID();ids.push(id);return id;},now:()=>Date.now()}).recovered;
          for(const id of ids)if(this.canonical.operationStatus(id).status==='committed')operationIds.push(id);
        }
        this.set(row.generation_id,'lost');
      });
    }
    return {checked:rows.length,recovered,remaining:Boolean(this.db.selectValue("SELECT EXISTS(SELECT 1 FROM quixi_generation_producers WHERE state IN('active','released'))")),operationIds};
  }
}
