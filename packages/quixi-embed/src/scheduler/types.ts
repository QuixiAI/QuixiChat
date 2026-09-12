import type {EmbeddingRole,TokenInspection} from '../scalar.ts';

export type EmbeddingPriority=0|1|2|3|4;
export const PRIORITY={interactive:0,currentDocument:1,newContent:2,recentImport:3,archive:4} as const;
/** Semantic identity is frozen for one scheduler; use a new instance after changes. */
export interface EmbeddingIdentity {
  modelHash:string;artifactHash:string;tokenizerVersion:string;preprocessingVersion:string;
  chunkingVersion:string;queryPrefix:string;
}
export interface SchedulerExecutor {
  readonly route:string;readonly kind:'cpu'|'gpu';
  readonly maxBatch:number;readonly maxTokens:number;readonly maxPaddedTokens:number;
  inspect(text:string,role:EmbeddingRole):TokenInspection;
  execute(texts:readonly string[],role:EmbeddingRole):Promise<Float32Array[]>|Float32Array[];
  recoverable?(error:unknown):boolean;
  dispose():void;
}
export interface CachedEmbedding {
  identityKey:string;role:EmbeddingRole;route:string;vector:Float32Array;
}
/** Injected private storage owner. The runtime opens no database or durable queue. */
export interface EmbeddingCacheStore {
  get(key:string):Promise<CachedEmbedding|null>;
  put(key:string,value:CachedEmbedding):Promise<void>;
}
export interface SchedulerLimits {
  maxJobs:number;maxConsumers:number;maxConsumersPerJob:number;
  maxInputBytes:number;maxAdmittedBytes:number;
  maxCacheEntries:number;maxCacheBytes:number;
  maxStoreOperations:number;maxStoreBytes:number;storeTimeoutMs:number;
  backgroundBatch:number;maxPaddedTokens:number;backgroundAgingDispatches:number;
}
export interface EmbeddingRequest {
  text:string;role:EmbeddingRole;priority?:EmbeddingPriority;signal?:AbortSignal;
  /** Optional assertion prevents accidental use of a scheduler for another model. */
  identity?:EmbeddingIdentity;
}
export interface EmbeddingResult {
  identity:Readonly<EmbeddingIdentity>;role:EmbeddingRole;route:string;vector:Float32Array;
  cacheHit:boolean;shared:boolean;
}
export interface EmbeddingTicket {id:number;result:Promise<EmbeddingResult>;cancel():void}
export type SchedulerFailureCode='invalid'|'oversized'|'saturated'|'cancelled'|'background-draining'|'backend'|'closed';
export interface SchedulerStatistics {
  state:'ready'|'running'|'switching'|'unavailable'|'closed';route:string;kind:'cpu'|'gpu';
  background:'running'|'paused'|'draining';
  jobs:number;consumers:number;admittedBytes:number;activeRequests:number;
  cacheEntries:number;cacheBytes:number;storeOperations:number;storeBytes:number;
  /** Consumer counts: submitted means admitted; completed includes cache hits.
   * Immediate validation/saturation rejection is returned on its ticket only.
   */
  submitted:number;completed:number;cancelled:number;failed:number;cacheHits:number;
  singleflightJoins:number;dispatches:number;inferred:number;fallbacks:number;
  /** Distinct document inference jobs; cache hits/joiners do not inflate throughput. */
  recentChunksPerSecond:number|null;estimatedRemainingSeconds:number|null;
  etaScope:'admitted-documents'|'owner-document-estimate';inferenceCompletionsAreDurable:false;
}
export interface SchedulerEvent {
  type:'queued'|'completed'|'cancelled'|'failed'|'dispatch'|'backend'|'paused'|'resumed'|'closed';
  statistics:SchedulerStatistics;
}
export interface EmbeddingScheduler {
  readonly identity:Readonly<EmbeddingIdentity>;
  submit(request:EmbeddingRequest):EmbeddingTicket;
  pauseBackground():void;resumeBackground():void;
  /** Reject new background admission, finish admitted background, then stay paused. */
  drainBackground():Promise<void>;
  /** Wait for all currently admitted consumers; later submissions do not extend it. */
  drain():Promise<void>;
  statistics(remainingDocuments?:number):SchedulerStatistics;
  clearCache():void;
  shutdown(mode?:'cancel'|'drain'):Promise<void>;
}
export interface SchedulerOptions {
  identity:EmbeddingIdentity;executor:SchedulerExecutor;fallback?:()=>Promise<SchedulerExecutor>;
  /** Stable model-owned preflight can outlive a lost GPU device during fallback. */
  preflight?:(text:string,role:EmbeddingRole)=>TokenInspection;
  cacheStore?:EmbeddingCacheStore;limits?:Partial<SchedulerLimits>;
  onEvent?:(event:SchedulerEvent)=>void;
  /** Testable clock/yield; production defaults yield through a macrotask. */
  now?:()=>number;yieldTask?:()=>Promise<void>;
}
