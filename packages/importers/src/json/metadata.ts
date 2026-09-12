import type {JsonEvent,JsonPath} from './tokens.ts';
/** Select only explicitly named scalar metadata. Never buffer an arbitrary object or content string. */
export class ScalarCollector{
  private text='';private selected=false;private truncated=false;private path:JsonPath=[];
  constructor(private accepts:(path:JsonPath)=>boolean,private store:(path:JsonPath,value:string|number|boolean|null,truncated:boolean)=>void,private maxCharacters=8192){}
  accept(event:JsonEvent):void{
    if(event.kind==='stringStart'){this.path=event.path;this.selected=this.accepts(event.path);this.text='';this.truncated=false;return;}
    if(event.kind==='stringChunk'){
      if(this.selected){const available=this.maxCharacters-this.text.length;this.text+=event.value.slice(0,Math.max(0,available));if(event.value.length>available)this.truncated=true;}return;
    }
    if(event.kind==='stringEnd'){if(this.selected)this.store(this.path,this.text,this.truncated);this.selected=false;this.text='';return;}
    if(!this.accepts(event.path))return;
    if(event.kind==='number'){const number=Number(event.raw);this.store(event.path,Number.isFinite(number)?number:null,!Number.isFinite(number));}
    else if(event.kind==='boolean')this.store(event.path,event.value,false);
    else if(event.kind==='null')this.store(event.path,null,false);
  }
}
export function jsonPointer(path:JsonPath):string{return '/'+path.map(value=>String(value).replaceAll('~','~0').replaceAll('/','~1')).join('/');}
