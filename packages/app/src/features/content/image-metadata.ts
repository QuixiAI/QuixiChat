export interface ImageMetadata {mimeType:'image/png'|'image/jpeg';width:number;height:number}
/** Read only bounded structural dimensions; browser decoding still determines whether bytes are a valid image. */
export function imageMetadata(bytes:Uint8Array):ImageMetadata {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length>=33&&[137,80,78,71,13,10,26,10].every((byte,index)=>bytes[index]===byte)){
    if(view.getUint32(8)!==13||String.fromCharCode(...bytes.subarray(12,16))!=='IHDR')throw new Error('PNG header is invalid.');return checked('image/png',view.getUint32(16),view.getUint32(20));
  }
  if(bytes[0]===0xff&&bytes[1]===0xd8){let offset=2,markers=0;while(offset+4<=bytes.length&&offset<262_144&&markers++<512){if(bytes[offset++]!==0xff)throw new Error('JPEG marker is invalid.');while(bytes[offset]===0xff)offset++;const marker=bytes[offset++];if(marker===undefined||marker===0xda||marker===0xd9)break;if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;if(offset+2>bytes.length)break;const size=view.getUint16(offset);if(size<2||offset+size>bytes.length)throw new Error('JPEG segment is invalid.');if([0xc0,0xc1,0xc2].includes(marker)){if(size<8)throw new Error('JPEG frame is invalid.');return checked('image/jpeg',view.getUint16(offset+5),view.getUint16(offset+3));}offset+=size;}}
  throw new Error('Preview supports PNG and standard JPEG files with a bounded readable image header.');
}
function checked(mimeType:ImageMetadata['mimeType'],width:number,height:number):ImageMetadata {if(!width||!height||width>16_000||height>16_000||width*height>16_000_000)throw new Error('This image exceeds the 16-megapixel preview limit. Its original can still be saved.');return {mimeType,width,height};}
