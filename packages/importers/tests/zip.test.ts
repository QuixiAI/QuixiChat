import test from 'node:test';
import assert from 'node:assert/strict';
import {makeZip,zipSource} from './zip-fixture.ts';
import {zipEntries} from '../src/zip/reader.ts';

test('stored/deflated ZIP and ZIP64 directories stream exact verified entry bytes',async()=>{
 const expected=new TextEncoder().encode('original 😀 source '.repeat(9000));
 for(const zip64 of [false,true]){const archive=makeZip([{name:'folder/conversations-000.json',bytes:expected},{name:'asset.bin',bytes:Uint8Array.of(0,1,2),method:0}],zip64);let count=0;
  for await(const entry of zipEntries(zipSource(archive),{maxEntryBytes:2_000_000})){const chunks:Uint8Array[]=[];for await(const chunk of entry.open()){assert.ok(chunk.length<=1_048_576);chunks.push(chunk);}assert.deepEqual(Buffer.concat(chunks),Buffer.from(count===0?expected:Uint8Array.of(0,1,2)));count++;}assert.equal(count,2);
 }
});

test('ZIP rejects traversal, encryption, output-budget violations, truncation and CRC corruption',async()=>{
 const text=new TextEncoder().encode('synthetic content');
 async function drain(bytes:Uint8Array,maxEntryBytes=1_000_000){for await(const entry of zipEntries(zipSource(bytes),{maxEntryBytes}))for await(const _ of entry.open()){/* verify complete CRC */}}
 await assert.rejects(drain(makeZip([{name:'../outside.json',bytes:text}])),/path/);
 await assert.rejects(drain(makeZip([{name:'safe.json',bytes:text}]),2),/budget/);
 const bad=makeZip([{name:'safe.json',bytes:text,method:0}]);bad[30+'safe.json'.length]=bad[30+'safe.json'.length]!^1;await assert.rejects(drain(bad),/CRC32/);
 const truncated=makeZip([{name:'safe.json',bytes:text}]).slice(0,-3);await assert.rejects(drain(truncated),/directory/);
 const encrypted=makeZip([{name:'safe.json',bytes:text}]);for(let i=0;i<encrypted.length-4;i++)if(new DataView(encrypted.buffer,encrypted.byteOffset).getUint32(i,true)===0x02014b50){encrypted[i+8]!|=1;break;}await assert.rejects(drain(encrypted),/Encrypted/);
});
