import type {ImportByteSource} from '../types.ts';
/** ZIP/ZIP64 stored and raw-deflate entries. Metadata is read one record at a time; extraction never writes archive paths to a host filesystem. */
export interface ZipEntryDescriptor {name:string;ordinal:number;byteLength:number;compressedBytes:number;compression:0|8;crc32:number;localOffset:number;directory:boolean;flags:number;directoryOffset:number}
export interface ZipEntry extends ZipEntryDescriptor {open():AsyncIterable<Uint8Array>}
const u16=(bytes:Uint8Array,offset:number)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint16(offset,true);
const u32=(bytes:Uint8Array,offset:number)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(offset,true);
const u64=(bytes:Uint8Array,offset:number)=>{const value=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getBigUint64(offset,true);if(value>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('ZIP offset/size exceeds exact numeric representation');return Number(value);};
async function read(source:ImportByteSource,start:number,length:number):Promise<Uint8Array>{
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(length)||start<0||length<0||length>196_608||start+length>source.byteLength)throw new Error('ZIP metadata range is invalid or too large');
 const bytes=new Uint8Array(length);let offset=0;for await(const chunk of source.open(start,start+length)){if(chunk.length>1_048_576||offset+chunk.length>length)throw new Error('ZIP source range mismatch');bytes.set(chunk,offset);offset+=chunk.length;}if(offset!==length)throw new Error('ZIP metadata is truncated');return bytes;
}
function safeName(bytes:Uint8Array,flags:number):string{
 if(!(flags&0x800)&&bytes.some(byte=>byte>127))throw new Error('Legacy non-ASCII ZIP names require an explicit supported encoding');
 const name=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 if(!name||name.length>8192||name.includes('\\')||name.includes('\0')||name.startsWith('/')||/^[a-zA-Z]:/.test(name)||name.split('/').some(segment=>segment==='..'||segment==='.'||segment==='')){
  if(name.endsWith('/')&&name.length>1&&!name.slice(0,-1).split('/').some(segment=>!segment||segment==='.'||segment==='..')&&!name.startsWith('/')&&!name.includes('\\')&&!name.includes('\0')&&!/^[a-zA-Z]:/.test(name)&&name.length<=8192)return name;
  throw new Error('ZIP entry has an ambiguous or unsafe path');
 }
 return name;
}
const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function crcUpdate(crc:number,bytes:Uint8Array):number{for(const byte of bytes)crc=crcTable[(crc^byte)&255]!^(crc>>>8);return crc;}
async function* inflate(input:AsyncIterable<Uint8Array>):AsyncGenerator<Uint8Array>{
 const iterator=input[Symbol.asyncIterator]();
 const stream=new ReadableStream<BufferSource>({async pull(controller){try{const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(new Uint8Array(next.value));}catch(error){controller.error(error);}},async cancel(){await iterator.return?.();}});
 const reader=stream.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
 try{while(true){const next=await reader.read();if(next.done)break;for(let offset=0;offset<next.value.length;offset+=1_048_576)yield next.value.subarray(offset,offset+1_048_576);}}finally{await reader.cancel();reader.releaseLock();await iterator.return?.();}
}
/** Caller supplies a quota-aware entry limit. No total archive manifest is held in JS. */
export async function* zipEntries(source:ImportByteSource,options:{maxEntryBytes:number;cancelled?:()=>boolean}):AsyncGenerator<ZipEntry>{
 if(!Number.isSafeInteger(options.maxEntryBytes)||options.maxEntryBytes<0)throw new Error('A finite ZIP entry byte budget is required');
 const check=()=>{if(options.cancelled?.())throw new Error('ZIP reading paused');};check();
 const tailStart=Math.max(0,source.byteLength-65_557),tail=await read(source,tailStart,source.byteLength-tailStart);let end=-1;
 for(let offset=tail.length-22;offset>=0;offset--)if(u32(tail,offset)===0x06054b50&&offset+22+u16(tail,offset+20)===tail.length){end=offset;break;}
 if(end<0)throw new Error('ZIP end-of-directory record is missing');
 if(u16(tail,end+4)||u16(tail,end+6))throw new Error('Split ZIP archives are unsupported');
 let entries=u16(tail,end+10),directoryBytes=u32(tail,end+12),directoryOffset=u32(tail,end+16);
 if(entries!==u16(tail,end+8))throw new Error('ZIP disk entry counts disagree');
 if(entries===0xffff||directoryBytes===0xffffffff||directoryOffset===0xffffffff){
  const locator=await read(source,tailStart+end-20,20);if(u32(locator,0)!==0x07064b50||u32(locator,4)!==0||u32(locator,16)!==1)throw new Error('ZIP64 locator is invalid or split');
  const position=u64(locator,8),record=await read(source,position,56);if(u32(record,0)!==0x06064b50||u64(record,4)<44||position+12+u64(record,4)!==tailStart+end-20||u32(record,16)||u32(record,20))throw new Error('ZIP64 directory record is invalid');
  entries=u64(record,32);if(entries!==u64(record,24))throw new Error('ZIP64 disk entry counts disagree');directoryBytes=u64(record,40);directoryOffset=u64(record,48);
 }
 if(!Number.isSafeInteger(directoryOffset+directoryBytes)||directoryOffset+directoryBytes>tailStart+end)throw new Error('ZIP central directory is out of bounds');
 let cursor=directoryOffset;
 for(let ordinal=0;ordinal<entries;ordinal++){
  check();const fixed=await read(source,cursor,46);if(u32(fixed,0)!==0x02014b50)throw new Error('ZIP central header signature is invalid');
  const flags=u16(fixed,8),compression=u16(fixed,10),nameLength=u16(fixed,28),extraLength=u16(fixed,30),commentLength=u16(fixed,32);
  if(flags&0x2041)throw new Error('Encrypted or masked ZIP entries are unsupported');if(compression!==0&&compression!==8)throw new Error(`ZIP compression method ${compression} is unsupported`);
  const variable=await read(source,cursor+46,nameLength+extraLength+commentLength);cursor+=46+variable.length;if(cursor>directoryOffset+directoryBytes)throw new Error('ZIP directory entry exceeds its region');
  const name=safeName(variable.subarray(0,nameLength),flags),extra=variable.subarray(nameLength,nameLength+extraLength);
  let byteLength=u32(fixed,24),compressedBytes=u32(fixed,20),localOffset=u32(fixed,42),disk=u16(fixed,34),found=false;
  for(let offset=0;offset<extra.length;){if(offset+4>extra.length)throw new Error('Truncated ZIP extra field');const tag=u16(extra,offset),length=u16(extra,offset+2);offset+=4;if(offset+length>extra.length)throw new Error('Truncated ZIP extra payload');if(tag===1){if(found)throw new Error('Duplicate ZIP64 extra field');found=true;let position=offset;const next=()=>{if(position+8>offset+length)throw new Error('Truncated ZIP64 integer');const value=u64(extra,position);position+=8;return value;};if(byteLength===0xffffffff)byteLength=next();if(compressedBytes===0xffffffff)compressedBytes=next();if(localOffset===0xffffffff)localOffset=next();if(disk===0xffff){if(position+4>offset+length)throw new Error('Truncated ZIP64 disk');disk=u32(extra,position);}}offset+=length;}
  if((u32(fixed,24)===0xffffffff||u32(fixed,20)===0xffffffff||u32(fixed,42)===0xffffffff)&&!found)throw new Error('ZIP64 extension is missing');
  if(disk!==0||byteLength>options.maxEntryBytes)throw new Error('ZIP entry exceeds the selected byte budget or uses split storage');
  const crc32=u32(fixed,16),directory=name.endsWith('/');
  const descriptor:ZipEntryDescriptor={name,ordinal,byteLength,compressedBytes,compression,crc32,localOffset,directory,flags,directoryOffset};
  yield{...descriptor,open:()=>openZipEntry(source,descriptor,options)};
 }
 if(cursor!==directoryOffset+directoryBytes)throw new Error('ZIP central directory has unsupported trailing records');
}

