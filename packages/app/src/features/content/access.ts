import type { CapabilityState, HostClient, StorageClient } from '@quixi/core/contracts';
import type { Attachment, RawObject, TextBlob } from '@quixi/core/model';
import { imageMetadata } from './image-metadata.ts';
export interface ImagePreview {url:string;width:number;height:number;close():Promise<void>}
export const CONTENT_LIMITS=Object.freeze({views:2,textPageBytes:16_384,attachmentBytes:8*1024*1024,imagePixels:16_000_000});
const id=()=>crypto.randomUUID();
export interface TextSection {text:string;offset:number;nextOffset:number|null;totalBytes:number}
export interface TextReader {read(offset:number):Promise<TextSection>;close():Promise<void>}
export interface PreparedContentFile {transferId:string;filename:string;mediaType:string;byteLength:number;save():Promise<void>;close():Promise<void>}
export function downloadName(value:string|null):string {return (value??'attachment.bin').replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,200)||'attachment.bin';}
/** One instance belongs to the app session. All attachment actions share its finite admission budget. */
export function createContentAccess({storage,host}:{storage:StorageClient;host:HostClient}) {
  const leases=new Set<{close():Promise<void>}>(),pending=new Set<Promise<unknown>>();let disposed=false,reserved=0,disposing:Promise<void>|null=null;
  // Copy controls appear only once the host reports the clipboard available.
  const clipboardListeners=new Set<()=>void>();let clipboardState:CapabilityState|null=null;
  const clipboardStore={subscribe(listener:()=>void){clipboardListeners.add(listener);return()=>{clipboardListeners.delete(listener);};},getSnapshot:()=>clipboardState};
  void host.capabilities().then(capabilities=>{clipboardState=capabilities.clipboard;}).catch(()=>{clipboardState={available:false,permission:'denied',reason:'Host capabilities could not be read.'};}).finally(()=>{for(const listener of clipboardListeners)listener();});
  function tracked<T>(action:()=>Promise<T>):Promise<T>{const operation=action();pending.add(operation);void operation.finally(()=>pending.delete(operation)).catch(()=>{});return operation;}
  function reserve(){if(disposed)throw new Error('Content access is closed.');if(leases.size+reserved>=CONTENT_LIMITS.views)throw new Error('Close another content preview before opening this one.');reserved++;let done=false;return {release(){if(!done){done=true;reserved--; }},publish(lease:{close():Promise<void>}){this.release();if(disposed){void lease.close();throw new Error('Content access is closed.');}leases.add(lease);}};}
  async function reader(sha256:string,expectedBytes:number):Promise<TextReader>{
    const reservation=reserve();let transferId:string|null=null,closed=false,busy=false;
    try{
      const anchor=await storage.request(id(),'readBlobTransfer',{sha256});transferId=anchor.transferId;if(anchor.byteLength!==expectedBytes)throw new Error('Stored content size differs from its canonical reference.');
      const lease:TextReader={read(offset){return tracked(async()=>{if(closed||disposed)throw new Error('Content reader is closed.');if(busy)throw new Error('Wait for the current content section.');if(!Number.isSafeInteger(offset)||offset<0||offset>expectedBytes)throw new Error('Invalid content offset.');busy=true;let child:string|null=null;
        try{const range=await storage.request(id(),'sliceBlobTransfer',{transferId:anchor.transferId,offset,byteLength:Math.min(CONTENT_LIMITS.textPageBytes,expectedBytes-offset)});child=range.transferId;const bytes=new Uint8Array(Math.min(CONTENT_LIMITS.textPageBytes,expectedBytes-offset));let written=0,sequence=0;
          for(;;){const chunk=await storage.readChunk(child);if(chunk.sequence!==sequence++||chunk.offset!==written||written+chunk.bytes.length>bytes.length)throw new Error('Content section exceeded its range.');bytes.set(chunk.bytes,written);written+=chunk.bytes.length;await storage.acknowledgeChunk({transferId:child,sequence:chunk.sequence,committedOffset:chunk.offset+chunk.bytes.length});if(chunk.final)break;if(closed||disposed)throw new Error('Content reader is closed.');}
          if(written!==bytes.length)throw new Error('Content section ended early.');const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes,{stream:offset+written<expectedBytes});const consumed=new TextEncoder().encode(text).length;
          if(written&&consumed===0)throw new Error('Content section could not decode a complete character.');return {text,offset,nextOffset:offset+consumed<expectedBytes?offset+consumed:null,totalBytes:expectedBytes};
        }finally{if(child)await storage.request(id(),'discardBlobTransfer',{transferId:child});busy=false;}
      });},async close(){if(closed)return;closed=true;leases.delete(lease);await storage.request(id(),'discardBlobTransfer',{transferId:anchor.transferId});}};
      reservation.publish(lease);return lease;
    }catch(error){reservation.release();if(transferId)await storage.request(id(),'discardBlobTransfer',{transferId}).catch(()=>{});throw error;}
  }
  async function prepareFile(input:{sha256:string;byteLength:number;filename:string|null;mediaType:string}):Promise<PreparedContentFile>{
    if(!Number.isSafeInteger(input.byteLength)||input.byteLength<0||input.byteLength>CONTENT_LIMITS.attachmentBytes)throw new Error('This host download currently supports files up to 8 MiB. The original remains in your archive.');
    const reservation=reserve();let stage:string|null=null,source:string|null=null,closed=false;
    try{const transfer=await host.beginTransfer(id(),{purpose:'file_save',expectedBytes:input.byteLength,expectedSha256:input.sha256});stage=transfer.transferId;
      if(!Number.isSafeInteger(transfer.maxChunkBytes)||transfer.maxChunkBytes<1||transfer.maxChunkBytes>1_048_576)throw new Error('Host declared an invalid transfer bound.');
      const anchor=await storage.request(id(),'readBlobTransfer',{sha256:input.sha256});source=anchor.transferId;if(anchor.byteLength!==input.byteLength)throw new Error('Stored content size differs from its canonical reference.');let offset=0,sequence=0,sourceSequence=0;
      for(;;){if(disposed)throw new Error('Content access is closed.');const chunk=await storage.readChunk(source);if(chunk.offset!==offset||chunk.sequence!==sourceSequence++||offset+chunk.bytes.length>input.byteLength)throw new Error('Stored content transfer is inconsistent.');for(let cursor=0;cursor<chunk.bytes.length;){const bytes=chunk.bytes.slice(cursor,cursor+transfer.maxChunkBytes),length=bytes.length;await host.writeChunk({transferId:stage,sequence:sequence++,offset,bytes,final:false});offset+=length;cursor+=length;}await storage.acknowledgeChunk({transferId:source,sequence:chunk.sequence,committedOffset:chunk.offset+chunk.bytes.length});if(chunk.final)break;}
      if(offset!==input.byteLength)throw new Error('Stored content ended early.');await host.writeChunk({transferId:stage,sequence,offset,bytes:new Uint8Array(),final:true});await host.finishTransfer(id(),stage,{byteLength:offset,sha256:input.sha256});
      await storage.request(id(),'discardBlobTransfer',{transferId:source});source=null;
      const lease:PreparedContentFile={transferId:stage,filename:downloadName(input.filename),mediaType:input.mediaType,byteLength:offset,async save(){if(closed||disposed)throw new Error('Prepared download is closed.');await host.saveFileTransfer(id(),{name:lease.filename,mediaType:lease.mediaType,transferId:lease.transferId});},async close(){if(closed)return;closed=true;leases.delete(lease);await host.releaseTransfer(id(),lease.transferId);}};
      reservation.publish(lease);return lease;
    }catch(error){reservation.release();if(source)await storage.request(id(),'discardBlobTransfer',{transferId:source}).catch(()=>{});if(stage)await host.releaseTransfer(id(),stage).catch(()=>{});throw error;}
  }
  async function openImage(attachment:Attachment):Promise<ImagePreview>{
    if(attachment.availability!=='available'||!attachment.blobSha256||attachment.sizeBytes===null)throw new Error('The original image bytes are unavailable.');
    if(attachment.sizeBytes>CONTENT_LIMITS.attachmentBytes)throw new Error('Image previews currently support files up to 8 MiB.');
    if(!['image/png','image/jpeg'].includes(attachment.mimeType??''))throw new Error('This image format can be saved, but is not enabled for inline preview.');
    const reservation=reserve();let source:string|null=null,url:string|null=null,closed=false;
    try{const anchor=await storage.request(id(),'readBlobTransfer',{sha256:attachment.blobSha256});source=anchor.transferId;if(anchor.byteLength!==attachment.sizeBytes)throw new Error('Image size differs from its canonical reference.');const bytes=new Uint8Array(anchor.byteLength);let offset=0,sequence=0;
      for(;;){if(disposed)throw new Error('Content access is closed.');const chunk=await storage.readChunk(source);if(chunk.offset!==offset||chunk.sequence!==sequence++||offset+chunk.bytes.length>bytes.length)throw new Error('Image transfer is inconsistent.');bytes.set(chunk.bytes,offset);offset+=chunk.bytes.length;await storage.acknowledgeChunk({transferId:source,sequence:chunk.sequence,committedOffset:offset});if(chunk.final)break;}
      if(offset!==bytes.length)throw new Error('Image transfer ended early.');const metadata=imageMetadata(bytes);if(metadata.mimeType!==attachment.mimeType)throw new Error('Image bytes do not match the declared media type.');
      await storage.request(id(),'discardBlobTransfer',{transferId:source});source=null;url=URL.createObjectURL(new Blob([bytes],{type:metadata.mimeType}));
      const lease:ImagePreview={url,width:metadata.width,height:metadata.height,async close(){if(closed)return;closed=true;leases.delete(lease);URL.revokeObjectURL(lease.url);}};reservation.publish(lease);return lease;
    }catch(error){reservation.release();if(source)await storage.request(id(),'discardBlobTransfer',{transferId:source}).catch(()=>{});if(url)URL.revokeObjectURL(url);throw error;}
  }
  return {
    async attachment(attachmentId:string):Promise<Attachment>{const value=await storage.request(id(),'readEntity',{collection:'attachments',id:attachmentId});if(!value)throw new Error('Attachment metadata is missing.');return value as unknown as Attachment;},
    async raw(rawObjectId:string):Promise<RawObject>{const value=await storage.request(id(),'readEntity',{collection:'rawObjects',id:rawObjectId});if(!value)throw new Error('Original source metadata is missing.');return value as unknown as RawObject;},
    clipboard:clipboardStore,
    copyText:(text:string)=>tracked(async()=>{if(disposed)throw new Error('Content access is closed.');await host.writeClipboardText(id(),text);}),
    openText:(blob:TextBlob)=>tracked(()=>reader(blob.sha256,blob.byteLength)),prepareFile:(input:Parameters<typeof prepareFile>[0])=>tracked(()=>prepareFile(input)),openImage:(attachment:Attachment)=>tracked(()=>openImage(attachment)),
    dispose():Promise<void>{if(disposing)return disposing;disposed=true;disposing=(async()=>{await Promise.allSettled([...pending]);await Promise.allSettled([...leases].map(lease=>lease.close()));})();return disposing;},
  };
}
export type ContentAccess=ReturnType<typeof createContentAccess>;
