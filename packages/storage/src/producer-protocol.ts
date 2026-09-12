import { isQuixiId } from '@quixi/core/model';
import { validArchiveId } from './archive-protocol.ts';
export function producerLockName(archiveId:string,generationId:string):string {
  if(!validArchiveId(archiveId)||!isQuixiId(generationId))throw new Error('Invalid producer lock identity');
  return `quixi:archive:${archiveId}:generation:${generationId}:producer`;
}
