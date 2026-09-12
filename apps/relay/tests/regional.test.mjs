import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseConfig, regionalConfiguration } from '../src/config.mjs';
import { createRelay } from '../src/server.mjs';
import { regionalConfig, regionalRelayFixture } from './regional-fixture.mjs';
import { configuration, headers, listen, origin, token } from './fixture.mjs';
const metadataHeaders = extra => ({origin,authorization:`Bearer ${token}`,'x-quixi-destination':'fixture',...extra});
const regionalHeaders = (f,path='/v1/chat/completions',extra={}) => headers(path,{'x-quixi-configuration':f.declaration.configurationId,...extra});

test('regional configuration identity is stable, normalized, bounded and contains no principal secrets',()=>{
 const config=regionalConfig(),first=regionalConfiguration(config,'fixture');
 assert.deepEqual(Object.keys(first).sort(),['configurationId','destinationId','operator','region','upstreamOrigin','version']);assert.match(first.configurationId,/^[a-f0-9]{64}$/);
 assert.equal(first.upstreamOrigin,'https://us.api.openai.com');assert(!JSON.stringify(first).includes(token));assert(!JSON.stringify(first).includes(config.principals[0].tokenSha256));
 const reordered={...config,destinations:[{...config.destinations[0],credential:{required:true,prefix:'Bearer ',header:'authorization'},routes:[...config.destinations[0].routes].reverse()}]};
 assert.deepEqual(regionalConfiguration(reordered,'fixture'),first);
 reordered.principals[0]={...reordered.principals[0],tokenSha256:'f'.repeat(64)};assert.equal(regionalConfiguration(reordered,'fixture').configurationId,first.configurationId);
 assert.notEqual(regionalConfiguration({...config,regionalProcessing:{...config.regionalProcessing,operator:'Another operator'}},'fixture').configurationId,first.configurationId);
 assert.notEqual(regionalConfiguration(regionalConfig('eu'),'fixture').configurationId,first.configurationId);
 const renamed=structuredClone(config);renamed.destinations[0].id='another';renamed.principals[0].destinations=['another'];assert.notEqual(regionalConfiguration(renamed,'another').configurationId,first.configurationId);
 assert.throws(()=>regionalConfiguration(configuration('https://example.com'),'fixture'),/declared regional/);
});

test('regional declarations refuse mismatched origins, routes, queries, credential schemes and unbounded operator claims',()=>{
 const changes=[
  c=>{delete c.regionalProcessing;},c=>{c.regionalProcessing.region='eu';},c=>{c.regionalProcessing.region='global';},c=>{c.regionalProcessing.extra=true;},c=>{c.regionalProcessing.operator='';},c=>{c.regionalProcessing.operator='x'.repeat(257);},c=>{c.regionalProcessing.operator=' padded ';},c=>{c.regionalProcessing.operator='operator\nlabel';},c=>{c.regionalProcessing.operator='operator\0label';},c=>{c.regionalProcessing.operator='operator\x7flabel';},
  c=>{c.destinations[0].processingRegion='global';},c=>{c.destinations[0].origin='https://eu.api.openai.com';},c=>{c.destinations[0].origin='https://us.api.openai.com:444';},c=>{c.destinations[0].origin='https://api.openai.com';},c=>{c.destinations[0].origin='https://us.example.com';},
  c=>{c.destinations[0].credential.header='x-api-key';},c=>{c.destinations[0].credential.prefix='Basic ';},c=>{c.destinations[0].credential.required=false;},
  c=>{c.destinations[0].routes.push({path:'/v1/responses',methods:['POST'],headers:['content-type']});},c=>{c.destinations[0].routes[0].methods=['POST'];},c=>{c.destinations[0].routes[0].headers=['content-type'];},c=>{c.destinations[0].routes[1].headers.push('openai-organization');},c=>{c.destinations[0].routes[1].query=['project'];},
  c=>{c.tlsCA='fixture';},c=>{c.connectPort=1234;},
 ];
 for(const change of changes){const config=regionalConfig();change(config);assert.throws(()=>parseConfig(config));}
 assert.doesNotThrow(()=>parseConfig(configuration('https://example.com')));
});

