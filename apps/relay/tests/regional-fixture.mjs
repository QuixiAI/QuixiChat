/** Controlled TLS fixture; this proves protocol and hostname verification, never geography. */
import https from 'node:https';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../src/server.mjs';
import { regionalConfiguration } from '../src/config.mjs';
import { configuration, listen, origin, token } from './fixture.mjs';
const run = promisify(execFile);
export function regionalConfig(region = 'us', operator = 'Synthetic regional relay operator') {
  const value = configuration(`https://${region}.api.openai.com`);
  value.regionalProcessing = { operator, region };
  value.destinations = [{ id: 'fixture', origin: `https://${region}.api.openai.com`, processingRegion: region, credential: { header: 'Authorization', prefix: 'Bearer ', required: true }, routes: [{ path: '/v1/models', methods: ['GET'], headers: [] }, { path: '/v1/chat/completions', methods: ['POST'], headers: ['content-type'] }] }];
  return value;
}
export async function regionalRelayFixture({ region = 'us', operator, allowedOrigins = [origin], onUpstream, configure = value => value, certificateHost = `${region}.api.openai.com` } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'quixi-regional-relay-'));
  let upstream, front, relay;
  const received = [], logs = []; let resolutions = 0;
  try {
    await run('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj',`/CN=${certificateHost}`,'-addext',`subjectAltName=DNS:${certificateHost},IP:127.0.0.1`]);
    const tls = { key: await readFile(join(directory,'key.pem')), cert: await readFile(join(directory,'cert.pem')) };
    upstream = https.createServer(tls, async (req,res) => {
      const entry = { method:req.method,path:req.url,headers:req.headers,body:null }; received.push(entry);
      try {
        const chunks=[];for await(const chunk of req)chunks.push(chunk);entry.body=Buffer.concat(chunks);
        if(onUpstream){await onUpstream(req,res,entry);return;}
        res.setHeader('content-type','application/json');res.end(req.url==='/v1/models'?JSON.stringify({object:'list',data:[{id:'gpt-4.1-mini-2025-04-14',object:'model'}]}):entry.body);
      } catch {res.destroy();}
    });
    await listen(upstream);
    const config=configure({...regionalConfig(region,operator),allowedOrigins});
    const networkPolicy={
      validateOrigin(url){if(url.origin!==`https://${region}.api.openai.com`)throw new Error('Fixture origin differs from the fixed regional upstream');},
      async resolve(url){this.validateOrigin(url);resolutions++;return {address:'127.0.0.1',family:4};},
      connectPort(url){this.validateOrigin(url);return upstream.address().port;},
      tlsCA:tls.cert,
    };
    const declaration=regionalConfiguration(config,'fixture',networkPolicy);
    relay=createRelay(config,{networkPolicy,logger:entry=>logs.push(entry)});
    const relayOrigin=await listen(relay.server);
    front=https.createServer(tls,(req,res)=>relay.server.emit('request',req,res));
    const httpsRelayOrigin=(await listen(front)).replace('http:','https:');
    return {relay,relayOrigin,httpsRelayOrigin,frontServer:front,config,declaration,token,received,logs,resolutions:()=>resolutions,traffic:()=>received.map(entry=>({method:entry.method,path:entry.path,bodyBytes:entry.body?.length??0,bodySha256:entry.body?createHash('sha256').update(entry.body).digest('hex'):null,host:entry.headers.host,providerAuthorizationPresent:typeof entry.headers.authorization==='string',relayHeadersForwarded:Object.keys(entry.headers).some(name=>name.startsWith('x-quixi-'))})),
      async close(){await relay.close();for(const server of [front,upstream]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(directory,{recursive:true,force:true});},
    };
  }catch(error){if(relay)await relay.close();for(const server of [front,upstream])if(server){server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));}await rm(directory,{recursive:true,force:true});throw error;}
}
