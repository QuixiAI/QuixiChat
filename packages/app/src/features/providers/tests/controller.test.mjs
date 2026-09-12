import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProviderSettingsController} from '../controller.ts';
import {initialProviderCatalogs,adapterCatalog,createOpenAICompatibleAdapter,openAIRegionalEvidence,openAIRelayRegionalEvidence} from '@quixi/providers';
const binding={providerId:'openai',accountId:'primary',destinationId:'quixi-openai-api-v1',transportId:'quixi-openai-native-v1'};
const capability={available:true,permission:'not_required',reason:null};
function fixture(){let stored=null,failReply=false;const calls=[],changes=[];const host={async capabilities(){return {host:'desktop',secretPersistence:'native',providerTransports:[{id:binding.transportId,capability,kind:'native_direct',privacy:'direct_provider',endpointOrigin:'https://api.openai.com',relayIdentity:null}]};},async openSecret(){return structuredClone(stored);},async storeSecret(request,binding,value,replace){calls.push({replace,bytes:[...value]});stored={id:crypto.randomUUID(),persistence:'native',binding};if(failReply){failReply=false;throw Object.assign(new Error('Lost reply'),{code:'UNKNOWN_OUTCOME'});}return structuredClone(stored);},async deleteSecret(request,handle){assert.equal(handle.id,stored.id);stored=null;},async cancel(){}};const options={host,connections:[{id:'openai',label:'OpenAI',binding,catalog:initialProviderCatalogs()[0],relayAuthorizationRequired:false}],credentialCapability:capability,onChange:value=>changes.push(value)};return {host,options,calls,changes,lose(){failReply=true;},get stored(){return stored;}};}
test('opaque reopen, replacement, lost write outcome and byte cleanup survive controller restart',async()=>{const f=fixture(),first=createProviderSettingsController(f.options);await first.initialize();assert.equal(f.changes.at(-1).length,0);const bytes=new TextEncoder().encode('synthetic');await first.connect('openai',bytes);assert.ok(bytes.every(value=>value===0));assert.equal(f.changes.at(-1).length,1);const previous=f.stored.id;f.lose();await first.connect('openai',new TextEncoder().encode('replacement'));assert.equal(f.calls.length,2);assert.equal(f.calls[1].replace.id,previous);assert.match(first.getSnapshot().connections[0].error,/Lost reply/);await first.reopen('openai');assert.equal(f.calls.length,2);assert.equal(first.getSnapshot().connections[0].error,null);await first.dispose();const second=createProviderSettingsController(f.options);await second.initialize();assert.equal(second.getSnapshot().connections[0].connected,true);await second.disconnect('openai');assert.equal(f.stored,null);assert.equal(f.changes.at(-1).length,0);await second.dispose();});
test('missing transport and unavailable credentials never produce an enabled adapter',async()=>{const f=fixture();f.host.capabilities=async()=>({host:'web',secretPersistence:'session',providerTransports:[]});const controller=createProviderSettingsController({...f.options,credentialCapability:{...capability,available:false,reason:'Keychain unavailable'}});await controller.initialize();const bytes=new TextEncoder().encode('synthetic');await controller.connect('openai',bytes);assert.equal(f.calls.length,0);assert.ok(bytes.every(value=>value===0));assert.equal(f.changes.at(-1).length,0);assert.equal(controller.getSnapshot().connections[0].capability.available,false);await controller.dispose();});
test('unconfigured transport does not attempt credential reopen or report a false credential error',async()=>{const f=fixture();f.host.capabilities=async()=>({host:'web',secretPersistence:'session',providerTransports:[]});let opens=0;f.host.openSecret=async()=>{opens++;throw new Error('No registered destination');};const controller=createProviderSettingsController(f.options);await controller.initialize();assert.equal(opens,0);assert.equal(controller.getSnapshot().connections[0].error,null);assert.equal(controller.getSnapshot().connections[0].capability.available,false);assert.equal(f.changes.at(-1).length,0);await controller.dispose();});
test('reviewed model facts remain separate from adapter subset and unknown discovered model stays gated',()=>{const catalog=initialProviderCatalogs()[0];assert.deepEqual(catalog.model.capabilities.inputModalities,['text','image','file']);assert.deepEqual(adapterCatalog(catalog)[0].capabilities.inputModalities,['text','image','file']);assert.equal(catalog.model.capabilities.images,'supported');assert.equal(adapterCatalog(catalog)[0].capabilities.images,'supported');assert.equal(adapterCatalog(catalog)[0].capabilities.files,'supported');assert.deepEqual(adapterCatalog(catalog)[0].capabilities.fileMediaTypes,['application/pdf']);const f=fixture();const adapter=createOpenAICompatibleAdapter({host:f.host,binding,credential:null,catalog:adapterCatalog(catalog),nextId:crypto.randomUUID,now:Date.now});assert.throws(()=>adapter.prepare({requestId:crypto.randomUUID(),modelId:'unreviewed-model',systemPrompt:null,messages:[],parameters:{maxOutputTokens:128}}),error=>error.issues[0].code==='model_catalog_required');});
test('connection checks use the published adapter, whose live health the controller exposes',async()=>{const f=fixture();f.host.startProviderHttp=async request=>{assert.equal(request.path,'/v1/models');return {requestId:request.requestId,status:200,headers:{'content-type':'application/json'},bodyTransferId:'body-1'};};f.host.readChunk=async transferId=>({transferId,sequence:0,offset:0,bytes:new TextEncoder().encode('{"data":[]}'),final:true});f.host.acknowledgeChunk=async()=>{};f.host.releaseTransfer=async()=>{};const c=createProviderSettingsController(f.options);await c.initialize();await c.connect('openai',new TextEncoder().encode('synthetic'));const published=f.changes.at(-1)[0].adapter;assert.equal(c.health('openai').evidence,'none');assert.equal(c.getSnapshot().connections[0].health,null);await c.check('openai');assert.equal(c.getSnapshot().connections[0].health.status,'healthy');assert.equal(published.accountHealth().status,'healthy');assert.equal(c.health('openai').evidence,'models_probe');assert.equal(f.changes.at(-1)[0].adapter,published);await c.dispose();assert.equal(c.health('openai'),null);});
test('a connection check follows listing cursors up to the page bound and separates reviewed from unreviewed models',async()=>{const f=fixture();const seen=[];f.host.startProviderHttp=async request=>{seen.push(request.query??null);return {requestId:request.requestId,status:200,headers:{'content-type':'application/json'},bodyTransferId:`body-${seen.length}`};};f.host.readChunk=async transferId=>({transferId,sequence:0,offset:0,bytes:new TextEncoder().encode(JSON.stringify({object:'list',data:[{id:'gpt-4.1-mini-2025-04-14'},{id:'unreviewed-a'},{id:'unreviewed-b'}]})),final:true});f.host.acknowledgeChunk=async()=>{};f.host.releaseTransfer=async()=>{};const c=createProviderSettingsController(f.options);await c.initialize();await c.connect('openai',new TextEncoder().encode('synthetic'));await c.check('openai');const view=c.getSnapshot().connections[0];assert.equal(view.health.status,'healthy');assert.deepEqual(view.discovery,{total:3,reviewed:['gpt-4.1-mini-2025-04-14'],unreviewed:['unreviewed-a','unreviewed-b'],complete:true,pages:1});assert.deepEqual(seen,[null]);assert.deepEqual(f.changes.at(-1)[0].models.map(model=>model.id),['gpt-4.1-mini-2025-04-14','gpt-audio-1.5'],'only reviewed models are selectable; discovery does not establish account access');await c.dispose();});
test('connections identify direct, Quixi-relay and self-hosted transports from host capabilities alone',async()=>{const f=fixture();const transports=[{id:'direct',kind:'browser_direct',privacy:'direct_provider',endpointOrigin:'https://api.openai.com',relayIdentity:null},{id:'quixi',kind:'relay',privacy:'quixi_relay',endpointOrigin:'https://relay.quixi.example',relayIdentity:'Quixi'},{id:'own',kind:'relay',privacy:'self_hosted_remote',endpointOrigin:'https://relay.operator.example',relayIdentity:'Example operator'}].map(transport=>({...transport,capability}));f.host.capabilities=async()=>({host:'web',secretPersistence:'session',providerTransports:transports});const catalog=initialProviderCatalogs()[0];const options={...f.options,connections:transports.map(transport=>({id:`openai-${transport.id}`,label:`OpenAI via ${transport.id}`,binding:{...binding,transportId:transport.id},catalog,relayAuthorizationRequired:transport.kind==='relay'}))};const c=createProviderSettingsController(options);await c.initialize();const rows=c.getSnapshot().connections.map(row=>({id:row.id,privacy:row.privacy,origin:row.origin,relayIdentity:row.relayIdentity,available:row.capability.available}));assert.deepEqual(rows,[{id:'openai-direct',privacy:'direct_provider',origin:'https://api.openai.com',relayIdentity:null,available:true},{id:'openai-quixi',privacy:'quixi_relay',origin:'https://relay.quixi.example',relayIdentity:'Quixi',available:true},{id:'openai-own',privacy:'self_hosted_remote',origin:'https://relay.operator.example',relayIdentity:'Example operator',available:true}]);assert.equal(c.getSnapshot().persistence,'session');await c.dispose();});

