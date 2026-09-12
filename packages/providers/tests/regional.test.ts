import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAIRegionalEvidence, openAIRelayRegionalEvidence, reviewedRegionalTransport } from '../src/regional.ts';
import type { ProviderTransport } from '@quixi/core/contracts';
const transport=(region:'us'|'eu'):ProviderTransport=>{
  const evidence=openAIRegionalEvidence(region);
  return {id:evidence.binding.transportId,kind:'native_direct',privacy:'direct_provider',endpointOrigin:evidence.upstreamOrigin,relayIdentity:null,capability:{available:true,permission:'not_required',reason:null},regionalProcessing:evidence};
};
test('reviewed native US/EU metadata is exact, independent and bound to one model and endpoint',()=>{
  for(const region of ['us','eu'] as const){
    const value=transport(region),expected=openAIRegionalEvidence(region);
    assert.deepEqual(reviewedRegionalTransport(region,expected.binding,value),expected);
    assert.deepEqual(expected.modelIds,['gpt-4.1-mini-2025-04-14']);
    assert.deepEqual(expected.endpoints,['/v1/chat/completions']);
    expected.modelIds.push('unreviewed');
    assert.equal(openAIRegionalEvidence(region).modelIds.length,1);
    assert.equal(reviewedRegionalTransport(region,openAIRegionalEvidence(region==='us'?'eu':'us').binding,value),null);
  }
});
test('privacy labels, regional-looking origins and client-side relay claims cannot replace reviewed evidence',()=>{
  const binding=openAIRegionalEvidence('us').binding;
  for(const change of [
    (t:ProviderTransport)=>{delete t.regionalProcessing;},
    (t:ProviderTransport)=>{t.kind='relay';t.relayIdentity='Declared US relay';},
    (t:ProviderTransport)=>{t.kind='browser_direct';},
    (t:ProviderTransport)=>{t.privacy='local';},
    (t:ProviderTransport)=>{t.endpointOrigin='https://us.example.com';},
    (t:ProviderTransport)=>{t.endpointOrigin='https://api.openai.com';},
    (t:ProviderTransport)=>{t.regionalProcessing!.configurationId+='-changed';},
    (t:ProviderTransport)=>{t.regionalProcessing!.binding.accountId='other';},
    (t:ProviderTransport)=>{t.regionalProcessing!.modelIds.push('other');},
    (t:ProviderTransport)=>{t.regionalProcessing!.endpoints.push('/v1/responses');},
    (t:ProviderTransport)=>{t.regionalProcessing!.inputModalities=['text'];},
    (t:ProviderTransport)=>{t.regionalProcessing!.sourceUrl='https://example.com/claim';},
    (t:ProviderTransport)=>{t.regionalProcessing!.reviewedAt++;},
  ]){const value=transport('us');change(value);assert.equal(reviewedRegionalTransport('us',binding,value),null);}
});

