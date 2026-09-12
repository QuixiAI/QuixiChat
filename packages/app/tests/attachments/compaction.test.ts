import test from 'node:test';
import assert from 'node:assert/strict';
import type { StorageClient } from '@quixi/core/contracts';
import { createCompactionController } from '../../src/features/compaction/controller.ts';
const id=()=>crypto.randomUUID();
const scope={threadId:id(),revision:4,contextId:id(),leaf:id()};
function fixture(options:{stale?:boolean;many?:boolean;pause?:boolean}={}) {
  const part={id:id(),messageId:scope.leaf,order:0,kind:'Image',data:{attachmentId:id(),description:'private description'}};
  const calls:string[]=[], cancelled:string[]=[];
  let release:()=>void=()=>{};
  const storage={async request(_id:string,op:string,args:any){
    calls.push(op);
    if(options.pause) await new Promise<void>(resolve=>{release=resolve;});
    if(op==='readConversationWindow') return {items:[{id:scope.leaf,sealed:true}],nextCursor:null};
    if(op==='readMessageParts') return {items:options.many?Array.from({length:65},()=>({...part,id:id()})):[part],nextCursor:null};
    if(op==='readEntity') return args.collection==='parts'?{...part,id:args.id}:{filename:'private.png'};
    if(op==='readThreadView')return {state:{revision:options.stale?5:4},context:{id:scope.contextId}};
    throw new Error(`Unexpected operation ${op}`);
  },async cancel(requestId:string){cancelled.push(requestId);}} as unknown as StorageClient;
  return {controller:createCompactionController(storage),part,calls,cancelled,release:()=>release()};
}
test('attachment review reads metadata only and retains exclusions outside the current branch',async()=>{
  const f=fixture(),outside=id(); await f.controller.open(scope,[outside]);
  const state=f.controller.getSnapshot(); assert.equal(state.ready,true);assert.equal(state.choices.length,2);assert.equal(state.choices[1]!.onBranch,false);assert.deepEqual(state.selected,[outside]);
  assert(f.calls.every(op=>['readConversationWindow','readMessageParts','readEntity','readThreadView'].includes(op)));
  f.controller.select([f.part.id]);assert.deepEqual(f.controller.getSnapshot().selected,[f.part.id]);
  f.controller.select([id()]);assert.deepEqual(f.controller.getSnapshot().selected,[f.part.id]);
});
test('cancelled discovery cancels the pending read and publishes no late choices',async()=>{
 const f=fixture({pause:true}),work=f.controller.open(scope,[]);f.controller.cancel();f.release();await work;assert.equal(f.cancelled.length,1);assert.equal(f.controller.getSnapshot().scope,null);assert.deepEqual(f.controller.getSnapshot().choices,[]);
});
test('stale scope, too many occurrences and unknown policy versions never yield an applicable partial review',async()=>{
 for(const options of [{stale:true},{many:true}]){const f=fixture(options);await f.controller.open(scope,[]);assert.equal(f.controller.getSnapshot().ready,false);assert(f.controller.getSnapshot().error);assert.deepEqual(f.controller.getSnapshot().choices,[]);}
 const f=fixture();await f.controller.open(scope,['invalid']);assert.equal(f.calls.length,0);assert.equal(f.controller.getSnapshot().ready,false);
});
