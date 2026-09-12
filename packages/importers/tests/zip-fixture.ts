import {crc32,deflateRawSync} from 'node:zlib';
import type {ImportByteSource} from '../src/types.ts';
export function makeZip(files:{name:string;bytes:Uint8Array;method?:0|8}[],zip64=false):Uint8Array{
 const locals:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const file of files){const name=Buffer.from(file.name),method=file.method??8,data=method===8?deflateRawSync(file.bytes):Buffer.from(file.bytes),checksum=crc32(file.bytes);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(method,8);local.writeUInt32LE(checksum,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(file.bytes.length,22);local.writeUInt16LE(name.length,26);locals.push(local,name,data);
  const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(method,10);record.writeUInt32LE(checksum,16);record.writeUInt32LE(data.length,20);record.writeUInt32LE(file.bytes.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(offset,42);central.push(record,name);offset+=local.length+name.length+data.length;
 }
 const directory=Buffer.concat(central),ending:Buffer[]=[];
 if(zip64){const record=Buffer.alloc(56);record.writeUInt32LE(0x06064b50);record.writeBigUInt64LE(44n,4);record.writeUInt16LE(45,12);record.writeUInt16LE(45,14);record.writeBigUInt64LE(BigInt(files.length),24);record.writeBigUInt64LE(BigInt(files.length),32);record.writeBigUInt64LE(BigInt(directory.length),40);record.writeBigUInt64LE(BigInt(offset),48);const locator=Buffer.alloc(20);locator.writeUInt32LE(0x07064b50);locator.writeBigUInt64LE(BigInt(offset+directory.length),8);locator.writeUInt32LE(1,16);ending.push(record,locator);}
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(zip64?0xffff:files.length,8);end.writeUInt16LE(zip64?0xffff:files.length,10);end.writeUInt32LE(zip64?0xffffffff:directory.length,12);end.writeUInt32LE(zip64?0xffffffff:offset,16);return Buffer.concat([...locals,directory,...ending,end]);
}
export function zipSource(bytes:Uint8Array):ImportByteSource{return{name:'export.zip',byteLength:bytes.length,async*open(start=0,end=bytes.length){for(let offset=start;offset<end;offset+=3072)yield bytes.slice(offset,Math.min(end,offset+3072));}};}
