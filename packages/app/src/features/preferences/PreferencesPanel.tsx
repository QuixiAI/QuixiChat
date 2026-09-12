import type { InteractionPreferences, SendKey } from "@quixi/core/contracts";
import type { PreferenceController, PreferenceSnapshot } from "./controller.ts";
import { useFocusRecovery } from '../accessibility/useFocusRecovery.ts';

export function PreferencesPanel({ controller, snapshot }: { controller: PreferenceController; snapshot: PreferenceSnapshot }) {
  const focus = useFocusRecovery();
  const disabled = !snapshot.ready || snapshot.busy;
  const update = (change: Partial<InteractionPreferences>) => void controller.setInteractionPreferences({
    showTimestamps: snapshot.value.showTimestamps,
    showModelBadges: snapshot.value.showModelBadges,
    composerLayout: snapshot.value.composerLayout,
    modelSwitcherStyle: snapshot.value.modelSwitcherStyle,
    ...change,
  });
  return <section aria-label="Preferences" ref={focus.rootRef} onFocusCapture={focus.onFocusCapture}>
    <h1 ref={focus.anchorRef} tabIndex={-1} className="focus-anchor">Preferences</h1>
    <p>These preferences apply to this archive on this device and browser profile. History exports do not include them.</p>
    <label htmlFor="send-key-preference">Send key</label>
      <select id="send-key-preference" value={snapshot.value.sendKey} disabled={disabled}
        onChange={event => void controller.setSendKey(event.target.value as SendKey)}>
        <option value="mod-enter">⌘ / Ctrl + Enter</option>
        <option value="enter">Enter (Shift + Enter for a new line)</option>
      </select>
    <label className="checkbox"><input type="checkbox" checked={snapshot.value.showTimestamps} disabled={disabled}
      onChange={event => update({ showTimestamps: event.target.checked })} /> Show message timestamps</label>
    <label className="checkbox"><input type="checkbox" checked={snapshot.value.showModelBadges} disabled={disabled}
      onChange={event => update({ showModelBadges: event.target.checked })} /> Show model badges</label>
    <label htmlFor="composer-layout-preference">Composer layout</label>
    <select id="composer-layout-preference" value={snapshot.value.composerLayout} disabled={disabled}
      onChange={event => update({ composerLayout: event.target.value as InteractionPreferences["composerLayout"] })}>
      <option value="comfortable">Comfortable</option>
      <option value="compact">Compact</option>
    </select>
    <label htmlFor="model-switcher-preference">Model switcher style</label>
    <select id="model-switcher-preference" value={snapshot.value.modelSwitcherStyle} disabled={disabled}
      onChange={event => update({ modelSwitcherStyle: event.target.value as InteractionPreferences["modelSwitcherStyle"] })}>
      <option value="select">Dropdown</option>
      <option value="list">Model list</option>
    </select>
    <p role="status">{snapshot.busy ? "Loading or saving preferences…" : snapshot.ready ? "Preferences are saved on this device." : "Preferences are unavailable."}</p>
    <button disabled={snapshot.busy} onClick={() => void controller.refresh()}>Reload preferences</button>
  </section>;
}
