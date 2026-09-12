import { HOST_BOUNDARIES, type HostCapabilities, type SecretHandle } from '@quixi/core/contracts';
import { adapterCatalog, createAnthropicAdapter, createOpenAICompatibleAdapter, LIMITS, reviewedRegionalTransport, type ProviderAdapter } from '@quixi/providers';
import { nextHealthRefreshAt, type HealthRefreshAttempt } from './health-refresh.ts';
import type { ConfiguredConnection, ConnectionView, ProviderSettingsOptions, ProviderSettingsSnapshot } from './types.ts';
const unavailable = (reason: string) => ({available:false,permission:'not_required' as const,reason});
const key = (binding: {providerId:string;accountId:string;destinationId:string;transportId:string}) => JSON.stringify([binding.providerId,binding.accountId,binding.destinationId,binding.transportId]);
/** This controller lives for the application session; mounting settings does not own credentials. */
export function createProviderSettingsController(options: ProviderSettingsOptions) {
  if (options.connections.length > 16 || new Set(options.connections.map(value=>value.id)).size !== options.connections.length) throw new Error('Provider connection configuration exceeds its bound or contains duplicate IDs.');
  for (const connection of options.connections) {
    const models = adapterCatalog(connection.catalog);
    if (models.length > 16 || new Set(models.map(model => model.id)).size !== models.length)
      throw new Error('Reviewed models exceed the connection bound or contain duplicate IDs.');
  }
  const connections = structuredClone(options.connections);
  const now = options.now ?? Date.now;
  let activity = { online: false, visible: false, busy: false };
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const attempts = new Map<string, HealthRefreshAttempt & { adapter: ProviderAdapter }>();
  let background: { abort: AbortController; task: Promise<void>; connectionId: string } | null = null;
  const secrets = new Map<string, SecretHandle>(), adapters = new Map<string, ProviderAdapter>(), listeners = new Set<()=>void>();
  const confirmations = new Map<string, { credentialId: string; configurationId: string; images: boolean }>();
  const requests = new Set<string>(); let disposed=false, initialized=false, active:Promise<void>|null=null;
  let state:ProviderSettingsSnapshot = {loading:true,persistence:null,credentialCapability:{...options.credentialCapability},error:null,connections:connections.map(connection=>({id:connection.id,label:connection.label,connected:false,busy:false,health:null,discovery:null,error:null,capability:unavailable('Checking this host…'),privacy:null,origin:null,relayIdentity:null,catalog:connection.catalog,relayAuthorizationRequired:connection.relayAuthorizationRequired,...(connection.processingRegion?{processingRegion:connection.processingRegion}:{}),regionalProcessing:null,regionalEligibility:{confirmed:false,images:false}}))};
  const patch=(change:Partial<ProviderSettingsSnapshot>)=>{if(disposed)return;state={...state,...change};for(const listener of listeners)listener();};
  const row=(id:string,change:Partial<ConnectionView>)=>patch({connections:state.connections.map(value=>value.id===id?{...value,...change}:value)});
  const id=()=>{const value=crypto.randomUUID();requests.add(value);return value;};
  const eligible=(connectionId:string)=>{
    const view=state.connections.find(value=>value.id===connectionId), confirmation=confirmations.get(connectionId);
    return !!view?.capability.available && !!view.regionalProcessing && confirmation?.credentialId===secrets.get(connectionId)?.id && confirmation?.configurationId===view.regionalProcessing.configurationId;
  };
  const clearEligibility=(connectionId:string)=>{confirmations.delete(connectionId);row(connectionId,{regionalEligibility:{confirmed:false,images:false}});};
  const publish=()=>{if(disposed)return;const values:ConfiguredConnection[]=[];for(const connection of connections){const view=state.connections.find(value=>value.id===connection.id)!;const adapter=adapters.get(connection.id);if(adapter&&view.capability.available&&(!connection.processingRegion||eligible(connection.id)))values.push({id:connection.id,label:connection.label,adapter,models:adapterCatalog(connection.catalog).flatMap(model=>{const available=adapter.describeModel(model.id);return available?[available]:[];}),privacy:view.privacy,...(view.regionalProcessing?{regionalProcessing:structuredClone(view.regionalProcessing)}:{})});}options.onChange(values);};
  // One adapter per connection: its account health is the single record of
  // what the provider last answered, whether from a connection check here or
  // from a generation in chat. Only model-list probes are tracked for
  // cancellation on dispose; chat owns its own generation requests.
  const makeAdapter=(connectionId:string)=>{
    const connection=connections.find(value=>value.id===connectionId)!,credential=secrets.get(connectionId);
    if(!credential){adapters.delete(connectionId);return;}
    let catalog=adapterCatalog(connection.catalog);
    if(connection.processingRegion){
      const regional=state.connections.find(value=>value.id===connectionId)?.regionalProcessing;
      // A general catalog addition never enrolls that model in a regional route.
      catalog=catalog.filter(model=>regional?.modelIds.includes(model.id));
      const modalities=new Set<string>(regional?.inputModalities??[]);
      for(const model of catalog){
        // General provider support cannot broaden a reviewed regional route.
        model.capabilities.inputModalities=model.capabilities.inputModalities.filter(value=>modalities.has(value));
        if(!modalities.has('image')||!confirmations.get(connectionId)?.images){model.capabilities.images='unsupported';model.capabilities.inputModalities=model.capabilities.inputModalities.filter(value=>value!=='image');}
        if(!modalities.has('file')){model.capabilities.files='unsupported';delete model.capabilities.fileMediaTypes;}
        if(!modalities.has('audio'))delete model.capabilities.audioMediaTypes;
      }
    }
    let adapter:ProviderAdapter;
    const assertCurrent=(content=true)=>{
      if(disposed||adapters.get(connectionId)!==adapter||secrets.get(connectionId)?.id!==credential.id)throw new Error(connection.processingRegion ? 'This regional connection changed. Review its current credential and eligibility in Providers.' : 'This connection changed. Review its current credential in Providers.');
      if(!connection.processingRegion)return;
      if(content&&!eligible(connectionId))throw new Error('Confirm this credential’s regional processing eligibility in Providers before sending content.');
    };
    const base=(connection.catalog.providerId==='anthropic'?createAnthropicAdapter:createOpenAICompatibleAdapter)({host:{...options.host,async startProviderHttp(request,beforeDispatch){
      // A user-requested operation takes priority over an automatic probe.
      if(request.path!=='/v1/models')await stopBackground();
      assertCurrent(request.path!=='/v1/models');
      if(request.path==='/v1/models')requests.add(request.requestId);
      return options.host.startProviderHttp(request,async()=>{assertCurrent(request.path!=='/v1/models');await beforeDispatch?.();assertCurrent(request.path!=='/v1/models');});
    }},binding:connection.binding,credential,catalog,accountLabel:connection.label,nextId:()=>crypto.randomUUID(),now});
    adapter=connection.processingRegion?{...base,prepare(input){assertCurrent();return base.prepare(input);},stream(input,beforeDispatch){assertCurrent();return base.stream(input,beforeDispatch);},countTokens(input,beforeDispatch){assertCurrent();return base.countTokens(input,beforeDispatch);}}:base;
    adapters.set(connectionId,adapter);return adapter;
  };
  const refreshCapabilities=async()=>{
    const caps:HostCapabilities=await options.host.capabilities();
    patch({persistence:caps.secretPersistence,connections:state.connections.map(view=>{
      const connection=connections.find(value=>value.id===view.id)!,matches=caps.providerTransports.filter(value=>value.id===connection.binding.transportId),transport=matches.length===1?matches[0]:undefined;
      const reviewed=connection.processingRegion?reviewedRegionalTransport(connection.processingRegion,connection.binding,transport):null;
      const regionalProcessing=reviewed&&connection.catalog.providerId==='openai'&&connection.catalog.review.profile==='openai-chat-completions-v1'&&reviewed.modelIds.includes(connection.catalog.model.id)?reviewed:null;
      const capability=!options.credentialCapability.available?options.credentialCapability:!transport?unavailable('No reviewed transport is configured for this connection.'):transport.regionalProcessing&&!connection.processingRegion?unavailable('A regional host route requires a matching regional connection configuration.'):connection.processingRegion&&!regionalProcessing?unavailable('The host has no matching reviewed regional route for this connection.'):transport.capability;
      const confirmation=confirmations.get(connection.id);
      const confirmed=!!capability.available&&!!regionalProcessing&&confirmation?.configurationId===regionalProcessing.configurationId&&confirmation?.credentialId===secrets.get(connection.id)?.id;
      if(!confirmed)confirmations.delete(connection.id);
      return {...view,capability,privacy:transport?.privacy??null,origin:transport?.endpointOrigin??null,relayIdentity:transport?.relayIdentity??null,regionalProcessing,regionalEligibility:{confirmed,images:confirmed&&confirmation?.images===true}};
    })});
  };
  function canRefresh(connectionId: string) {
    const connection = connections.find(value => value.id === connectionId)!;
    const view = state.connections.find(value => value.id === connectionId)!;
    return view.connected && view.capability.available && adapters.has(connectionId)
      && (!connection.processingRegion || eligible(connectionId));
  }
  function nextRefresh() {
    let next: { connectionId: string; due: number } | null = null;
    for (const connection of connections) {
      if (!canRefresh(connection.id)) continue;
      const adapter = adapters.get(connection.id)!;
      const attempt = attempts.get(connection.id);
      const due = nextHealthRefreshAt(adapter.accountHealth(), attempt?.adapter === adapter ? attempt : null);
      if (due !== null && (!next || due < next.due)) next = { connectionId: connection.id, due };
    }
    return next;
  }
  function scheduleRefresh() {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (disposed || !initialized || state.loading || active || background || !activity.online || !activity.visible || activity.busy) return;
    const next = nextRefresh();
    if (next) refreshTimer = setTimeout(() => { refreshTimer = null; void refreshOne(); }, Math.min(2_147_483_647, Math.max(1, next.due - now())));
  }
  async function stopBackground() {
    const current = background;
    if (!current) return;
    current.abort.abort();
    await current.task;
  }
  async function refreshOne() {
    if (disposed || active || background || !activity.online || !activity.visible || activity.busy) return;
    const next = nextRefresh();
    if (!next || next.due > now()) { scheduleRefresh(); return; }
    const adapter = adapters.get(next.connectionId)!;
    const previous = attempts.get(next.connectionId);
    const attempt = { adapter, startedAt: now(), failures: adapter.accountHealth().status !== 'healthy' && previous?.adapter === adapter ? previous.failures : 0 };
    attempts.set(next.connectionId, attempt);
    const abort = new AbortController();
    // Assign ownership before any asynchronous host work begins.
    const task = Promise.resolve().then(async () => {
      try {
        await refreshCapabilities();
        publish();
        if (abort.signal.aborted || disposed || adapters.get(next.connectionId) !== adapter || !canRefresh(next.connectionId)) return;
        await adapter.authenticate(abort.signal);
        if (abort.signal.aborted || disposed || adapters.get(next.connectionId) !== adapter) return;
        const health = adapter.accountHealth();
        attempt.failures = health.status === 'healthy' ? 0 : Math.min(5, attempt.failures + 1);
        row(next.connectionId, { health });
        publish();
      } catch {
        // Cancellation and unavailable host capabilities do not invent account health.
        // The attempted-at bound prevents an immediate retry loop.
        attempt.failures = Math.min(5, attempt.failures + 1);
      } finally {
        requests.clear();
        if (background?.task === task) background = null;
        scheduleRefresh();
      }
    });
    background = { abort, task, connectionId: next.connectionId };
    await task;
  }
  async function work(connectionId:string|null, action:()=>Promise<void>){
    if(disposed)throw new Error('Provider settings session is closed.');
    if(active)throw new Error('Wait for the current provider operation to finish.');
    await stopBackground();
    if(disposed)throw new Error('Provider settings session is closed.');
    if(active)throw new Error('Wait for the current provider operation to finish.');
    if(connectionId)row(connectionId,{busy:true,error:null});
    const task=(async()=>{try{await action();}catch(error){const message=error instanceof Error?error.message:(error as {message?:string})?.message??'Provider setup failed.';if(connectionId)row(connectionId,{error:message});else {initialized=false;patch({error:message});}}finally{requests.clear();if(!connectionId)patch({loading:false});if(connectionId)row(connectionId,{busy:false});}})();
    active=task;await task;if(active===task)active=null;scheduleRefresh();
  }
  const controller={
    getSnapshot:()=>state,
    /** The shared UI owns visibility/connectivity; background probes never own chat. */
    setActivity(value: { online: boolean; visible: boolean; busy: boolean }) {
      activity = { online: value.online === true, visible: value.visible === true, busy: value.busy === true };
      if (!activity.online || !activity.visible || activity.busy) background?.abort.abort();
      scheduleRefresh();
    },
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    async initialize(){if(initialized)return;initialized=true;await work(null,async()=>{await refreshCapabilities();for(const connection of connections){if(!options.credentialCapability.available)break;if(!state.connections.find(view=>view.id===connection.id)?.origin)continue;try{const handle=await options.host.openSecret(id(),connection.binding);if(handle){if(key(handle.binding)!==key(connection.binding))throw new Error('Host returned a credential for another connection.');secrets.set(connection.id,handle);makeAdapter(connection.id);row(connection.id,{connected:true});}}catch(error){row(connection.id,{error:(error as {message?:string})?.message??'Could not reopen this credential.'});}}patch({loading:false});publish();});},
    async reopen(connectionId:string){await work(connectionId,async()=>{const connection=connections.find(value=>value.id===connectionId);if(!connection)throw new Error('Unknown provider connection.');const handle=await options.host.openSecret(id(),connection.binding);clearEligibility(connectionId);adapters.delete(connectionId);publish();if(handle){if(key(handle.binding)!==key(connection.binding))throw new Error('Host returned a credential for another connection.');secrets.set(connectionId,handle);}else secrets.delete(connectionId);makeAdapter(connectionId);row(connectionId,{connected:!!handle,health:null,discovery:null});await refreshCapabilities();publish();});},
    async connect(connectionId:string,value:Uint8Array){
      try{await work(connectionId,async()=>{const connection=connections.find(value=>value.id===connectionId);if(!connection)throw new Error('Unknown provider connection.');if(!options.credentialCapability.available)throw new Error(options.credentialCapability.reason??'Credential storage is unavailable.');if(!(value instanceof Uint8Array)||!value.length||value.length>HOST_BOUNDARIES.maxSecretBytes)throw new Error('Enter a credential within the supported length.');
        // Reopen before replacement, including after a previous unknown outcome. Never resend an uncertain secret write.
        const previous=await options.host.openSecret(id(),connection.binding);
        if(disposed)throw new Error('Provider settings session is closed.');
        clearEligibility(connectionId);adapters.delete(connectionId);publish();
        const handle=await options.host.storeSecret(id(),connection.binding,value,previous);if(key(handle.binding)!==key(connection.binding))throw new Error('Host returned a credential for another connection.');secrets.set(connectionId,handle);makeAdapter(connectionId);row(connectionId,{connected:true,health:null,discovery:null});await refreshCapabilities();publish();});}finally{value.fill(0);}
    },
    async disconnect(connectionId:string){await work(connectionId,async()=>{const connection=connections.find(value=>value.id===connectionId);if(!connection)throw new Error('Unknown provider connection.');const handle=await options.host.openSecret(id(),connection.binding);clearEligibility(connectionId);adapters.delete(connectionId);publish();if(handle)await options.host.deleteSecret(id(),handle);secrets.delete(connectionId);adapters.delete(connectionId);row(connectionId,{connected:false,health:null,discovery:null});publish();});},
    /** Session-only account confirmation, bound to the exact opaque credential
     * and host configuration. Neither model discovery nor a keychain reopen confirms it. */
    async setRegionalEligibility(connectionId:string, confirmed:boolean, images=false){await work(connectionId,async()=>{
      const connection=connections.find(value=>value.id===connectionId);
      if(!connection?.processingRegion)throw new Error('This connection has no reviewed regional processing route.');
      if(typeof confirmed!=='boolean'||typeof images!=='boolean'||(!confirmed&&images))throw new Error('Invalid regional eligibility choice.');
      clearEligibility(connectionId);adapters.delete(connectionId);publish();
      await refreshCapabilities();
      const view=state.connections.find(value=>value.id===connectionId)!,credential=secrets.get(connectionId);
      if(confirmed){if(!credential||!view.capability.available||!view.regionalProcessing)throw new Error('Connect the regional credential and use a matching reviewed host route first.');
        confirmations.set(connectionId,{credentialId:credential.id,configurationId:view.regionalProcessing.configurationId,images});}
      row(connectionId,{regionalEligibility:{confirmed,images:confirmed&&images},health:null,discovery:null});makeAdapter(connectionId);publish();
    });},
    /** A connection check lists the provider's models, following Anthropic
     * cursors up to the page bound, and records health from that probe. Only
     * reviewed catalog models are selectable; the rest are shown by name. */
    async check(connectionId:string){await work(connectionId,async()=>{await refreshCapabilities();publish();const adapter=adapters.get(connectionId)??makeAdapter(connectionId);if(!adapter)throw new Error('Connect a credential first.');const connection=connections.find(value=>value.id===connectionId)!;
      const reviewed=new Set(adapterCatalog(connection.catalog).filter(model=>adapter.describeModel(model.id)!==null).map(model=>model.id)),found=new Map<string,string>();let cursor:string|null=null,pages=0,complete=false,discovery:ConnectionView['discovery']=null;
      try{do{const page=await adapter.listModels(cursor);pages++;for(const model of page.models){if(found.size>=LIMITS.models)break;found.set(model.id,model.name);}complete=page.complete;cursor=!page.complete&&page.nextCursor&&pages<LIMITS.modelPages?page.nextCursor:null;}while(cursor);
        discovery={total:found.size,reviewed:[...found.keys()].filter(id=>reviewed.has(id)),unreviewed:[...found.keys()].filter(id=>!reviewed.has(id)),complete,pages};}
      catch{/* Health records the typed probe outcome. */}
      row(connectionId,{health:adapter.accountHealth(),discovery});});},
    /** The connection adapter's live health, including what chat responses established. */
    health(connectionId:string){return adapters.get(connectionId)?.accountHealth()??null;},
    async relay(connectionId:string,value:Uint8Array|null){try{await work(connectionId,async()=>{const connection=connections.find(value=>value.id===connectionId);if(!connection?.relayAuthorizationRequired||!options.setRelayAuthorization)throw new Error('Relay authorization is not configured for this connection.');await options.setRelayAuthorization(connection.binding.destinationId,value);await refreshCapabilities();publish();});}finally{value?.fill(0);}},
    async dispose(){if(disposed)return;disposed=true;if(refreshTimer!==null)clearTimeout(refreshTimer);refreshTimer=null;background?.abort.abort();await Promise.allSettled([...requests].map(requestId=>options.host.cancel(requestId)));await active;await background?.task;requests.clear();attempts.clear();listeners.clear();adapters.clear();secrets.clear();confirmations.clear();},
  };
  return controller;
}
export type ProviderSettingsController=ReturnType<typeof createProviderSettingsController>;
