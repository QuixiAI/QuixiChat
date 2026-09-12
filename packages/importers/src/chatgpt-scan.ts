import {jsonEvents} from './json/tokens.ts';
import {ScalarCollector,jsonPointer} from './json/metadata.ts';
import type {JsonEvent} from './json/tokens.ts';
import type {ImportByteSource} from './types.ts';
import type {ImportWorkRecord} from '@quixi/core/contracts';
import type {JsonObject,JsonValue} from '@quixi/core/model';

export type ChatgptScanAction=
 | {kind:'work';groupKey:string;record:ImportWorkRecord}
 | {kind:'seal';groupKey:string;metadata:JsonObject};
const nodeKey=(key:string)=>JSON.stringify(['node',key]);
export {nodeKey as chatgptNodeWorkKey};
const terminal=(event:JsonEvent)=>['objectEnd','arrayEnd','stringEnd','number','boolean','null'].includes(event.kind);
/** Scans one conversations JSON array into offset/metadata work rows. No mapping, message body or part manifest accumulates in JS. */
export async function* scanChatgpt(source:ImportByteSource,sourceSha256:string,cancelled:()=>boolean=()=>false):AsyncGenerator<ChatgptScanAction>{
  let conversation:number|null=null,groupKey='',threadStart=0,mappingSeen=false;
  let fields:JsonObject={},truncated:string[]=[];let node:string|null=null,nodeStart=0,nodeFields:JsonObject={},nodeTruncated:string[]=[],messageObject=false;
  let partCount=0,attachmentCount=0;let messageStart:number|null=null,messageEnd:number|null=null;
  const threadNames=new Set(['id','conversation_id','title','create_time','update_time','current_node','is_archived','is_starred']);
  const nodeNames=new Set(['id','parent','message','message/id','message/author/role','message/author/name','message/create_time','message/content/content_type','message/metadata/model_slug'].map(name=>JSON.stringify(name.split('/'))));
  const collector=new ScalarCollector(path=>{
    if(conversation===null||path[0]!==conversation)return false;
    if(path.length===2)return threadNames.has(String(path[1]));
    if(node!==null&&path[1]==='mapping'&&path[2]===node)return nodeNames.has(JSON.stringify(path.slice(3)));
    return false;
  },(path,value,wasTruncated)=>{
    if(path.length===2){fields[String(path[1])]=value;if(wasTruncated&&truncated.length<32)truncated.push(String(path[1]));}
    else{const field=path.slice(3).join('/');nodeFields[field]=value;if(wasTruncated&&nodeTruncated.length<32)nodeTruncated.push(field);}
  });
  let root=false;
  for await(const event of jsonEvents(source.open(),{cancelled})){
    if(!root){if(event.kind!=='arrayStart'||event.path.length)throw new Error('Supported ChatGPT profile requires a conversation array');root=true;continue;}
    const path=event.path;
    if(event.kind==='objectStart'&&path.length===1&&typeof path[0]==='number'){
      conversation=path[0];groupKey=JSON.stringify([sourceSha256,conversation]);threadStart=event.offset;fields={};truncated=[];mappingSeen=false;
    }
    if(conversation===null){if(path.length>0)throw new Error('Conversation array entries must be objects');continue;}
    if(event.kind==='objectStart'&&path.length===2&&path[0]===conversation&&path[1]==='mapping')mappingSeen=true;
    if(event.kind==='objectStart'&&path.length===3&&path[0]===conversation&&path[1]==='mapping'&&typeof path[2]==='string'){
      node=path[2];nodeStart=event.offset;nodeFields={};nodeTruncated=[];partCount=0;attachmentCount=0;messageObject=false;messageStart=null;messageEnd=null;
    }
    if(node!==null&&path[1]==='mapping'&&path[2]===node){
      if(event.kind==='arrayStart'&&path.length===4&&path[3]==='message')throw new Error('Mapping message must be an object or null');
      if(event.kind==='objectStart'&&path.length===4&&path[3]==='message'){messageObject=true;messageStart=event.offset;}
      if(event.kind==='objectEnd'&&path.length===4&&path[3]==='message')messageEnd=event.end;
    }
    if(path.length===3&&path[1]==='mapping'&&(event.kind==='arrayStart'||(terminal(event)&&event.kind!=='objectEnd')))throw new Error('Mapping node must be an object');
    collector.accept(event);
    if(node!==null&&terminal(event)&&path[0]===conversation&&path[1]==='mapping'&&path[2]===node){
      const part=path.length===7&&path[3]==='message'&&path[4]==='content'&&path[5]==='parts'&&typeof path[6]==='number';
      const attachment=path.length===7&&path[3]==='message'&&path[4]==='metadata'&&path[5]==='attachments'&&typeof path[6]==='number';
      if(part||attachment){
        const index=path[6] as number;if(part)partCount=Math.max(partCount,index+1);else attachmentCount=Math.max(attachmentCount,index+1);
        yield{kind:'work',groupKey,record:{key:JSON.stringify([part?'part':'attachment',node,index]),parentKey:nodeKey(node),byteStart:event.offset,byteEnd:event.end,payload:{kind:part?'part':'attachment',nodeKey:node,index,locator:jsonPointer(path)}}};
      }
    }
    if(event.kind==='objectEnd'&&path.length===3&&path[0]===conversation&&path[1]==='mapping'&&path[2]===node){
      if(node===null)throw new Error('Invalid mapping node state');
      if(!messageObject&&Object.hasOwn(nodeFields,'message')&&nodeFields.message!==null)throw new Error('Mapping message must be an object or null');
      const parent=nodeFields.parent;
      if(!Object.hasOwn(nodeFields,'parent')||!(parent===null||typeof parent==='string')||nodeTruncated.includes('parent')||nodeTruncated.includes('message/id'))throw new Error('Mapping node requires a bounded explicit parent and native identity');
      yield{kind:'work',groupKey,record:{key:nodeKey(node),parentKey:parent===null?null:nodeKey(parent as string),byteStart:nodeStart,byteEnd:event.end,payload:{kind:'node',nodeKey:node,messageObject,fields:nodeFields,partCount,attachmentCount,messageStart,messageEnd,truncated:nodeTruncated as JsonValue,locator:jsonPointer(path)}}};node=null;
    }
    if(event.kind==='objectEnd'&&path.length===1&&path[0]===conversation){
      if(!mappingSeen)throw new Error('Conversation lacks the supported mapping object');
      if(truncated.includes('id')||truncated.includes('conversation_id')||truncated.includes('current_node'))throw new Error('Conversation identity/branch metadata exceeds supported bounds');
      yield{kind:'seal',groupKey,metadata:{sourceSha256,sourceName:source.name,sourceBytes:source.byteLength,sourceIndex:conversation,byteStart:threadStart,byteEnd:event.end,fields,truncated:truncated as JsonValue,locator:jsonPointer(path)}};conversation=null;
    }
  }
}
