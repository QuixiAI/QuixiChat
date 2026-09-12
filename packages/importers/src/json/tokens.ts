/** SAX JSON events. Strings are chunks; even a single multi-gigabyte value never becomes one JS string. */
export type JsonPath=readonly (string|number)[];
export type JsonEvent=
 | {kind:'objectStart'|'objectEnd'|'arrayStart'|'arrayEnd'|'stringStart'|'stringEnd';path:JsonPath;offset:number;end:number}
 | {kind:'stringChunk';path:JsonPath;value:string;offset:number;end:number}
 | {kind:'number';path:JsonPath;raw:string;offset:number;end:number}
 | {kind:'boolean';path:JsonPath;value:boolean;offset:number;end:number}
 | {kind:'null';path:JsonPath;offset:number;end:number};
export const JSON_STREAM_LIMITS=Object.freeze({maxDepth:64,maxKeyCharacters:8192,maxNumberCharacters:128,stringChunkCharacters:4096,maxInputChunkBytes:1_048_576});
export class ImportJsonError extends Error{
  constructor(message:string,readonly offset:number){super(`${message} at byte ${offset}`);this.name='ImportJsonError';}
}
class Cursor{
  private chunk:Uint8Array=new Uint8Array(0);private index=0;private iterator:AsyncIterator<Uint8Array>;offset=0;
  constructor(source:AsyncIterable<Uint8Array>,private cancelled:()=>boolean,offset:number){this.iterator=source[Symbol.asyncIterator]();this.offset=offset;}
  peek():number{return this.chunk[this.index]??-1;}
  take():number{const value=this.peek();if(value<0)throw new Error('JSON cursor needs a chunk');this.index++;this.offset++;return value;}
  async ensure():Promise<boolean>{
    if(this.cancelled())throw Object.assign(new Error('Import parsing cancelled'),{code:'CANCELLED'});
    while(this.index===this.chunk.length){const next=await this.iterator.next();if(this.cancelled())throw Object.assign(new Error('Import parsing cancelled'),{code:'CANCELLED'});if(next.done)return false;
      if(!(next.value instanceof Uint8Array)||next.value.byteLength>JSON_STREAM_LIMITS.maxInputChunkBytes)throw new ImportJsonError('Input must supply bounded byte chunks',this.offset);
      this.chunk=next.value;this.index=0;
    }return true;
  }
  async close():Promise<void>{await this.iterator.return?.();}
  fail(message:string):never{throw new ImportJsonError(message,this.offset);}
}
const whitespace=(value:number)=>value===32||value===9||value===10||value===13;
async function skip(cursor:Cursor):Promise<boolean>{while(await cursor.ensure()){while(whitespace(cursor.peek()))cursor.take();if(cursor.peek()>=0)return true;}return false;}
async function required(cursor:Cursor,byte:number):Promise<void>{if(!await skip(cursor)||cursor.take()!==byte)cursor.fail(`Expected ${String.fromCharCode(byte)}`);}
/** A bounded UTF-8 byte decoder is independent for each literal run between JSON escapes. */
async function* string(cursor:Cursor):AsyncGenerator<string>{
  if(cursor.take()!==34)cursor.fail('Expected string');
  const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});let bytes:number[]=[],value='';
  const flush=(final:boolean)=>{try{value+=decoder.decode(Uint8Array.from(bytes),{stream:!final});bytes=[];}catch{cursor.fail('Malformed UTF-8 in JSON string');}};
  while(cursor.peek()>=0||await cursor.ensure()){
    const byte=cursor.take();
    if(byte===34){flush(true);if(value)yield value;return;}
    if(byte<32)cursor.fail('Unescaped control in JSON string');
    if(byte===92){
      flush(true);if(!await cursor.ensure())cursor.fail('Truncated JSON escape');const escaped=cursor.take();
      const simple:Record<number,string>={34:'"',92:'\\',47:'/',98:'\b',102:'\f',110:'\n',114:'\r',116:'\t'};
      if(escaped===117){let hex='';for(let i=0;i<4;i++){if(!await cursor.ensure())cursor.fail('Truncated Unicode escape');const char=String.fromCharCode(cursor.take());if(!/^[0-9a-fA-F]$/.test(char))cursor.fail('Malformed Unicode escape');hex+=char;}value+=String.fromCharCode(Number.parseInt(hex,16));}
      else if(Object.hasOwn(simple,escaped))value+=simple[escaped];else cursor.fail('Unknown JSON escape');
    }else bytes.push(byte);
    if(bytes.length>=4096)flush(false);
    while(value.length>=JSON_STREAM_LIMITS.stringChunkCharacters){
      // Retain a high surrogate until its possible low surrogate arrives.
      const endLimit=JSON_STREAM_LIMITS.stringChunkCharacters,last=value.charCodeAt(endLimit-1),end=last>=0xd800&&last<=0xdbff?endLimit-1:endLimit;
      if(end){yield value.slice(0,end);value=value.slice(end);}
    }
  }
  cursor.fail('Unterminated JSON string');
}
async function* value(cursor:Cursor,path:JsonPath,depth:number):AsyncGenerator<JsonEvent>{
  if(depth>JSON_STREAM_LIMITS.maxDepth)cursor.fail('JSON nesting exceeds supported depth');
  if(!await skip(cursor))cursor.fail('Expected JSON value');const offset=cursor.offset,byte=cursor.peek();
  if(byte===123){
    cursor.take();yield{kind:'objectStart',path,offset,end:cursor.offset};
    if(!await skip(cursor))cursor.fail('Unterminated object');
    if(cursor.peek()!==125){while(true){
      if(!await skip(cursor)||cursor.peek()!==34)cursor.fail('Expected JSON object key');
      let key='';for await(const part of string(cursor)){key+=part;if(key.length>JSON_STREAM_LIMITS.maxKeyCharacters)cursor.fail('JSON key exceeds supported length');}
      await required(cursor,58);yield* value(cursor,[...path,key],depth+1);
      if(!await skip(cursor))cursor.fail('Unterminated object');if(cursor.peek()===125)break;
      if(cursor.take()!==44)cursor.fail('Expected object separator');
    }}
    cursor.take();yield{kind:'objectEnd',path,offset,end:cursor.offset};return;
  }
  if(byte===91){
    cursor.take();yield{kind:'arrayStart',path,offset,end:cursor.offset};let index=0;
    if(!await skip(cursor))cursor.fail('Unterminated array');
    if(cursor.peek()!==93){while(true){yield* value(cursor,[...path,index++],depth+1);
      if(!Number.isSafeInteger(index))cursor.fail('JSON array index exceeds safe range');
      if(!await skip(cursor))cursor.fail('Unterminated array');if(cursor.peek()===93)break;
      if(cursor.take()!==44)cursor.fail('Expected array separator');
    }}
    cursor.take();yield{kind:'arrayEnd',path,offset,end:cursor.offset};return;
  }
  if(byte===34){
    yield{kind:'stringStart',path,offset,end:offset+1};
    for await(const part of string(cursor))yield{kind:'stringChunk',path,value:part,offset,end:cursor.offset};
    yield{kind:'stringEnd',path,offset,end:cursor.offset};return;
  }
  if(byte===116||byte===102||byte===110){
    const literal=byte===116?'true':byte===102?'false':'null';for(const char of literal){if(!await cursor.ensure()||cursor.take()!==char.charCodeAt(0))cursor.fail('Malformed JSON literal');}
    if(literal==='null')yield{kind:'null',path,offset,end:cursor.offset};else yield{kind:'boolean',path,value:literal==='true',offset,end:cursor.offset};return;
  }
  let raw='';while(cursor.peek()>=0||await cursor.ensure()){
    const next=cursor.peek();if(whitespace(next)||next===44||next===93||next===125)break;
    if(!((next>=48&&next<=57)||next===43||next===45||next===46||next===69||next===101))cursor.fail('Malformed JSON number');
    raw+=String.fromCharCode(cursor.take());if(raw.length>JSON_STREAM_LIMITS.maxNumberCharacters)cursor.fail('JSON number exceeds supported length');
  }
  if(!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(raw))cursor.fail('Malformed JSON number');
  yield{kind:'number',path,raw,offset,end:cursor.offset};
}
export async function* jsonEvents(source:AsyncIterable<Uint8Array>,options:{startOffset?:number;cancelled?:()=>boolean}={}):AsyncGenerator<JsonEvent>{
  if(!Number.isSafeInteger(options.startOffset??0)||(options.startOffset??0)<0)throw new ImportJsonError('Invalid starting byte offset',0);
  const cursor=new Cursor(source,options.cancelled??(()=>false),options.startOffset??0);
  try{yield* value(cursor,[],0);if(await skip(cursor))cursor.fail('Unexpected data after JSON value');}
  finally{await cursor.close();}
}
