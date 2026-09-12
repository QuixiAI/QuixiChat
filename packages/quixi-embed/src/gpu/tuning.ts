import {sha256} from './model.ts';
export type ProjectionVariant='baseline'|'tiled';
export type TuningBucket='small'|'medium'|'large';
export interface TuningRecord {
  schema:1;key:string;createdAt:string;status:'complete'|'budget-exhausted';
  selections:Record<TuningBucket,ProjectionVariant>;
  samples:Partial<Record<TuningBucket,Record<ProjectionVariant,number[]>>>;
  probes:number;elapsedMs:number;
}
/** The product's storage owner may persist these records; the GPU worker opens no database. */
export interface TuningCache {get(key:string):Promise<unknown>;set(key:string,value:TuningRecord):Promise<void>}
const BUCKETS=['small','medium','large'] as const;
export function tuningBucket(rows:number):TuningBucket{return rows<128?'small':rows<512?'medium':'large';}
export async function tuningKey(identity:unknown):Promise<string>{
  return 'quixi-gpu-tune-v1:'+await sha256(new TextEncoder().encode(JSON.stringify(identity)));
}
export function validTuningRecord(value:unknown,key:string):value is TuningRecord{
  if(!value||typeof value!=='object')return false;
  const record=value as TuningRecord;
  if(record.schema!==1||record.key!==key||record.status!=='complete'||!record.selections||!record.samples)return false;
  if(!Number.isFinite(record.elapsedMs)||record.elapsedMs<0||!Number.isInteger(record.probes)||record.probes<0||record.probes>24)return false;
  for(const bucket of BUCKETS){
    if(!['baseline','tiled'].includes(record.selections[bucket]))return false;
    const sample=record.samples[bucket];if(!sample)return false;
    for(const route of ['baseline','tiled'] as const)
      if(!Array.isArray(sample[route])||sample[route].length!==3||sample[route].some(ms=>!Number.isFinite(ms)||ms<=0))return false;
  }
  return true;
}
async function boundedCache<T>(operation:()=>Promise<T>,fallback:T):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([Promise.resolve().then(operation).catch(()=>fallback),new Promise<T>(resolve=>{timer=setTimeout(()=>resolve(fallback),50);})]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
}
/** At most 24 actual graph executions, one warmup + three pairs per bucket.
 * Stop admitting probes after 750 ms; an already submitted graph cannot be preempted.
 * Tuning samples are startup choices, not the 30-sample release benchmark evidence.
 */
export async function tuneProjections(options:{key:string;cache?:TuningCache;
  measure:(variant:ProjectionVariant,tokens:32|128|512)=>Promise<number>;now?:()=>number;
}):Promise<{record:TuningRecord;cacheHit:boolean}>{
  if(options.cache){
    const cached=await boundedCache(()=>options.cache!.get(options.key),null);
    if(validTuningRecord(cached,options.key))return{record:structuredClone(cached),cacheHit:true};
  }
  const now=options.now??(()=>performance.now()),start=now();
  const record:TuningRecord={schema:1,key:options.key,createdAt:new Date().toISOString(),status:'complete',
    selections:{small:'baseline',medium:'baseline',large:'baseline'},samples:{},probes:0,elapsedMs:0};
  for(const [bucket,tokens] of [['small',32],['medium',128],['large',512]] as const){
    const samples:Record<ProjectionVariant,number[]>={baseline:[],tiled:[]};
    for(let pair=-1;pair<3;pair++)for(const variant of pair%2===0?['baseline','tiled'] as const:['tiled','baseline'] as const){
      if(now()-start>=750){record.status='budget-exhausted';record.elapsedMs=now()-start;return{record,cacheHit:false};}
      const elapsed=await options.measure(variant,tokens);record.probes++;
      if(!Number.isFinite(elapsed)||elapsed<=0)throw new Error('Invalid tuning measurement');
      if(pair>=0)samples[variant].push(elapsed);
    }
    record.samples[bucket]=samples;
    const median=(values:number[])=>values.slice().sort((a,b)=>a-b)[1]!;
    // Require a material margin over the baseline to avoid selecting measurement noise.
    if(median(samples.tiled)*1.10<median(samples.baseline))record.selections[bucket]='tiled';
  }
  record.elapsedMs=now()-start;
  if(options.cache)await boundedCache(()=>options.cache!.set(options.key,structuredClone(record)),undefined);
  return{record,cacheHit:false};
}