function regionalFixture(region='us',relay=false){
  const f=fixture(),evidence=relay?openAIRelayRegionalEvidence(region,{configurationId:'a'.repeat(64),operator:'Synthetic regional operator',origin:'https://relay.example.test',region,destinationId:`openai_${region}`}):openAIRegionalEvidence(region),connectionId=`openai-${region}${relay?'-relay':''}`;
  let transport={id:evidence.binding.transportId,capability,kind:relay?'relay':'native_direct',privacy:relay?'self_hosted_remote':'direct_provider',endpointOrigin:evidence.relay?.origin??evidence.upstreamOrigin,relayIdentity:evidence.relay?.operator??null,regionalProcessing:evidence};
  f.options.connections=[{...f.options.connections[0],id:connectionId,label:`OpenAI ${region}`,binding:evidence.binding,processingRegion:region,relayAuthorizationRequired:relay}];
  f.host.capabilities=async()=>({host:relay?'web':'desktop',secretPersistence:relay?'session':'native',providerTransports:[transport]});
  let requests=0,stages=0;
  f.host.startProviderHttp=async request=>{requests++;return {requestId:request.requestId,status:200,headers:{},bodyTransferId:'regional-models'};};
  f.host.readChunk=async transferId=>({transferId,sequence:0,offset:0,bytes:new TextEncoder().encode('{"data":[]}'),final:true});
  f.host.acknowledgeChunk=async()=>{};f.host.releaseTransfer=async()=>{};
  f.host.beginTransfer=async()=>{stages++;throw new Error('Unexpected staging');};
  return {...f,id:connectionId,change:change=>{transport=change(structuredClone(transport));},get requests(){return requests;},get stages(){return stages;}};
}
const regionalInput=()=>({requestId:crypto.randomUUID(),modelId:'gpt-4.1-mini-2025-04-14',systemPrompt:null,messages:[{role:'user',parts:[{id:crypto.randomUUID(),messageId:crypto.randomUUID(),order:0,kind:'Text',data:{text:'Synthetic regional prompt'}}]}],parameters:{maxOutputTokens:128}});
test('native regional credentials require explicit account eligibility; model discovery cannot grant it',async()=>{
  for(const region of ['us','eu']){
    const f=regionalFixture(region),c=createProviderSettingsController(f.options);await c.initialize();await c.connect(f.id,new TextEncoder().encode('synthetic'));
    assert.equal(f.changes.at(-1).length,0);assert.equal(c.getSnapshot().connections[0].regionalEligibility.confirmed,false);
    await c.check(f.id);assert.equal(f.requests,1);assert.equal(f.changes.at(-1).length,0);
    await c.setRegionalEligibility(f.id,true);const connection=f.changes.at(-1)[0];
    assert.equal(connection.regionalProcessing.region,region);assert.equal(connection.models[0].capabilities.images,'unsupported');
    assert.equal(connection.adapter.prepare(regionalInput()).body.model,'gpt-4.1-mini-2025-04-14');
    assert.equal(f.requests,1);assert.equal(f.stages,0);
    assert.deepEqual(c.getSnapshot().connections[0].regionalEligibility,{confirmed:true,images:false});
    assert.equal(JSON.stringify(connection.regionalProcessing).includes('credentialId'),false);
    await c.dispose();
  }
});
test('image eligibility changes rotate regional adapters and invalidate retained prepare/count/stream references',async()=>{
  const f=regionalFixture(),c=createProviderSettingsController(f.options);await c.initialize();await c.connect(f.id,new TextEncoder().encode('synthetic'));await c.setRegionalEligibility(f.id,true);
  const old=f.changes.at(-1)[0].adapter;await c.setRegionalEligibility(f.id,true,true);
  const approved=f.changes.at(-1)[0];assert.equal(approved.models[0].capabilities.images,'supported');assert.notEqual(approved.adapter,old);
  for(const method of ['prepare','countTokens','stream'])assert.throws(()=>old[method](regionalInput()),/regional connection changed/);
  await c.setRegionalEligibility(f.id,false);assert.equal(f.changes.at(-1).length,0);
  for(const method of ['prepare','countTokens','stream'])assert.throws(()=>approved.adapter[method](regionalInput()),/regional connection changed/);
  assert.equal(f.requests,0);assert.equal(f.stages,0);await c.dispose();
});
test('reopen, credential replacement, disconnect and controller restart cannot reuse regional confirmation',async()=>{
  const f=regionalFixture(),c=createProviderSettingsController(f.options);await c.initialize();await c.connect(f.id,new TextEncoder().encode('synthetic'));await c.setRegionalEligibility(f.id,true,true);
  await c.reopen(f.id);assert.equal(f.changes.at(-1).length,0);await c.setRegionalEligibility(f.id,true);
  await c.connect(f.id,new TextEncoder().encode('replacement'));assert.equal(f.changes.at(-1).length,0);await c.setRegionalEligibility(f.id,true);await c.dispose();
  const second=createProviderSettingsController(f.options);await second.initialize();assert.equal(second.getSnapshot().connections[0].connected,true);assert.equal(f.changes.at(-1).length,0);
  await second.setRegionalEligibility(f.id,true);await second.disconnect(f.id);assert.equal(f.changes.at(-1).length,0);assert.equal(second.getSnapshot().connections[0].regionalEligibility.confirmed,false);await second.dispose();
});
test('missing or changed regional evidence refuses publication and invalidates previously confirmed adapters',async()=>{
  const f=regionalFixture(),c=createProviderSettingsController(f.options);await c.initialize();await c.connect(f.id,new TextEncoder().encode('synthetic'));await c.setRegionalEligibility(f.id,true);
  const old=f.changes.at(-1)[0].adapter;
  f.change(value=>({...value,regionalProcessing:{...value.regionalProcessing,configurationId:'changed'}}));await c.check(f.id);
  assert.equal(f.changes.at(-1).length,0);assert.equal(c.getSnapshot().connections[0].capability.available,false);assert.equal(c.getSnapshot().connections[0].regionalEligibility.confirmed,false);
  assert.throws(()=>old.prepare(regionalInput()),/eligibility/);await c.setRegionalEligibility(f.id,true);assert.match(c.getSnapshot().connections[0].error,/matching reviewed host route/);
  assert.equal(f.changes.at(-1).length,0);assert.equal(f.stages,0);await c.dispose();
});
test('regional dispatch rechecks eligibility after prepared body staging has begun',async()=>{
  const f=regionalFixture(),c=createProviderSettingsController(f.options);let release;const held=new Promise(resolve=>{release=resolve;});
  f.host.beginTransfer=async()=>{await held;return {transferId:'staged-regional',maxChunkBytes:65536};};f.host.writeChunk=async()=>({});f.host.finishTransfer=async()=>({});
  await c.initialize();await c.connect(f.id,new TextEncoder().encode('synthetic'));await c.setRegionalEligibility(f.id,true);
  const adapter=f.changes.at(-1)[0].adapter,stream=adapter.stream(regionalInput());
  const events=(async()=>{const out=[];for await(const event of stream.events)out.push(event);return out;})();
  await c.setRegionalEligibility(f.id,false);release();const result=await events;
  assert.equal(f.requests,0);assert.ok(result.some(event=>event.type==='error'||event.type==='terminal'&&event.status!=='complete'));
  await c.dispose();
});
test('regional evidence cannot authorize an unreviewed model or ambiguous host transport',async()=>{
  for(const mode of ['model','duplicate','missing-constraint']){
    const f=regionalFixture();
    if(mode==='model')f.options.connections[0].catalog={...f.options.connections[0].catalog,model:{...f.options.connections[0].catalog.model,id:'unreviewed-regional-model'}};
    else if(mode==='missing-constraint')delete f.options.connections[0].processingRegion;
    else {const caps=f.host.capabilities;f.host.capabilities=async()=>{const value=await caps();return {...value,providerTransports:[...value.providerTransports,...value.providerTransports]};};}
    const c=createProviderSettingsController(f.options);await c.initialize();await c.connect(f.id,new TextEncoder().encode('synthetic'));await c.setRegionalEligibility(f.id,true);
    assert.equal(f.changes.at(-1).length,0);assert.equal(c.getSnapshot().connections[0].capability.available,false);assert.equal(f.requests,0);assert.equal(f.stages,0);await c.dispose();
  }
});

