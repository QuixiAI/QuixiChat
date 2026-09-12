/** Count serialized UTF-8 bytes without constructing the serialized payload. */
export function jsonByteLength(value: unknown, limit = 1_048_576): number {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid JSON byte limit");
  let bytes = 0; const ancestors = new Set<object>();
  const add = (count: number) => { bytes += count; if (bytes > limit) throw new Error("Boundary payload exceeds byte limit"); };
  const string = (text: string) => {
    add(2);
    for (let index=0; index<text.length; index++) {
      const code=text.charCodeAt(index);
      if(code===34||code===92||[8,9,10,12,13].includes(code)) add(2);
      else if(code<32) add(6);
      else if(code>=0xd800&&code<=0xdbff){
        const next=text.charCodeAt(index+1);
        if(next>=0xdc00&&next<=0xdfff){add(4);index++;}else add(6);
      } else if(code>=0xdc00&&code<=0xdfff) add(6);
      else add(code<0x80?1:code<0x800?2:3);
    }
  };
  const visit=(item:unknown,depth:number):void=>{
    if(depth>128) throw new Error("Boundary JSON nesting exceeds 128");
    if(item===null){add(4);return;}
    if(typeof item==='string'){string(item);return;}
    if(typeof item==='boolean'){add(item?4:5);return;}
    if(typeof item==='number'&&Number.isFinite(item)){add(String(item).length);return;}
    if(!item||typeof item!=='object'||(!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))) throw new Error("Boundary payload must be plain finite JSON");
    if(ancestors.has(item)) throw new Error("Boundary payload contains a cycle");
    ancestors.add(item); add(2);
    if(Array.isArray(item)){
      for(let index=0;index<item.length;index++){if(index)add(1);visit(item[index],depth+1);}
    }else{
      let count=0;
      for(const key in item){
        const descriptor=Object.getOwnPropertyDescriptor(item,key);
        if(!descriptor?.enumerable)continue;
        if(descriptor.get||descriptor.set)throw new Error("Boundary payload cannot contain accessors");
        if(count++)add(1);string(key);add(1);visit(descriptor.value,depth+1);
      }
    }
    ancestors.delete(item);
  };
  visit(value,0);return bytes;
}
