import type { QuixiId } from '../model/types.ts';
import { isQuixiId } from '../model/validation.ts';
export interface GenerationProducer {
  generationId:QuixiId; producerId:QuixiId; state:'active'|'released'|'lost'|'finished';
}
export interface ProducerOperations {
  /** Register before CreateGeneration, while its independent producer lock is held. */
  registerGenerationProducer:{args:{generationId:QuixiId;producerId:QuixiId};result:GenerationProducer};
  releaseGenerationProducer:{args:{generationId:QuixiId;producerId:QuixiId};result:GenerationProducer};
  reconcileGenerationProducers:{args:{maxProducers:number};result:{checked:number;recovered:number;remaining:boolean;operationIds:QuixiId[]}};
}
export function assertProducerArgs(operation:keyof ProducerOperations,value:unknown):void {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid producer arguments');
  const args=value as Record<string,unknown>;
  if(operation==='reconcileGenerationProducers'){
    if(!Number.isSafeInteger(args.maxProducers)||Number(args.maxProducers)<1||Number(args.maxProducers)>32)throw new Error('Invalid bounded producer reconciliation');
  }else if(!isQuixiId(args.generationId)||!isQuixiId(args.producerId))throw new Error('Invalid generation producer identity');
}
