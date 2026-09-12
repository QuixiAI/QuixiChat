import type {CpuEncoder,EmbeddingRole,TokenInspection} from '../scalar.ts';
import {GpuBackendError,type WebGpuEncoder} from '../gpu/encoder.ts';
import {createEmbeddingScheduler} from './scheduler.ts';
import type {EmbeddingScheduler,SchedulerExecutor,SchedulerOptions} from './types.ts';

export function cpuSchedulerExecutor(encoder:CpuEncoder):SchedulerExecutor{
  encoder.inspect('','document'); // Fail at integration time for a legacy artifact.
  return Object.freeze({route:encoder.backend,kind:'cpu' as const,maxBatch:1,maxTokens:512,maxPaddedTokens:512,
    inspect:(text:string,role:EmbeddingRole)=>encoder.inspect(text,role),
    execute(texts:readonly string[],role:EmbeddingRole){
      if(texts.length!==1)throw new RangeError('CPU scheduling dispatches one document before yielding');
      return[role==='query'?encoder.embedQuery(texts[0]!):encoder.embedDocument(texts[0]!)];
    },dispose:()=>encoder.dispose()});
}
/** Preflight belongs to the model/worker owner and remains live during GPU loss.
 * This adapter owns the GPU encoder, not the separately injected C tokenizer.
 */
export function gpuSchedulerExecutor(options:{encoder:WebGpuEncoder;
  preflight:(text:string,role:EmbeddingRole)=>TokenInspection;backgroundBatch?:number;maxPaddedTokens?:number;
}):SchedulerExecutor{
  const {encoder,preflight}=options,capacity=encoder.diagnostics().capacity;
  preflight('','document');
  const maxBatch=Math.min(options.backgroundBatch??4,capacity.batch),maxPaddedTokens=options.maxPaddedTokens??2048;
  return Object.freeze({route:encoder.backend,kind:'gpu' as const,maxBatch,maxTokens:Math.min(capacity.tokens,maxPaddedTokens),maxPaddedTokens,
    inspect:preflight,
    execute(texts:readonly string[],role:EmbeddingRole){
      if(role==='query'){
        if(texts.length!==1)throw new RangeError('Interactive query batches contain one request');
        return encoder.embedQuery(texts[0]!).then(vector=>[vector]);
      }
      return encoder.embedDocuments(texts);
    },
    recoverable:(error:unknown)=>error instanceof GpuBackendError&&['lost','execution','unavailable','initialization','limits'].includes(error.code),
    dispose:()=>encoder.dispose()});
}
/** Initial unavailability and later device loss both have explicit CPU factories.
 * The caller receives the initialization error for availability UI/diagnostics.
 */
export async function createSchedulerWithFallback(options:Omit<SchedulerOptions,'executor'|'fallback'> & {
  createGpu?:()=>Promise<SchedulerExecutor>;createCpu:()=>Promise<SchedulerExecutor>;
}):Promise<{scheduler:EmbeddingScheduler;initialGpuError:unknown|null}>{
  let executor:SchedulerExecutor,initialGpuError:unknown|null=null,gpu=false;
  if(options.createGpu){try{executor=await options.createGpu();gpu=true;}catch(error){initialGpuError=error;executor=await options.createCpu();}}
  else executor=await options.createCpu();
  try{return{scheduler:createEmbeddingScheduler({...options,executor,...(gpu?{fallback:options.createCpu}:{})}),initialGpuError};}
  catch(error){executor.dispose();throw error;}
}
