import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson } from '@quixi/core/contracts';
import { assertSummarySource, summaryOutputText, contextSummary, SUMMARY_LIMITS, summaryJson, summarySourceCounts } from '@quixi/core/model';
import type { Attachment, ContextSnapshot, ContentPart, Generation, Message, SummarySourceDescriptor } from '@quixi/core/model';
import type { CanonicalSqlite } from './repository.ts';
export const summaryDigest=(value:unknown)=>bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value as never))));
export const summaryTextDigest=(text:string)=>bytesToHex(sha256(new TextEncoder().encode(text)));
export function readSummarySource(db:CanonicalSqlite,contextSnapshotId:string,throughMessageId:string){
 let bytes=0;
 const record=<T>(collection:string,id:string):T=>{const value=db.selectValue('SELECT payload FROM quixi_records WHERE collection=? AND id=?',[collection,id]);if(typeof value!=='string')throw new Error('Summary source reference is missing');bytes+=new TextEncoder().encode(value).byteLength;if(bytes>SUMMARY_LIMITS.sourceBytes)throw new Error('Summary source metadata exceeds 512 KiB; choose an earlier cutoff');return JSON.parse(value) as T;};
 const context=record<ContextSnapshot>('contexts',contextSnapshotId),base=contextSummary(context),messages:SummarySourceDescriptor['messages']=[],attachments=new Map<string,Attachment>();
 let cursor:string|null=throughMessageId,partCount=0;const seen=new Set<string>();
 while(cursor!== (base?.throughMessageId??null)){
  if(!cursor||seen.has(cursor)||messages.length>=SUMMARY_LIMITS.messages)throw new Error('Summary source exceeds its ancestor boundary or message limit');seen.add(cursor);
  const message:Message=record<Message>('messages',cursor);
  const size=Number(db.selectValue("SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM quixi_records WHERE collection='parts' AND message_id=?",[cursor]));
  if(bytes+size>SUMMARY_LIMITS.sourceBytes)throw new Error('Summary source parts exceed 512 KiB; choose an earlier cutoff');
  const rows=db.exec({sql:"SELECT payload FROM quixi_records WHERE collection='parts' AND message_id=? ORDER BY json_extract(payload,'$.order') LIMIT 4097",bind:[cursor],rowMode:'object',returnValue:'resultRows'}) as Array<{payload:string}>;
  const parts=rows.map(row=>JSON.parse(row.payload) as ContentPart);bytes+=size;partCount+=parts.length;if(partCount>SUMMARY_LIMITS.parts)throw new Error('Summary source exceeds 4,096 parts');
  for(const part of parts)if(part.kind==='Image'||part.kind==='File'||part.kind==='Audio')if(!attachments.has(part.data.attachmentId))attachments.set(part.data.attachmentId,record<Attachment>('attachments',part.data.attachmentId));
  const g=message.generationId?record<Generation>('generations',message.generationId):null;
  messages.unshift({message,parts,generation:g?{id:g.id,status:g.status,...(g.purpose?{purpose:g.purpose}:{})}:null});cursor=message.parentId;
 }
 const source:SummarySourceDescriptor={version:1,threadId:context.threadId,context,throughMessageId,messages,attachments:[...attachments.values()].sort((a,b)=>a.id.localeCompare(b.id))};assertSummarySource(source);return source;
}
export function summarySourceInfo(db:CanonicalSqlite,contextSnapshotId:string,throughMessageId:string){const source=readSummarySource(db,contextSnapshotId,throughMessageId);return {sourceFingerprint:summaryDigest(summaryJson(source)),...summarySourceCounts(source)};}

export function readSummaryOutputText(db:CanonicalSqlite,generation:Generation,message:Message):string {
 const size=Number(db.selectValue("SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM quixi_records WHERE collection='parts' AND message_id=?",[message.id]));
 if(size>SUMMARY_LIMITS.sourceBytes)throw new Error('Summary output metadata exceeds its bounded review limit');
 const rows=db.exec({sql:"SELECT payload FROM quixi_records WHERE collection='parts' AND message_id=? ORDER BY json_extract(payload,'$.order') LIMIT 4097",bind:[message.id],rowMode:'object',returnValue:'resultRows'}) as Array<{payload:string}>;
 return summaryOutputText(generation,message,rows.map(row=>JSON.parse(row.payload) as ContentPart));
}

/** Verify the frozen cutoff belongs to the selected branch and retains a user turn. */
export function assertSummaryCutoff(db:CanonicalSqlite,throughMessageId:string,sourceLeafMessageId:string):void {
 let cursor:string|null=sourceLeafMessageId,next:Message|null=null;
 const seen=new Set<string>();
 while(cursor!==throughMessageId){
  if(!cursor||seen.has(cursor)||seen.size>=SUMMARY_LIMITS.messages)throw new Error('Summary cutoff is outside the bounded selected branch');
  seen.add(cursor);
  const raw=db.selectValue("SELECT payload FROM quixi_records WHERE collection='messages' AND id=?",[cursor]);
  if(typeof raw!=='string')throw new Error('Summary tail message is missing');
  const message=JSON.parse(raw) as Message;
  if(!message.sealed)throw new Error('Summary source selection is still streaming');
  next=message;cursor=message.parentId;
 }
 if(next?.role!=='user')throw new Error('Summary cutoff must precede a retained user turn');
}