test('admitted regional relay routes require account confirmation and preserve operator and remote privacy',async()=>{
  for(const region of ['us','eu']){
    const f=regionalFixture(region,true),c=createProviderSettingsController(f.options);await c.initialize();await c.connect(f.id,new TextEncoder().encode('synthetic'));
    assert.equal(f.changes.at(-1).length,0);assert.equal(c.getSnapshot().connections[0].capability.available,true);
    await c.setRegionalEligibility(f.id,true);
    const published=f.changes.at(-1)[0],view=c.getSnapshot().connections[0];
    assert.equal(published.id,`openai-${region}-relay`);assert.equal(published.privacy,'self_hosted_remote');assert.equal(published.regionalProcessing.relay.region,region);
    assert.equal(view.origin,'https://relay.example.test');assert.equal(view.relayIdentity,'Synthetic regional operator');assert.equal(view.relayAuthorizationRequired,true);
    assert.equal(published.adapter.prepare(regionalInput()).body.model,'gpt-4.1-mini-2025-04-14');assert.equal(f.requests,0);assert.equal(f.stages,0);
    const old=published.adapter;
    f.change(value=>({...value,regionalProcessing:openAIRelayRegionalEvidence(region,{...value.regionalProcessing.relay,configurationId:'b'.repeat(64)})}));
    await c.check(f.id);assert.equal(f.changes.at(-1).length,0);assert.equal(c.getSnapshot().connections[0].regionalEligibility.confirmed,false);
    assert.throws(()=>old.prepare(regionalInput()),/eligibility/);
    await c.setRegionalEligibility(f.id,true);assert.equal(f.changes.at(-1).length,1);assert.notEqual(f.changes.at(-1)[0].adapter,old);
    await c.dispose();
  }
});

