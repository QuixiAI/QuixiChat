import test from 'node:test';
import assert from 'node:assert/strict';
import {jsonEvents,JSON_STREAM_LIMITS} from '../src/json/tokens.ts';
import type {JsonEvent,JsonPath} from '../src/json/tokens.ts';
const encode=(value:string)=>new TextEncoder().encode(value);
async function* chunks(bytes:Uint8Array,size:number){for(let offset=0;offset<bytes.length;offset+=size)yield bytes.subarray(offset,offset+size);}
async function parseSmall(source:AsyncIterable<Uint8Array>):Promise<unknown>{
  let root:unknown;const containers=new Map<string,Record<string,unknown>|unknown[]>();let text='';
  const set=(path:JsonPath,value:unknown)=>{if(path.length===0){root=value;return;}const parent=containers.get(JSON.stringify(path.slice(0,-1)))!;Object.defineProperty(parent,path.at(-1)!,{value,enumerable:true,writable:true,configurable:true});};
  for await(const event of jsonEvents(source))switch(event.kind){
    case 'objectStart':case 'arrayStart':{const value=event.kind==='objectStart'?{}:[];set(event.path,value);containers.set(JSON.stringify(event.path),value);break;}
    case 'objectEnd':case 'arrayEnd':containers.delete(JSON.stringify(event.path));break;
    case 'stringStart':text='';break;
    case 'stringChunk':text+=event.value;break;
    case 'stringEnd':set(event.path,text);break;
    case 'number':set(event.path,Number(event.raw));break;
    case 'boolean':set(event.path,event.value);break;
    case 'null':set(event.path,null);break;
  }
  return root;
}
test('SAX JSON agrees with JSON values across every input chunk boundary, including UTF8 and escaped surrogate pairs',async()=>{
  const source=' {"array":[true,false,null,-1.25e+4,{"text":"hi 😀 \\uD83D\\uDE00 \\u2603 \\n \\t \\/ \\\\ \\\""}],"__proto__":{"retained":1},"x":"雪","duplicate":1,"duplicate":2} ';
  const bytes=encode(source);for(const size of [1,2,3,7,64,bytes.length])assert.deepEqual(await parseSmall(chunks(bytes,size)),JSON.parse(source));
});
test('single large string yields bounded chunks and exact byte locators without materializing an export or thread',async()=>{
  const block=encode('x'.repeat(4096));let reads=0,total=0,max=0;let end:JsonEvent|undefined;
  async function* large(){yield encode('"');for(let i=0;i<1024;i++){reads++;yield block;}yield encode('"');}
  for await(const event of jsonEvents(large(),{startOffset:42})){if(event.kind==='stringChunk'){total+=event.value.length;max=Math.max(max,event.value.length);}if(event.kind==='stringEnd')end=event;}
  assert.equal(reads,1024);assert.equal(total,4_194_304);assert.ok(max<=JSON_STREAM_LIMITS.stringChunkCharacters);assert.equal(end!.offset,42);assert.equal(end!.end,42+total+2);
});
test('syntax errors, truncated/invalid UTF8, depth, key and input chunk limits fail explicitly',async()=>{
  for(const source of ['', '[1,]', '{"a":1,}', '{a:1}', 'true false', '01', '1.', '1e', '"\\x"', '"\\u00xz"', '"unterminated', '"line\nfeed"', '['.repeat(66)+'0'+']'.repeat(66), '{"'+'x'.repeat(8193)+'":0}'])await assert.rejects(async()=>{for await(const _ of jsonEvents(chunks(encode(source),3))){};});
  for(const bytes of [Uint8Array.of(34,0xf0,0x9f,34),Uint8Array.of(34,0xc0,0xaf,34)])await assert.rejects(async()=>{for await(const _ of jsonEvents(chunks(bytes,1))){};},/UTF-8/);
  await assert.rejects(async()=>{for await(const _ of jsonEvents(chunks(new Uint8Array(1_048_577),1_048_577))){};},/bounded/);
});
test('cancellation closes the source and does not silently accept its prefix',async()=>{
  let cancelled=false,closed=false;async function* source(){try{yield encode('["first",');cancelled=true;yield encode('"second"]');}finally{closed=true;}}
  await assert.rejects(async()=>{for await(const _ of jsonEvents(source(),{cancelled:()=>cancelled})){};},/cancelled/);assert.equal(closed,true);
});
