import { producerLockName } from '../producer-protocol.ts';
import { ArchiveStorageError, archiveError } from '../archive-protocol.ts';
export interface GenerationLease { generationId:string; archiveId:string; release():Promise<void> }
/** Held by the context running HTTP, independently of any storage worker/client.
 * Acquire BEFORE registering or creating the attempt. Context termination drops
 * this lock, giving the storage owner positive evidence of producer loss.
 */
export async function acquireGenerationLease(archiveId:string,generationId:string):Promise<GenerationLease> {
  const name=producerLockName(archiveId,generationId);
  if(!navigator.locks)throw new ArchiveStorageError(archiveError(new Error('Generation coordination requires Web Locks'),generationId,null,'UNSUPPORTED'));
  let release!:()=>void, granted!:()=>void, denied!:(error:unknown)=>void;
  const acquired=new Promise<void>((resolve,reject)=>{granted=resolve;denied=reject;});
  const held=new Promise<void>(resolve=>{release=resolve;});
  const lifetime=navigator.locks.request(name,{mode:'exclusive',ifAvailable:true},async lock=>{
    if(!lock){denied(new ArchiveStorageError(archiveError(new Error('Another context owns this generation producer'),generationId,null,'CONFLICT')));return;}
    granted();await held;
  });
  void lifetime.catch(denied);
  await acquired;
  let released=false;
  return {archiveId,generationId,async release(){if(!released){released=true;release();}await lifetime;}};
}