test('regional eligibility is checked again across host preparation and the final caller guard await',async()=>{
  for(const mode of ['host-preparation','caller-guard']){
    const f=regionalFixture(),c=createProviderSettingsController(f.options);let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});let dispatched=0,checks=0;
    f.host.beginTransfer=async()=>({transferId:'staged-regional',maxChunkBytes:65536});f.host.writeChunk=async()=>({});f.host.finishTransfer=async()=>({});
    f.host.startProviderHttp=async(request,beforeDispatch)=>{if(mode==='host-preparation'){enter();await held;}await beforeDispatch?.();dispatched++;throw new Error('Unexpected dispatch');};
    await c.initialize();await c.connect(f.id,new TextEncoder().encode('synthetic'));await c.setRegionalEligibility(f.id,true);
    const stream=f.changes.at(-1)[0].adapter.stream(regionalInput(),async()=>{checks++;if(mode==='caller-guard'&&checks===2){enter();await held;}});
    const pending=(async()=>{const values=[];for await(const value of stream.events)values.push(value);return values;})();
    await entered;await c.setRegionalEligibility(f.id,false);release();const values=await pending;
    assert.equal(dispatched,0);assert.equal(checks,mode==='host-preparation'?1:2);assert.equal(values.at(-1).status,'failed');
    assert.equal(f.changes.at(-1).length,0);await c.dispose();
  }
});