/** Reopen an indexed descriptor without rescanning the central directory. */
export async function* openZipEntry(source:ImportByteSource,entry:ZipEntryDescriptor,options:{maxEntryBytes:number;cancelled?:()=>boolean}):AsyncGenerator<Uint8Array>{
 const {name,byteLength,compressedBytes,compression,crc32,localOffset,flags,directoryOffset}=entry;
 if(![byteLength,compressedBytes,localOffset,directoryOffset].every(value=>Number.isSafeInteger(value)&&value>=0)||byteLength>options.maxEntryBytes||![0,8].includes(compression)||(flags&0x2041))throw new Error('Invalid indexed ZIP entry');
 const check=()=>{if(options.cancelled?.())throw new Error('ZIP reading paused');};

   check();const local=await read(source,localOffset,30);if(u32(local,0)!==0x04034b50||u16(local,6)!==flags||u16(local,8)!==compression)throw new Error('ZIP local and central headers disagree');
   const localName=await read(source,localOffset+30,u16(local,26));if(safeName(localName,flags)!==name)throw new Error('ZIP local filename disagrees with directory');
   const dataStart=localOffset+30+u16(local,26)+u16(local,28);if(dataStart+compressedBytes>directoryOffset||!Number.isSafeInteger(dataStart+compressedBytes))throw new Error('ZIP compressed data exceeds its region');
   let count=0,crc=0xffffffff,compressedCount=0;
   async function* input(){for await(const chunk of source.open(dataStart,dataStart+compressedBytes)){check();if(chunk.length>1_048_576)throw new Error('ZIP input chunk exceeds bound');compressedCount+=chunk.length;if(compressedCount>compressedBytes)throw new Error('ZIP compressed size mismatch');yield chunk;}if(compressedCount!==compressedBytes)throw new Error('ZIP compressed data truncated');}
   const output=compression===0?input():inflate(input());
   for await(const chunk of output){check();count+=chunk.length;if(count>byteLength||count>options.maxEntryBytes)throw new Error('ZIP expansion exceeds declared size or selected budget');crc=crcUpdate(crc,chunk);yield chunk;}
   if(count!==byteLength||((crc^0xffffffff)>>>0)!==crc32)throw new Error('ZIP decompressed size or CRC32 mismatch');
}