test('authenticated metadata returns exact declaration with zero DNS/upstream/provider content, and restricts preflight',async t=>{
 const f=await regionalRelayFixture();t.after(()=>f.close());
 const response=await fetch(`${f.relayOrigin}/v1/regional-configuration`,{method:'POST',cache:'no-store',headers:metadataHeaders({priority:'u=1, i'})});assert.equal(response.status,200);assert.deepEqual(await response.json(),f.declaration);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('access-control-allow-origin'),origin);
 const preflight=await fetch(`${f.relayOrigin}/v1/regional-configuration`,{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'authorization,x-quixi-destination'}});assert.equal(preflight.status,204);
 const denied=await fetch(`${f.relayOrigin}/v1/regional-configuration`,{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'x-quixi-provider-authorization'}});assert.equal(denied.status,403);
 const providerPreflight=await fetch(`${f.relayOrigin}/v1/provider-http`,{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'authorization,x-quixi-destination,x-quixi-configuration'}});assert.equal(providerPreflight.status,204);
 assert.equal(f.resolutions(),0);assert.equal(f.received.length,0);assert(f.logs.every(entry=>entry.bytesIn===0));
});

test('metadata refuses auth, destination, route headers, provider credentials and bodies before DNS',async t=>{
 const f=await regionalRelayFixture();t.after(()=>f.close());
 for(const [extra,body,status] of [[{authorization:'Bearer '+'a'.repeat(43)},undefined,401],[{origin:'https://unregistered.example'},undefined,403],[{'x-quixi-destination':'other'},undefined,403],[{'x-quixi-provider-authorization':'must-not-forward'},undefined,400],[{'x-quixi-path':'/v1/models'},undefined,400],[{'x-quixi-configuration':f.declaration.configurationId},undefined,400],[{'content-type':'application/json'},'{}',400],[{},'x'.repeat(10000),400]]){
  const response=await fetch(`${f.relayOrigin}/v1/regional-configuration`,{method:'POST',headers:metadataHeaders(extra),...(body===undefined?{}:{body})});assert.equal(response.status,status);await response.text();
 }
 assert.equal(f.resolutions(),0);assert.equal(f.received.length,0);
});

test('stale regional identity and unreviewed request fields refuse before body reads, DNS or upstream',async t=>{
 const f=await regionalRelayFixture();t.after(()=>f.close());
 for(const extra of [{'x-quixi-configuration':undefined},{'x-quixi-configuration':'f'.repeat(64)},{'x-quixi-configuration':regionalConfiguration(regionalConfig('eu'),'fixture').configurationId},{'x-quixi-query':'project=other'},{'x-quixi-path':'/v1/responses'},{'x-api-key':'unexpected'},{'openai-organization':'unexpected'}]){
  const value=regionalHeaders(f,'/v1/chat/completions',extra);for(const key of Object.keys(value))if(value[key]===undefined)delete value[key];
  const response=await fetch(`${f.relayOrigin}/v1/provider-http`,{method:'POST',headers:value,body:'must not reach upstream'});assert(response.status===400||response.status===403);await response.text();
 }
 const status=await new Promise((resolve,reject)=>{const request=http.request(`${f.relayOrigin}/v1/provider-http`,{method:'POST',headers:{...regionalHeaders(f), 'x-quixi-configuration':'f'.repeat(64),'content-length':'1000'}},response=>{response.resume();resolve(response.statusCode);request.destroy();});request.on('error',error=>{if(error.code!=='ECONNRESET')reject(error);});request.flushHeaders();});
 assert.equal(status,403);assert.equal(f.resolutions(),0);assert.equal(f.received.length,0);assert(f.logs.every(entry=>entry.bytesIn===0));
});