test('regional native and relay adapters refuse PDF before prepare/count/stream staging regardless of image confirmation',async()=>{
  for(const region of ['us','eu'])for(const relay of [false,true])for(const images of [false,true]){
    const f=regionalFixture(region,relay),c=createProviderSettingsController(f.options);
    await c.initialize();await c.connect(f.id,new TextEncoder().encode('synthetic'));await c.setRegionalEligibility(f.id,true,images);
    const published=f.changes.at(-1)[0],adapter=published.adapter;
    assert.equal(published.models[0].capabilities.images,images?'supported':'unsupported');
    assert.equal(published.models[0].capabilities.files,'unsupported');
    assert.equal(published.models[0].capabilities.fileMediaTypes,undefined);
    assert.equal(published.models[0].capabilities.inputModalities.includes('file'),false);
    const value=regionalInput(),attachmentId=crypto.randomUUID(),messageId=value.messages[0].parts[0].messageId;
    value.messages[0].parts.push({id:crypto.randomUUID(),messageId,order:1,kind:'File',data:{attachmentId,description:'review.pdf'}});
    value.attachments={[attachmentId]:{filename:'review.pdf',mediaType:'application/pdf',bytes:new TextEncoder().encode('%PDF-1.7\n%%EOF')}};
    const refused=error=>error.issues?.some(issue=>issue.code==='files_unsupported');
    assert.equal(adapter.analyze(value).sendable,false);
    assert.throws(()=>adapter.prepare(value),refused);
    assert.throws(()=>adapter.stream(value),refused);
    await assert.rejects(adapter.countTokens(value),refused);
    assert.equal(f.requests,0);assert.equal(f.stages,0);
    assert.equal(initialProviderCatalogs()[0].model.capabilities.files,'supported','regional narrowing must not mutate the shared general catalog');
    assert.equal(adapter.describeModel('gpt-audio-1.5'),null,'general audio model must not enter a reviewed regional route');
    await c.dispose();
  }
});

test('general audio model is selectable and regional connections retain only their reviewed model IDs',async()=>{
  const f=fixture();const c=createProviderSettingsController(f.options);await c.initialize();await c.connect('openai',new TextEncoder().encode('synthetic'));
  const general=f.changes.at(-1)[0];const audio=general.models.find(model=>model.id==='gpt-audio-1.5');
  assert(audio);assert.deepEqual(audio.capabilities.inputModalities,['text','audio']);assert.deepEqual(audio.capabilities.outputModalities,['text']);
  assert.equal(audio.pricing,null,'mixed audio/text usage cannot use a text-only rate');
  await c.dispose();
});
test('reviewed model additions reject duplicate identities and unbounded model lists before setup',()=>{
  for(const mode of ['duplicate','limit']){
    const f=fixture();const primary=f.options.connections[0].catalog;
    const extra={model:structuredClone(primary.model),adapterCapabilities:structuredClone(primary.adapterCapabilities),limitations:[]};
    f.options.connections[0].catalog={...primary,additionalModels: mode==='duplicate'?[extra]:Array.from({length:16},(_,i)=>({...extra,model:{...extra.model,id:`extra-${i}`}}))};
    assert.throws(()=>createProviderSettingsController(f.options),/Reviewed models/);
  }
});
