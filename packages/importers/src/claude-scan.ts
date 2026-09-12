import {jsonEvents} from './json/tokens.ts';
import {ScalarCollector,jsonPointer} from './json/metadata.ts';
import type {ImportByteSource} from './types.ts';
import type {ChatgptScanAction} from './chatgpt-scan.ts';
import type {JsonObject,JsonValue} from '@quixi/core/model';
const end=(kind:string)=>['objectEnd','arrayEnd','stringEnd','number','boolean','null'].includes(kind);
/** Observed Claude consumer-export shape. UUID aliases resolve arbitrary parent order using SQL work rows. */
export async function* scanClaude(source:ImportByteSource,sourceSha256:string,cancelled:()=>boolean=()=>false):AsyncGenerator<ChatgptScanAction>{
 let root=false,conversation:number|null=null,groupKey='',threadStart=0,messagesSeen=false,fields:JsonObject={},threadTruncated:string[]=[];
 let index:number|null=null,start=0,metadata:JsonObject={},truncated:string[]=[],parts=0,attachments=0,previous:string|null=null;
 const threadFields=new Set(['uuid','name','created_at','updated_at']);
 const messageFields=new Set(['uuid','sender','created_at','updated_at','parent_message_uuid']);
 const collector=new ScalarCollector(path=>conversation!==null&&path[0]===conversation&&((path.length===2&&threadFields.has(String(path[1])))||(index!==null&&path[1]==='chat_messages'&&path[2]===index&&path.length===4&&messageFields.has(String(path[3])))),(path,value,cut)=>{if(path.length===2){fields[String(path[1])]=value;if(cut)threadTruncated.push(String(path[1]));}else{metadata[String(path[3])]=value;if(cut)truncated.push(String(path[3]));}});
 for await(const event of jsonEvents(source.open(),{cancelled})){
  const path=event.path;
  if(!root){if(event.kind!=='arrayStart'||path.length)throw new Error('Supported Claude profile requires a conversation array');root=true;continue;}
  if(event.kind==='objectStart'&&path.length===1&&typeof path[0]==='number'){conversation=path[0];groupKey=JSON.stringify([sourceSha256,conversation]);threadStart=event.offset;fields={};threadTruncated=[];messagesSeen=false;previous=null;}
  if(conversation===null){if(path.length)throw new Error('Claude conversation entries must be objects');continue;}
  if(path.length===2&&path[1]==='chat_messages'&&event.kind==='arrayStart')messagesSeen=true;
  if(path.length===3&&path[1]==='chat_messages'&&event.kind==='objectStart'){index=Number(path[2]);start=event.offset;metadata={};truncated=[];parts=0;attachments=0;}
  if(path.length===3&&path[1]==='chat_messages'&&(event.kind==='arrayStart'||(end(event.kind)&&event.kind!=='objectEnd')))throw new Error('Claude message entries must be objects');
  collector.accept(event);
  if(index!==null&&end(event.kind)&&path.length===5&&path[1]==='chat_messages'&&path[2]===index&&typeof path[4]==='number'&&(path[3]==='content'||path[3]==='attachments'||path[3]==='files')){
   const kind=path[3]==='content'?'part':'attachment';const order=kind==='part'?parts++:attachments++;
   yield{kind:'work',groupKey,record:{key:JSON.stringify([kind,index,order]),parentKey:JSON.stringify(['index',index]),byteStart:event.offset,byteEnd:event.end,payload:{kind,index:order,locator:jsonPointer(path),providerShape:'claude'}}};
  }
  // Legacy text is retained as a range; used only when structured content is absent.
  if(index!==null&&event.kind==='stringEnd'&&path.length===4&&path[1]==='chat_messages'&&path[2]===index&&path[3]==='text'){metadata.textStart=event.offset;metadata.textEnd=event.end;}
  if(event.kind==='objectEnd'&&path.length===3&&path[1]==='chat_messages'&&path[2]===index){
   const nativeId=metadata.uuid;if(typeof nativeId!=='string'||!nativeId||truncated.includes('uuid')||truncated.includes('parent_message_uuid'))throw new Error('Claude message requires a bounded native UUID');
   const explicit=Object.hasOwn(metadata,'parent_message_uuid'),parent=explicit?metadata.parent_message_uuid:previous;
   if(!(parent===null||typeof parent==='string'))throw new Error('Claude parent UUID must be a string or null');
   const sender=metadata.sender,role=sender==='human'?'user':sender==='assistant'?'assistant':typeof sender==='string'?sender:null;
   if(parts===0&&typeof metadata.textStart==='number'&&typeof metadata.textEnd==='number'){
    yield{kind:'work',groupKey,record:{key:JSON.stringify(['part',index,0]),parentKey:JSON.stringify(['index',index]),byteStart:metadata.textStart,byteEnd:metadata.textEnd,payload:{kind:'part',index:0,locator:jsonPointer([conversation,'chat_messages',index!,'text']),providerShape:'claude-legacy-text'}}};parts=1;
   }
   const parseDate=(value:JsonValue|undefined)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value)/1000:null;
   const nodeFields:JsonObject={'message/id':nativeId,'message/author/role':role,'message/create_time':parseDate(metadata.created_at),'message/source_created_at':metadata.created_at??null,'message/content/content_type':'claude-content'};
   yield{kind:'work',groupKey,record:{key:JSON.stringify(['index',index]),parentKey:parent===null?null:JSON.stringify(['native',parent]),byteStart:start,byteEnd:event.end,payload:{kind:'node',nodeKey:nativeId,messageObject:true,fields:nodeFields,partCount:parts,attachmentCount:attachments,messageStart:start,messageEnd:event.end,truncated:truncated as JsonValue,locator:jsonPointer([conversation,'chat_messages',index!]),messageLocator:jsonPointer([conversation,'chat_messages',index!]),parentInferred:!explicit}}};
   yield{kind:'work',groupKey,record:{key:JSON.stringify(['native',nativeId]),parentKey:JSON.stringify(['index',index]),byteStart:start,byteEnd:event.end,payload:{kind:'node',messageObject:false,alias:true}}};previous=nativeId;index=null;
  }
  if(event.kind==='objectEnd'&&path.length===1&&path[0]===conversation){
   if(!messagesSeen||threadTruncated.includes('uuid'))throw new Error('Claude conversation requires chat_messages and bounded UUID');
   const date=typeof fields.created_at==='string'?Date.parse(fields.created_at):NaN;
   yield{kind:'seal',groupKey,metadata:{sourceSha256,sourceName:source.name,sourceBytes:source.byteLength,sourceIndex:conversation,byteStart:threadStart,byteEnd:event.end,fields:{conversation_id:fields.uuid??null,title:fields.name??'',create_time:Number.isFinite(date)?date/1000:null,current_node:null,source_created_at:fields.created_at??null},truncated:threadTruncated as JsonValue,locator:jsonPointer(path)}};conversation=null;
  }
 }
}
