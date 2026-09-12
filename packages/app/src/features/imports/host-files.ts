import type {HostClient,HostFile,StorageClient} from '@quixi/core/contracts';
import type {ImportByteSource} from '@quixi/importers';
/** Selected handles stay host-owned. Only initial capture uses this sequential file transport. */
export function hostByteSource(host:HostClient,file:HostFile,nextId:()=>string,cancelled:()=>boolean):ImportByteSource{
 const byteLength=file.byteLength;if(byteLength===null||!Number.isSafeInteger(byteLength)||byteLength<0)throw new Error('This file source does not provide its size. Choose a local JSON or ZIP file.');
 return{name:file.name,byteLength,async*open(start=0,end=byteLength){
  if(start<0||end<start||end>byteLength||!Number.isSafeInteger(start)||!Number.isSafeInteger(end))throw new Error('Invalid selected-file range');
  const transfer=await host.openFileTransfer(nextId(),file.id);let offset=0,sequence=0;
  try{while(true){if(cancelled())throw new Error('Import paused');const chunk=await host.readChunk(transfer.transferId),size=chunk.bytes.length;
    if(chunk.offset!==offset||chunk.sequence!==sequence++||chunk.transferId!==transfer.transferId||size>1_048_576||offset+size>byteLength)throw new Error('Selected file changed or its transfer was interrupted');
    const from=Math.max(0,start-offset),to=Math.min(size,end-offset);if(to>from)yield chunk.bytes.subarray(from,to);offset+=size;
    await host.acknowledgeChunk({transferId:transfer.transferId,sequence:chunk.sequence,committedOffset:offset});
    if(chunk.final){if(offset!==byteLength)throw new Error('Selected file ended before its declared size');break;}
   }
  }finally{await host.releaseTransfer(nextId(),transfer.transferId);}
 }};
}
