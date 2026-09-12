import { useEffect, useSyncExternalStore } from 'react';
import type { ProviderSettingsController } from './controller.ts';
import { observedHealth } from './health.ts';
import { regionalLabel } from '@quixi/providers';
import { useFocusRecovery } from '../accessibility/useFocusRecovery.ts';
import './providers.css';
const privacyLabels:Record<string,string>={local:'Local',direct_provider:'Direct provider',quixi_relay:'Quixi relay',self_hosted_remote:'Self-hosted remote',custom_remote:'Custom remote'};
/** The composition root owns controller disposal; navigating away does not disconnect chat. */
export function ProviderSettingsPanel({controller}:{controller:ProviderSettingsController}) {
  const focus=useFocusRecovery();
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  useEffect(()=>{void controller.initialize();},[controller]);
  const busy=state.loading||state.connections.some(value=>value.busy);
  return <section ref={focus.rootRef} onFocusCapture={focus.onFocusCapture} className="quixi-providers" aria-label="Provider connections">
    <h2 ref={focus.anchorRef} tabIndex={-1} className="focus-anchor">Provider connections</h2>
    <p>{state.persistence==='native'?'Credentials are kept in this device’s OS keychain.':state.persistence==='session'?'Credentials stay in memory for this browser session. Reloading requires reconnecting.':'Checking credential storage…'}</p>
    <p>Connect an API account to chat. Consumer ChatGPT and Claude subscriptions are separate from these API connections.</p>
    {!state.credentialCapability.available&&<p role="status">{state.credentialCapability.reason}</p>}
    {state.error&&<><p role="alert">{state.error}</p><button disabled={busy} onClick={()=>void controller.initialize()}>Retry connection setup</button></>}
    {state.connections.map(connection=>{const health=observedHealth(controller.health(connection.id))??connection.health;return <article key={connection.id} className="quixi-provider-card">
      <h3>{connection.label}</h3>
      <p>{connection.origin?`${privacyLabels[connection.privacy??'']??'Transport'} · ${connection.origin}`:'No reviewed transport configured'}</p>
      {connection.relayIdentity&&<p>The relay operated by {connection.relayIdentity} receives request content and the provider credential needed to forward it.</p>}
      {connection.processingRegion&&<div className="quixi-regional-processing">
        <p>Processing region: {regionalLabel(connection.processingRegion)}. This connection uses {connection.relayAuthorizationRequired?'a regional relay and provider route':'a registered direct provider route'} for submitted content; it is not a guarantee about all account data or data at rest.</p>
        {connection.relayAuthorizationRequired&&<p>The relay’s processing region is declared by its operator. This site checks that declaration against its reviewed configuration before each request; it does not independently verify physical location.</p>}
        {connection.regionalProcessing&&<p>Route reviewed {new Date(connection.regionalProcessing.reviewedAt).toISOString().slice(0,10)} for {connection.catalog.model.name}. <a href={connection.regionalProcessing.sourceUrl} target="_blank" rel="noreferrer">Provider processing requirements</a>.</p>}
        <p>Confirm your API key’s eligibility with OpenAI, including the required regional retention controls. Eligible Global-project keys can also use this route. A successful connection check does not verify eligibility.</p>
        <label><input type="checkbox" checked={connection.regionalEligibility.confirmed} disabled={busy||!connection.connected||!connection.capability.available} onChange={event=>void controller.setRegionalEligibility(connection.id,event.target.checked)}/>I confirmed this credential is eligible for regional processing</label>
        <label><input type="checkbox" checked={connection.regionalEligibility.images} disabled={busy||!connection.regionalEligibility.confirmed} onChange={event=>void controller.setRegionalEligibility(connection.id,true,event.target.checked)}/>I confirmed regional image-processing eligibility</label>
        <p>Text and retained tool records become available after the first confirmation. Images require the separate confirmation, including enhanced retention approval where required. Confirmations last for this session and are cleared when the credential is reopened or replaced. Changing a confirmation prevents new requests; it does not retract content already sent.</p>
        <p role="status">{connection.regionalEligibility.confirmed?`Eligibility: user-confirmed for text${connection.regionalEligibility.images?' and images':''}.`:'Confirm eligibility to make this connection available in chat.'}</p>
      </div>}
      {!connection.capability.available&&<p role="status">{connection.capability.reason}</p>}
      <p>{connection.connected?'Credential connected':'No credential connected'} · {health?health.status.replaceAll('_',' '):'Connection not checked'}</p>
      {health?.reason&&<p>{health.reason}{health.evidence==='generation'?' (from the last chat response)':''}</p>}
      {connection.discovery&&<p className="quixi-provider-discovery">Provider lists {connection.discovery.total.toLocaleString()} {connection.discovery.total===1?'model':'models'}{connection.discovery.complete?'':' (listing incomplete)'} · {connection.discovery.reviewed.length} reviewed and selectable{connection.discovery.unreviewed.length?` · ${connection.discovery.unreviewed.length} unreviewed: ${connection.discovery.unreviewed.slice(0,24).join(', ')}${connection.discovery.unreviewed.length>24?', …':''}`:''}. Unreviewed models are not selectable until their capabilities and pricing are reviewed.</p>}
      {connection.error&&<p role="alert">{connection.error} Use “Reopen connection” to inspect the current saved credential before retrying a change.</p>}
      {connection.relayAuthorizationRequired&&<form onSubmit={event=>{event.preventDefault();const field=event.currentTarget.elements.namedItem('relayToken') as HTMLInputElement;const bytes=new TextEncoder().encode(field.value);field.value='';void controller.relay(connection.id,bytes);}}>
        <label>Relay authorization token<input name="relayToken" type="password" autoComplete="off" maxLength={16_384} required disabled={busy}/></label>
        <button disabled={busy} type="submit">Authorize relay</button>
        <button disabled={busy} type="button" onClick={()=>void controller.relay(connection.id,null)}>Clear relay authorization</button>
      </form>}
      <form onSubmit={event=>{event.preventDefault();const field=event.currentTarget.elements.namedItem('apiKey') as HTMLInputElement;const bytes=new TextEncoder().encode(field.value);field.value='';void controller.connect(connection.id,bytes);}}>
        <label>API key<input name="apiKey" type="password" autoComplete="off" maxLength={16_384} required disabled={busy||!state.credentialCapability.available}/></label>
        <button disabled={busy||!state.credentialCapability.available||!connection.origin} type="submit">{connection.connected?'Replace credential':'Connect credential'}</button>
      </form>
      <div className="quixi-provider-actions">
        <button disabled={busy||!connection.connected||!connection.capability.available} onClick={()=>void controller.check(connection.id)}>Check connection</button>
        <button disabled={busy||!connection.origin} onClick={()=>void controller.reopen(connection.id)}>Reopen connection</button>
        <button disabled={busy||!connection.connected} onClick={()=>void controller.disconnect(connection.id)}>Disconnect</button>
      </div>
      <p>Checking a connection requests the provider’s model list, following its pages. While the app is visible and online, it also checks connected accounts periodically without sending conversation content or generating an answer. Automatic checks pause after a rejected credential until you reconnect or check it here.</p>
      <details><summary>{connection.catalog.model.name} — capabilities and limits</summary>
        <p>Reviewed model: {connection.catalog.model.id}. Context: {connection.catalog.model.capabilities.contextWindow?.toLocaleString()??'unknown'} tokens. Maximum output: {connection.catalog.model.capabilities.maxOutputTokens?.toLocaleString()??'unknown'} tokens.</p>
        <p>Provider tool records can be retained, but tools are not invoked by this chat.</p>
        {connection.catalog.limitations.map((value,index)=><p key={value}>{connection.processingRegion&&index===0
          ? 'This regional connection supports text after account eligibility confirmation. PNG, JPEG, GIF and WebP images also require image eligibility confirmation and share a 2.5 MiB raw request limit. Encoded JSON is limited to 4 MiB. File inputs, including PDFs, are unavailable because the reviewed regional route covers only text and images.'
          : value}</p>)}
        <p>Source reviewed {new Date(connection.catalog.review.reviewedAt).toISOString().slice(0,10)}: <a href={connection.catalog.model.provenance.sourceUrl??undefined} target="_blank" rel="noreferrer">Provider model documentation</a>.</p>
      </details>
      {!connection.processingRegion&&connection.catalog.additionalModels?.map(entry=><details key={entry.model.id}>
        <summary>{entry.model.name} — capabilities and limits</summary>
        <p>Reviewed model: {entry.model.id}. Context: {entry.model.capabilities.contextWindow?.toLocaleString()??'unknown'} tokens. Maximum output: {entry.model.capabilities.maxOutputTokens?.toLocaleString()??'unknown'} tokens.</p>
        {entry.limitations.map(value=><p key={value}>{value}</p>)}
        <p>Source reviewed {new Date(entry.model.provenance.observedAt).toISOString().slice(0,10)}: <a href={entry.model.provenance.sourceUrl??undefined} target="_blank" rel="noreferrer">Provider model documentation</a>.</p>
      </details>)}
    </article>;})}
    <p>This setup supports one credential per registered connection, including regional variants when this host provides them. Additional accounts and custom endpoints are not yet configurable here.</p>
  </section>;
}