test('verified fixed-origin TLS forwards only reviewed routes with pinned identity and one provider credential',async t=>{
 for(const region of ['us','eu']){
  const f=await regionalRelayFixture({region});t.after(()=>f.close());
  const body='{"model":"gpt-4.1-mini-2025-04-14","messages":[{"role":"user","content":"synthetic only"}]}';
  const response=await fetch(`${f.relayOrigin}/v1/provider-http`,{method:'POST',cache:'no-store',headers:regionalHeaders(f,'/v1/chat/completions',{priority:'u=1, i'}),body});assert.equal(response.status,200);assert.equal(await response.text(),body);
  const modelsHeaders=regionalHeaders(f,'/v1/models',{'x-quixi-method':'GET'});delete modelsHeaders['content-type'];
  const models=await fetch(`${f.relayOrigin}/v1/provider-http`,{method:'POST',headers:modelsHeaders});assert.equal(models.status,200);assert.equal((await models.json()).data[0].id,'gpt-4.1-mini-2025-04-14');
  assert.equal(f.resolutions(),2);assert.equal(f.received.length,2);assert.equal(f.received[0].body.toString(),body);assert.equal(f.received[1].body.length,0);
  for(const request of f.received){assert.equal(request.headers.authorization,'Bearer synthetic-provider-secret');assert.equal(request.headers.host,`${region}.api.openai.com`);assert(!Object.keys(request.headers).some(name=>name.startsWith('x-quixi-')));for(const name of ['origin','cache-control','pragma','priority'])assert.equal(request.headers[name],undefined);}
 }
});

test('global destinations reject regional identity headers and do not advertise declarations',async t=>{
 const relay=createRelay(configuration('https://example.com'));t.after(()=>relay.close());const endpoint=await listen(relay.server);
 const metadata=await fetch(`${endpoint}/v1/regional-configuration`,{method:'POST',headers:metadataHeaders()});assert.equal(metadata.status,403);assert.equal((await metadata.json()).error.code,'REGIONAL_CONFIGURATION_UNAVAILABLE');
 const response=await fetch(`${endpoint}/v1/provider-http`,{method:'POST',headers:headers('/echo',{'x-quixi-configuration':'a'.repeat(64)}),body:'{}'});assert.equal(response.status,403);assert.equal((await response.json()).error.code,'REGIONAL_CONFIGURATION_MISMATCH');
});


test('regional upstream hostname verification cannot be bypassed by the controlled address and CA fixture',async t=>{
 const f=await regionalRelayFixture({certificateHost:'wrong.fixture.invalid'});t.after(()=>f.close());
 const response=await fetch(`${f.relayOrigin}/v1/provider-http`,{method:'POST',headers:regionalHeaders(f),body:'must not dispatch'});assert.equal(response.status,502);await response.text();assert.equal(f.received.length,0);assert.equal(f.resolutions(),1);
});

test('regional metadata uses principal authentication/rate and destination authorization without upstream access',async t=>{
 const limited=await regionalRelayFixture({configure:config=>({...config,principals:[{...config.principals[0],requestsPerMinute:1,burst:1}]})});t.after(()=>limited.close());
 const first=await fetch(`${limited.relayOrigin}/v1/regional-configuration`,{method:'POST',headers:metadataHeaders()});assert.equal(first.status,200);await first.text();
 const second=await fetch(`${limited.relayOrigin}/v1/regional-configuration`,{method:'POST',headers:metadataHeaders()});assert.equal(second.status,429);assert.equal((await second.json()).error.code,'PRINCIPAL_RATE_LIMIT');assert.equal(limited.resolutions(),0);
 const denied=await regionalRelayFixture({configure:config=>({...config,principals:[{...config.principals[0],destinations:[]}]})});t.after(()=>denied.close());
 const response=await fetch(`${denied.relayOrigin}/v1/regional-configuration`,{method:'POST',headers:metadataHeaders()});assert.equal(response.status,403);assert.equal((await response.json()).error.code,'DESTINATION_DENIED');assert.equal(denied.resolutions(),0);
});
