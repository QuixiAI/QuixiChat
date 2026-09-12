import type {StorageClient} from '@quixi/core/contracts';
import type {QuixiId,JsonObject} from '@quixi/core/model';
/** Host adapters own File/Blob/ZIP handles. End is exclusive; each yielded chunk is at most 1 MiB. */
export interface ImportByteSource {
  name:string;byteLength:number;
  open(start?:number,end?:number):AsyncIterable<Uint8Array>;
}
export interface ImportRuntime {
  storage:StorageClient;nextId:()=>QuixiId;now:()=>number;cancelled:()=>boolean;
  withRunLock?:<T>(runId:QuixiId,work:()=>Promise<T>)=>Promise<T>;
  assets?:{resolve(name:string):Promise<{source:ImportByteSource;rawObjectId:QuixiId;locator:string}|null>};
  onProgress?:(progress:ImporterProgress)=>void;
}
export interface ImporterProgress {
  runId:QuixiId;phase:'hashing'|'preserving'|'scanning'|'normalizing'|'validating'|'publishing'|'complete'|'paused';
  processedBytes:number;totalBytes:number|null;groups:number;messages:number;parts:number;
}
export interface ImportWarning {code:string;message:string;locator:string|null;details:JsonObject}
export const IMPORTER_NAME='quixi-provider-export';
export const IMPORTER_VERSION='0.1.0';
export const CHATGPT_PROFILE='chatgpt-mapping-observed-2026-v1';

export const CLAUDE_PROFILE='claude-chat-messages-observed-2026-v1';
