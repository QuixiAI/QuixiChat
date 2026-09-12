import { useId, useLayoutEffect, useRef, useState } from "react";
import { assertRoutingAlias, ROUTING_ALIAS_LIMITS } from "@quixi/core/contracts";
import type { RoutingAlias, RoutingTarget } from "@quixi/core/contracts";
import type { AppServices } from "../../runtime/library.ts";
import type { AliasController, AliasSnapshot } from "./aliases-controller.ts";
import { useFocusRecovery } from "../accessibility/useFocusRecovery.ts";

type Providers = NonNullable<AppServices["providers"]>;
const key = (target: RoutingTarget) => JSON.stringify([target.provider, target.model]);
export function targetName(target: RoutingTarget, providers: Providers): string {
  const provider = providers.find(item => item.id === target.provider);
  const model = provider?.models.find(item => item.id === target.model);
  return provider && model ? `${provider.label} · ${model.name}` : `${target.provider} · ${target.model} (not configured)`;
}
function TargetSelect({ label, value, providers, onChange, disabled }: { label: string; value: RoutingTarget; providers: Providers; onChange: (value: RoutingTarget) => void; disabled: boolean }) {
  const selectId = useId();
  const options = providers.flatMap(provider => provider.models.map(model => ({ provider: provider.id, model: model.id })));
  return <div className="routing-alias-field"><label htmlFor={selectId}>{label}</label><select id={selectId} value={key(value)} disabled={disabled} onChange={event => {
    const next = options.find(option => key(option) === event.target.value); if (next) onChange(next);
  }}>
    {!options.some(option => key(option) === key(value)) && <option value={key(value)}>{value.provider ? targetName(value, providers) : "Choose a connection and model"}</option>}
    {options.map(option => <option key={key(option)} value={key(option)}>{targetName(option, providers)}</option>)}
  </select></div>;
}
export function AliasDetails({ alias, providers }: { alias: RoutingAlias; providers: Providers }) {
  return <div>
    <p>Primary: {targetName(alias.primary, providers)}</p>
    <ol aria-label="Alias fallback order">{alias.candidates.map(target => <li key={key(target)}>{targetName(target, providers)}</li>)}</ol>
    {!alias.candidates.length && <p>No fallback candidates.</p>}
    <p>Requirements: {[
      alias.requirements.tools && "tool support", alias.requirements.images && "image input",
      alias.requirements.contextAtLeast && `context at least ${alias.requirements.contextAtLeast.toLocaleString("en-US")} tokens`,
      alias.requirements.maxRequestCost !== undefined && `estimated input cost at most ${alias.requirements.maxRequestCost} USD (uses the full context window without a matching count)`,
      alias.requirements.maxEstimatedRequestCost !== undefined && `estimated request cost at most ${alias.requirements.maxEstimatedRequestCost} USD per attempt (counted input plus the selected output limit)`,
      alias.requirements.processingRegion !== undefined && `remote content processing in ${alias.requirements.processingRegion.toUpperCase()} for every attempt, fallback, and token count`,
    ].filter(Boolean).join("; ") || "none"}.</p>
    {alias.requirements.maxEstimatedRequestCost !== undefined && <p>Each fallback attempt has its own limit. This is an estimate, not a total billing limit across retries.</p>}
    <p>{alias.allowPrivacyChange ? "Fallback may change the privacy class." : "Fallback must keep the primary’s privacy class."}</p>
  </div>;
}
export function RoutingAliasesPanel({ controller, snapshot, providers }: { controller: AliasController; snapshot: AliasSnapshot; providers: Providers }) {
  const focus = useFocusRecovery();
  const regionId = useId();
  const nameRef = useRef<HTMLInputElement>(null), focusEditor = useRef(false);
  useLayoutEffect(() => {
    if (focusEditor.current) {
      focusEditor.current = false;
      nameRef.current?.focus();
    }
  });
  const [editor, setEditor] = useState<{ alias: RoutingAlias; revision: number } | null>(null);
  const [cost, setCost] = useState(""), [requestCost, setRequestCost] = useState(""), [context, setContext] = useState(""), [error, setError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<RoutingTarget>({ provider: "", model: "" });
  const [deleting, setDeleting] = useState<string | null>(null);
  const begin = (alias: RoutingAlias) => {
    focusEditor.current = true;
    setEditor({ alias: structuredClone(alias), revision: snapshot.value.revision });
    setContext(String(alias.requirements.contextAtLeast ?? "")); setCost(alias.requirements.maxRequestCost ?? ""); setError(null); setDeleting(null);
    setRequestCost(alias.requirements.maxEstimatedRequestCost ?? "");
  };
  const patch = (value: Partial<RoutingAlias>) => setEditor(current => current ? { ...current, alias: { ...current.alias, ...value } } : null);
  const disabled = !snapshot.ready || snapshot.busy;
  return <section aria-label="Routing aliases" ref={focus.rootRef} onFocusCapture={focus.onFocusCapture}>
    <h2 ref={focus.anchorRef} tabIndex={-1} className="focus-anchor">Routing aliases</h2>
    <p>Save named routes to reuse across conversations in this archive. Editing or deleting an alias does not change conversations where you already applied it.</p>
    {snapshot.error && <p role="alert">{snapshot.error}</p>}
    <button type="button" disabled={snapshot.busy} onClick={() => void controller.refresh()}>Reload aliases</button>
    <button type="button" disabled={disabled || snapshot.value.aliases.length >= ROUTING_ALIAS_LIMITS.aliases} onClick={() => begin({ id: crypto.randomUUID(), name: "", primary: { provider: "", model: "" }, candidates: [], requirements: {}, allowPrivacyChange: false })}>New routing alias</button>
    {!snapshot.ready && !snapshot.error && <p role="status">Loading routing aliases…</p>}
    {snapshot.value.aliases.map(alias => <article key={alias.id} aria-label={`Alias ${alias.name}`}>
      <h3>{alias.name}</h3><AliasDetails alias={alias} providers={providers} />
      <button type="button" disabled={disabled} onClick={() => begin(alias)}>Edit {alias.name}</button>
      <button type="button" disabled={disabled} onClick={() => setDeleting(alias.id)}>Delete {alias.name}</button>
      {deleting === alias.id && <div><p>Delete this saved alias? Applied conversation profiles will stay as they are.</p>
        <button type="button" disabled={disabled} onClick={() => void controller.remove(alias.id, snapshot.value.revision).then(ok => { if (ok) { setDeleting(null); if (editor?.alias.id === alias.id) setEditor(null); } })}>Confirm delete {alias.name}</button>
        <button type="button" onClick={() => setDeleting(null)}>Keep alias</button>
      </div>}
    </article>)}
    {editor && <form className="routing-alias-editor" aria-label="Routing alias editor" onSubmit={event => {
      event.preventDefault(); setError(null);
      const requirements = { ...editor.alias.requirements };
      delete requirements.contextAtLeast; delete requirements.maxRequestCost; delete requirements.maxEstimatedRequestCost;
      if (context.trim()) requirements.contextAtLeast = Number(context);
      if (cost.trim()) requirements.maxRequestCost = cost.trim();
      if (requestCost.trim()) requirements.maxEstimatedRequestCost = requestCost.trim();
      const alias = { ...editor.alias, name: editor.alias.name.trim(), requirements };
      try { assertRoutingAlias(alias); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return; }
      void controller.put(alias, editor.revision).then(ok => { if (ok) setEditor(null); });
    }}>
      <h3>{snapshot.value.aliases.some(alias => alias.id === editor.alias.id) ? "Edit routing alias" : "New routing alias"}</h3>
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={disabled}><legend>Alias profile</legend>
        <label>Alias name<input ref={nameRef} aria-label="Alias name" maxLength={64} value={editor.alias.name} onChange={event => patch({ name: event.target.value })} /></label>
        <TargetSelect label="Alias primary" value={editor.alias.primary} providers={providers} disabled={disabled} onChange={primary => patch({ primary })} />
        <TargetSelect label="Alias fallback candidate" value={candidate} providers={providers} disabled={disabled} onChange={setCandidate} />
        <button type="button" disabled={!candidate.provider || editor.alias.candidates.length >= ROUTING_ALIAS_LIMITS.candidates} onClick={() => {
          if ([editor.alias.primary, ...editor.alias.candidates].some(value => key(value) === key(candidate))) { setError("That target is already in this alias."); return; }
          patch({ candidates: [...editor.alias.candidates, { ...candidate }] }); setError(null);
        }}>Add alias fallback</button>
        <ol aria-label="Edit alias fallback order">{editor.alias.candidates.map((target, index) => <li key={key(target)}>
          {targetName(target, providers)}
          <button type="button" disabled={index === 0} onClick={() => { const next = [...editor.alias.candidates]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; patch({ candidates: next }); }}>Move fallback {index + 1} up</button>
          <button type="button" onClick={() => patch({ candidates: editor.alias.candidates.filter((_, item) => item !== index) })}>Remove fallback {index + 1}</button>
        </li>)}</ol>
        <label><input type="checkbox" checked={editor.alias.requirements.tools ?? false} onChange={event => patch({ requirements: { ...editor.alias.requirements, tools: event.target.checked } })} />Require alias tool support</label>
        <label><input type="checkbox" checked={editor.alias.requirements.images ?? false} onChange={event => patch({ requirements: { ...editor.alias.requirements, images: event.target.checked } })} />Require alias image input</label>
        <div className="routing-alias-field"><label htmlFor={regionId}>Alias required processing region</label><select id={regionId} value={editor.alias.requirements.processingRegion ?? ""} onChange={event => {
          const requirements = { ...editor.alias.requirements }; delete requirements.processingRegion;
          if (event.target.value === "us" || event.target.value === "eu") requirements.processingRegion = event.target.value;
          patch({ requirements });
        }}><option value="">No region requirement</option><option value="us">US</option><option value="eu">EU</option></select></div>
        <p>A required region applies to remote content processing, including fallback attempts and token counts. A matching verified native connection can qualify; an unverified browser relay cannot.</p>
        <label>Alias minimum context<input aria-label="Alias minimum context" type="number" min={1} step={1} value={context} onChange={event => setContext(event.target.value)} /></label>
        <label>Alias maximum estimated input cost (USD)<input aria-label="Alias maximum estimated input cost (USD)" maxLength={19} value={cost} onChange={event => setCost(event.target.value)} /></label>
        <label>Alias maximum estimated request cost per attempt (USD)<input aria-label="Alias maximum estimated request cost per attempt (USD)" maxLength={19} value={requestCost} onChange={event => setRequestCost(event.target.value)} /></label>
        <p>The request estimate includes counted input and the selected output limit. Every fallback is checked separately; this does not limit total charges across retries.</p>
        <label><input type="checkbox" checked={editor.alias.allowPrivacyChange} onChange={event => patch({ allowPrivacyChange: event.target.checked })} />Allow alias fallback to change the privacy class</label>
        <button>Save routing alias</button>
      </fieldset>
      <button type="button" onClick={() => setEditor(null)}>Cancel alias edit</button>
    </form>}
  </section>;
}

export function ApplyRoutingAlias({ snapshot, providers, disabled, apply }: { snapshot: AliasSnapshot; providers: Providers; disabled: boolean; apply: (alias: RoutingAlias, revision: number) => void }) {
  const focus = useFocusRecovery();
  const aliasSelectId = useId();
  const [selected, setSelected] = useState<{ alias: RoutingAlias; revision: number } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  return <section className="routing-alias-application" aria-label="Apply routing alias" ref={focus.rootRef} onFocusCapture={focus.onFocusCapture}>
    <h3 ref={focus.anchorRef} tabIndex={-1} className="focus-anchor">Apply routing alias</h3>
    <div className="routing-alias-field"><label htmlFor={aliasSelectId}>Routing alias</label><select id={aliasSelectId} value={selected?.alias.id ?? ""} disabled={disabled || !snapshot.ready} onChange={event => {
      const alias = snapshot.value.aliases.find(value => value.id === event.target.value);
      setSelected(alias ? { alias: structuredClone(alias), revision: snapshot.value.revision } : null); setReviewed(false);
    }}>
      <option value="">Choose a saved alias</option>
      {snapshot.value.aliases.map(alias => <option key={alias.id} value={alias.id}>{alias.name}</option>)}
    </select></div>
    {snapshot.error && <p role="status">Routing aliases are unavailable. Reload them in Preferences; your saved conversation route is unchanged.</p>}
    {selected && <div>
      <h3>Apply {selected.alias.name}</h3><AliasDetails alias={selected.alias} providers={providers} />
      <p>This saves the profile shown here to this conversation. Later alias edits will not change it. Applying does not send a message; any provider switch still needs its compatibility review.</p>
      <label><input type="checkbox" checked={reviewed} disabled={disabled} onChange={event => setReviewed(event.target.checked)} />I reviewed this alias profile</label>
      <button type="button" disabled={disabled || !reviewed} onClick={() => { apply(selected.alias, selected.revision); setReviewed(false); setSelected(null); }}>Apply alias to conversation</button>
      <button type="button" onClick={() => { setSelected(null); setReviewed(false); }}>Cancel alias application</button>
    </div>}
  </section>;
}
