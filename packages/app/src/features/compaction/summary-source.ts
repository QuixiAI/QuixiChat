import { canonicalJson } from '@quixi/core/contracts';
import type { StorageClient, StorageOperations } from '@quixi/core/contracts';
import { assertSummarySource, compactAttachment, contextSummary, isInternalProvenancePart,isReasoningEvidencePart, SUMMARY_INSTRUCTION, SUMMARY_LIMITS, utf8ByteLength } from '@quixi/core/model';
import type { Attachment, ContentPart, ContextSnapshot, Generation, Message, SummarySourceDescriptor } from '@quixi/core/model';
import { LIMITS as PROVIDER_LIMITS } from '@quixi/providers';
import type { ProviderInput } from '@quixi/providers';
export type SummaryRequest=<K extends keyof StorageOperations>(operation:K,args:StorageOperations[K]['args'])=>Promise<StorageOperations[K]['result']>;
export const summaryHash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
export async function readSummaryBytes(storage:StorageClient,request:SummaryRequest,sha256:string,size:number,max:number,assertCurrent:()=>void):Promise<Uint8Array<ArrayBuffer>>{
 if(size>max||size<0)throw new Error('The summary source exceeds its verified byte budget. Choose a smaller prefix.');
 const transfer=await request('readBlobTransfer',{sha256}),bytes=new Uint8Array(size);let offset=0;
 try{for(;;){assertCurrent();const chunk=await storage.readChunk(transfer.transferId);assertCurrent();if(chunk.offset!==offset||offset+chunk.bytes.length>size)throw new Error('Summary source bytes differ from their canonical length');bytes.set(chunk.bytes,offset);offset+=chunk.bytes.length;await storage.acknowledgeChunk({transferId:chunk.transferId,sequence:chunk.sequence,committedOffset:offset});if(chunk.final)break;}}
 finally{await storage.request(crypto.randomUUID(),'discardBlobTransfer',{transferId:transfer.transferId}).catch(()=>{});}
 if(offset!==size)throw new Error('Summary source ended before its canonical byte length');
 const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');if(actual!==sha256)throw new Error('Summary source digest verification failed');return bytes;
}
export async function collectSummarySource(request:SummaryRequest,context:ContextSnapshot,throughMessageId:string):Promise<SummarySourceDescriptor>{
 const base=contextSummary(context),messages:SummarySourceDescriptor['messages']=[],attachments=new Map<string,Attachment>();let cursor:string|null=null,done=false,partCount=0;
 do{
  const window:StorageOperations['readConversationWindow']['result']=await request('readConversationWindow',{threadId:context.threadId,leafMessageId:throughMessageId,page:{maxItems:32,maxBytes:131072,cursor}});
  // Windows are chronological within a page, newest pages first.
  for(const message of [...window.items].reverse()){
   if(message.id===base?.throughMessageId){done=true;break;}
   if(messages.length>=SUMMARY_LIMITS.messages)throw new Error('Summary source exceeds 2,047 messages');
   const parts:ContentPart[]=[];let partCursor:string|null=null;
   do{const page:StorageOperations['readMessageParts']['result']=await request('readMessageParts',{messageId:message.id,page:{maxItems:16,maxBytes:131072,cursor:partCursor}});parts.push(...page.items as unknown as ContentPart[]);partCount+=page.items.length;if(partCount>SUMMARY_LIMITS.parts)throw new Error('Summary source exceeds 4,096 parts');partCursor=page.nextCursor;}while(partCursor);
   for(const part of parts)if(part.kind==='Image'||part.kind==='File'||part.kind==='Audio')if(!attachments.has(part.data.attachmentId)){const attachment=await request('readEntity',{collection:'attachments',id:part.data.attachmentId}) as unknown as Attachment|null;if(!attachment)throw new Error('Summary attachment is missing');attachments.set(attachment.id,attachment);}
   const g=message.generationId?await request('readEntity',{collection:'generations',id:message.generationId}) as unknown as Generation:null;
   messages.unshift({message,parts,generation:g?{id:g.id,status:g.status,...(g.purpose?{purpose:g.purpose}:{})}:null});
  }
  cursor=window.nextCursor;
 }while(cursor&&!done);
 if(base&&!done)throw new Error('The existing summary boundary is not on this source branch');
 const source:SummarySourceDescriptor={version:1,threadId:context.threadId,context,throughMessageId,messages,attachments:[...attachments.values()].sort((a,b)=>a.id.localeCompare(b.id))};assertSummarySource(source);return source;
}
export async function buildSummaryInput(source:SummarySourceDescriptor,storage:StorageClient,request:SummaryRequest,modelId:string,parameters:ProviderInput['parameters'],assertCurrent:()=>void){
 const parts:ContentPart[]=[],attachments:Record<string,{mediaType:string;bytes:Uint8Array<ArrayBuffer>}>= {},excluded=new Set(source.context.compaction?.excludedPartIds??[]);let textBytes=0,imageBytes=0,omitted=0;const promptId=crypto.randomUUID();
 const text=(value:unknown)=>{const encoded=canonicalJson(value as never);textBytes+=utf8ByteLength(encoded);if(textBytes>SUMMARY_LIMITS.sourceBytes)throw new Error('Summary evidence exceeds 512 KiB; choose a smaller prefix');parts.push({id:crypto.randomUUID(),messageId:promptId,order:parts.length,kind:'Text',data:{text:encoded}});};
 const base=contextSummary(source.context);if(base)text({kind:'previous_reviewed_summary',proposalId:base.proposalId,throughMessageId:base.throughMessageId,text:base.reviewedText});
 for(const item of source.messages){
  text({messageId:item.message.id,role:item.message.role,status:item.generation?.status??null});
  for(const original of item.parts){assertCurrent();let part=compactAttachment(original,excluded);
   if(isInternalProvenancePart(part)||isReasoningEvidencePart(part)||part.kind==='ReasoningMetadata'&&part.data.redacted){omitted++;continue;}
   if(part.kind==='ProviderArtifact')throw new Error('An unknown provider artifact cannot be summarized safely. Choose another prefix.');
   if(part.kind==='Text'||part.kind==='Note'){if(part.data.textBlob){const blob=part.data.textBlob;const bytes=await readSummaryBytes(storage,request,blob.sha256,blob.byteLength,SUMMARY_LIMITS.sourceBytes-textBytes,assertCurrent);part={...part,data:{text:new TextDecoder('utf-8',{fatal:true}).decode(bytes)}};}text({partId:part.id,kind:part.kind,text:part.data.text});}
   else if(part.kind==='Image'){
    const attachmentId=part.data.attachmentId;
    const attachment=source.attachments.find(value=>value.id===attachmentId)!;
    if(attachment.availability!=='available'||!attachment.blobSha256||attachment.sizeBytes===null||!attachment.mimeType)throw new Error('An image has no verified bytes. Exclude that attachment explicitly before summarizing it.');
    if(!attachments[attachment.id]){const bytes=await readSummaryBytes(storage,request,attachment.blobSha256,attachment.sizeBytes,PROVIDER_LIMITS.imageBytes-imageBytes,assertCurrent);imageBytes+=bytes.length;attachments[attachment.id]={mediaType:attachment.mimeType,bytes};}
    text({partId:part.id,kind:'Image',messageId:item.message.id});parts.push({...part,messageId:promptId,order:parts.length});
   }else if(part.kind==='File'||part.kind==='Audio')throw new Error('File and audio content cannot yet be mapped into this summary request. Exclude the occurrence explicitly or choose another prefix.');
   else text(part);
  }
 }
 const input:ProviderInput={requestId:crypto.randomUUID(),modelId,systemPrompt:SUMMARY_INSTRUCTION,messages:[{role:'user',parts}],parameters:{...parameters,maxOutputTokens:Math.min(1024,parameters.maxOutputTokens)},...(Object.keys(attachments).length?{attachments}:{})};
 return {input,textBytes,imageBytes,omitted};
}
