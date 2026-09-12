import type {ImportByteSource} from '../src/types.ts';
/** Original synthetic generator: one source node at a time, reverse parent order, no complete export string or graph. */
export function largeChatgptSource(messageCount:number):ImportByteSource{
 if(!Number.isSafeInteger(messageCount)||messageCount<1)throw new Error('Positive fixture message count required');
 const encoder=new TextEncoder();
 function* pieces(){yield '[{"conversation_id":"large-original-synthetic","title":"Large bounded fixture","current_node":"n'+(messageCount-1)+'","mapping":{';
  for(let index=messageCount-1;index>=0;index--){if(index!==messageCount-1)yield ',';yield JSON.stringify(`n${index}`)+':'+JSON.stringify({parent:index===0?null:`n${index-1}`,message:{id:`native-${index}`,author:{role:index%2===0?'user':'assistant'},create_time:1700000000+index,content:{content_type:'text',parts:[`Synthetic source message ${index}.`]}}});}yield '}}]';
 }
 let byteLength=0;for(const piece of pieces())byteLength+=encoder.encode(piece).length;
 return{name:'conversations.json',byteLength,async*open(start=0,end=byteLength){let offset=0;for(const piece of pieces()){const bytes=encoder.encode(piece),from=Math.max(0,start-offset),to=Math.min(bytes.length,end-offset);if(to>from)yield bytes.slice(from,to);offset+=bytes.length;if(offset>=end)break;}}};
}
