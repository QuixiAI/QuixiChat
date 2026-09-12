import test from 'node:test';
import assert from 'node:assert/strict';
import type {ChatgptScanAction} from '../src/chatgpt-scan.ts';
import {scanChatgpt} from '../src/chatgpt-scan.ts';
import type {ImportByteSource} from '../src/types.ts';
function source(value:unknown,chunkSize=7):ImportByteSource{const bytes=new TextEncoder().encode(JSON.stringify(value));return{name:'conversations.json',byteLength:bytes.length,async*open(start=0,end=bytes.length){for(let offset=start;offset<end;offset+=chunkSize)yield bytes.slice(offset,Math.min(end,offset+chunkSize));}};}

test('scanner preserves exact part ranges and out-of-order graph dependencies without buffering message content',async()=>{
 const input=[{mapping:{'child/~':{message:{content:{parts:['escaped \\ quote " 😀',{unknown:['opaque',2]}],content_type:'multimodal_text'},metadata:{attachments:[{file_name:'missing.pdf'}]},author:{role:'assistant'},id:'native-message'},parent:'root'},root:{message:null,parent:null}},current_node:'child/~',title:'title after mapping',conversation_id:'native-thread'}];
 const bytes=JSON.stringify(input),actions:ChatgptScanAction[]=[];for await(const action of scanChatgpt(source(input),'a'.repeat(64)))actions.push(action);
 assert.equal(actions.length,6);const seal=actions.at(-1)!;assert.equal(seal.kind,'seal');if(seal.kind!=='seal')throw new Error();assert.equal((seal.metadata.fields as {title:string}).title,'title after mapping');
 const works=actions.filter(a=>a.kind==='work');assert.equal(works[0]!.record.parentKey,JSON.stringify(['node','child/~']));
 const utf8=new TextEncoder().encode(bytes),raw=(index:number)=>JSON.parse(new TextDecoder().decode(utf8.slice(works[index]!.record.byteStart,works[index]!.record.byteEnd)));
 assert.equal(raw(0),'escaped \\ quote " 😀');assert.deepEqual(raw(1),{unknown:['opaque',2]});assert.deepEqual(raw(2),{file_name:'missing.pdf'});
 assert.equal(works[0]!.record.payload.locator,'/0/mapping/child~1~0/message/content/parts/0');
 assert.equal(works[3]!.record.parentKey,JSON.stringify(['node','root']));assert.equal(works[3]!.record.payload.partCount,2);assert.equal(works[3]!.record.payload.attachmentCount,1);
 assert.equal(works[4]!.record.payload.messageObject,false);
});

test('scanner emits only bounded offset rows for a huge text and a many-part message',async()=>{
 const body='x'.repeat(2*1024*1024),parts=[body,...Array.from({length:1500},(_,i)=>`part ${i}`)];let count=0;
 for await(const action of scanChatgpt(source([{id:'t',mapping:{a:{parent:null,message:{id:'m',author:{role:'user'},content:{content_type:'text',parts}}}}}],65536),'b'.repeat(64))){assert.ok(JSON.stringify(action).length<2000);count++;}
 assert.equal(count,1503);
});

test('unsupported root/mapping shapes are rejected explicitly',async()=>{
 for(const value of [{},[null],[{mapping:[]}],[{mapping:{a:null}}],[{mapping:{a:{parent:null,message:[]}}}],[{mapping:{a:{message:null}}}]])await assert.rejects(async()=>{for await(const _ of scanChatgpt(source(value),'c'.repeat(64))){/* drain */}});
});