const relayDeclaration=(region:'us'|'eu')=>({configurationId:'a'.repeat(64),operator:'Synthetic regional operator',origin:'https://relay.example.test',region,destinationId:`openai_${region}`});
function relayTransport(region:'us'|'eu'):ProviderTransport{
 const evidence=openAIRelayRegionalEvidence(region,relayDeclaration(region));
 return {id:evidence.binding.transportId,kind:'relay',privacy:'self_hosted_remote',endpointOrigin:evidence.relay!.origin,relayIdentity:evidence.relay!.operator,capability:{available:true,permission:'not_required',reason:null},regionalProcessing:evidence};
}
test('host-admitted regional relay metadata retains exact upstream facts and both routing identities',()=>{
 for(const region of ['us','eu'] as const){
  const relay=relayDeclaration(region),expected=openAIRelayRegionalEvidence(region,relay),native=openAIRegionalEvidence(region);
  assert.equal(expected.configurationId,`${native.configurationId}-${relay.configurationId}`);
  assert.deepEqual(expected.binding,{providerId:'openai',accountId:'primary',destinationId:`quixi-openai-${region}-relay-v1`,transportId:`quixi-openai-${region}-relay-v1`});
  assert.deepEqual(expected.modelIds,native.modelIds);assert.deepEqual(expected.endpoints,native.endpoints);assert.deepEqual(expected.inputModalities,native.inputModalities);assert.equal(expected.upstreamOrigin,native.upstreamOrigin);
  for(const privacy of ['quixi_relay','self_hosted_remote','custom_remote'] as const){const value=relayTransport(region);value.privacy=privacy;assert.deepEqual(reviewedRegionalTransport(region,expected.binding,value),expected);}
  relay.operator='Changed';assert.equal(expected.relay!.operator,'Synthetic regional operator','evidence owns a separate descriptor copy');
 }
});
test('relay declarations refuse extra fields, weak digests, arbitrary origins and unsupported identifiers',()=>{
 for(const change of [
  {configurationId:'a'.repeat(63)},{configurationId:'A'.repeat(64)},{operator:''},{operator:' x'},{operator:'x'.repeat(257)},{operator:'line\nbreak'},
  {origin:'http://relay.example.test'},{origin:'https://relay.example.test/path'},{origin:'https://user@relay.example.test'},{origin:'https://relay.example.test/'},
  {origin:'http://127.0.0.2:8080'},{origin:'http://localhost.example:8080'},
  {region:'global'},{region:'eu'},{destinationId:''},{destinationId:'a'.repeat(81)},{destinationId:'openai.us'},{extra:true},
 ])assert.throws(()=>openAIRelayRegionalEvidence('us',{...relayDeclaration('us'),...change} as Parameters<typeof openAIRelayRegionalEvidence>[1]));
 for(const origin of ['http://127.0.0.1:8080','http://localhost:8080','http://[::1]:8080'])assert.doesNotThrow(()=>openAIRelayRegionalEvidence('us',{...relayDeclaration('us'),origin}));
});
test('regional relay transport refuses mismatched operator origin binding region and broadened provider facts',()=>{
 for(const change of [
  (t:ProviderTransport)=>{t.kind='native_direct';},(t:ProviderTransport)=>{t.privacy='local';},(t:ProviderTransport)=>{t.privacy='direct_provider';},
  (t:ProviderTransport)=>{t.endpointOrigin='https://other.example.test';},(t:ProviderTransport)=>{t.relayIdentity='Other operator';},
  (t:ProviderTransport)=>{t.regionalProcessing!.relay!.region='eu';},(t:ProviderTransport)=>{t.regionalProcessing!.relay!.configurationId='b'.repeat(64);},
  (t:ProviderTransport)=>{t.regionalProcessing!.binding.accountId='other';},(t:ProviderTransport)=>{t.regionalProcessing!.configurationId+='changed';},
  (t:ProviderTransport)=>{t.regionalProcessing!.upstreamOrigin='https://api.openai.com';},(t:ProviderTransport)=>{t.regionalProcessing!.modelIds.push('other');},
  (t:ProviderTransport)=>{t.regionalProcessing!.endpoints.push('/v1/responses');},(t:ProviderTransport)=>{t.regionalProcessing!.inputModalities=['text'];},
  (t:ProviderTransport)=>{Object.assign(t.regionalProcessing!.relay!,{claim:true});},(t:ProviderTransport)=>{Object.assign(t.regionalProcessing!,{claim:true});},
 ]){const value=relayTransport('us'),binding={...value.regionalProcessing!.binding};change(value);assert.equal(reviewedRegionalTransport('us',binding,value),null);}
 const native=transport('us'),relay=relayTransport('us');
 assert.equal(reviewedRegionalTransport('us',native.regionalProcessing!.binding,relay),null);
 assert.equal(reviewedRegionalTransport('us',relay.regionalProcessing!.binding,native),null);
});
