/** Device-local, archive-scoped preferences; excluded from canonical exports. */
export type SendKey = "mod-enter" | "enter";
/** Product §92: the six built-in themes; independent of interaction settings. */
export const THEME_NAMES = ["warm-reading", "cool-minimal", "compact-ops", "terminal", "bubbles", "focus"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];
export interface InteractionPreferences {
  showTimestamps: boolean;
  showModelBadges: boolean;
  composerLayout: "comfortable" | "compact";
  modelSwitcherStyle: "select" | "list";
}
export interface LocalPreferences extends InteractionPreferences {
  version: 4;
  revision: number;
  sendKey: SendKey;
  /** Product §94: when this device finished or skipped the first-run steps; null shows them. */
  onboardingCompletedAt: number | null;
  /** Product §92: the appearance theme for this archive on this device. */
  theme: ThemeName;
}
export const DEFAULT_LOCAL_PREFERENCES: Readonly<LocalPreferences> = Object.freeze({
  version: 4, revision: 0, sendKey: "mod-enter",
  showTimestamps: false, showModelBadges: true, composerLayout: "comfortable", modelSwitcherStyle: "select",
  onboardingCompletedAt: null,
  theme: "warm-reading",
});
export interface PreferenceOperations {
  readLocalPreferences: { args: null; result: LocalPreferences };
  setSendKey: { args: { expectedRevision: number; sendKey: SendKey }; result: LocalPreferences };
  setInteractionPreferences: { args: { expectedRevision: number; preferences: InteractionPreferences }; result: LocalPreferences };
  setOnboardingState: { args: { expectedRevision: number; onboardingCompletedAt: number | null }; result: LocalPreferences };
  setTheme: { args: { expectedRevision: number; theme: ThemeName }; result: LocalPreferences };
}
const revision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const sendKey = (value: unknown): value is SendKey => value === "enter" || value === "mod-enter";
const themeName = (value: unknown): value is ThemeName => typeof value === "string" && (THEME_NAMES as readonly string[]).includes(value);
const interactionKeys = ["showTimestamps", "showModelBadges", "composerLayout", "modelSwitcherStyle"];
const closed = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const interactionValues = (row: Record<string, unknown>): boolean =>
  typeof row.showTimestamps === "boolean" && typeof row.showModelBadges === "boolean" &&
  (row.composerLayout === "comfortable" || row.composerLayout === "compact") &&
  (row.modelSwitcherStyle === "select" || row.modelSwitcherStyle === "list");
export function assertInteractionPreferences(value: unknown): asserts value is InteractionPreferences {
  if (!closed(value, interactionKeys) || !interactionValues(value)) throw new Error("Invalid interaction preferences");
}
const completedAt = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
export function assertLocalPreferences(value: unknown): asserts value is LocalPreferences {
  if (!closed(value, ["version", "revision", "sendKey", ...interactionKeys, "onboardingCompletedAt", "theme"]) ||
    value.version !== 4 || !revision(value.revision) || !sendKey(value.sendKey) || !interactionValues(value) || !completedAt(value.onboardingCompletedAt) || !themeName(value.theme))
    throw new Error("Local preferences are invalid or from an unsupported version. Stored preferences have been preserved.");
}
/** Decode stored closed v1–v3 rows without writing a migration. Public results
 * are always v4; older rows show onboarding once (v1/v2) and use the default
 * theme (v1–v3), as a fresh device would. */
export function normalizeLocalPreferences(value: unknown): LocalPreferences {
  if (closed(value, ["version", "revision", "sendKey"]) && value.version === 1 && revision(value.revision) && sendKey(value.sendKey))
    return { ...DEFAULT_LOCAL_PREFERENCES, revision: value.revision, sendKey: value.sendKey };
  if (closed(value, ["version", "revision", "sendKey", ...interactionKeys]) && value.version === 2 && revision(value.revision) && sendKey(value.sendKey) && interactionValues(value))
    return { ...DEFAULT_LOCAL_PREFERENCES, ...(value as unknown as InteractionPreferences), revision: value.revision, sendKey: value.sendKey, version: 4, onboardingCompletedAt: null, theme: "warm-reading" };
  if (closed(value, ["version", "revision", "sendKey", ...interactionKeys, "onboardingCompletedAt"]) && value.version === 3 && revision(value.revision) && sendKey(value.sendKey) && interactionValues(value) && completedAt(value.onboardingCompletedAt))
    return { ...DEFAULT_LOCAL_PREFERENCES, ...(value as unknown as InteractionPreferences), revision: value.revision, sendKey: value.sendKey, version: 4, onboardingCompletedAt: value.onboardingCompletedAt, theme: "warm-reading" };
  assertLocalPreferences(value);
  return { ...value };
}
export function assertPreferenceArgs(operation: keyof PreferenceOperations, value: unknown): void {
  if (operation === "readLocalPreferences") {
    if (value !== null) throw new Error("Reading local preferences takes null arguments");
    return;
  }
  const field = operation === "setSendKey" ? "sendKey" : operation === "setOnboardingState" ? "onboardingCompletedAt" : operation === "setTheme" ? "theme" : "preferences";
  if (!closed(value, ["expectedRevision", field]) || !revision(value.expectedRevision) || value.expectedRevision >= Number.MAX_SAFE_INTEGER - 1)
    throw new Error("Invalid preference change or revision");
  if (operation === "setSendKey") {
    if (!sendKey(value.sendKey)) throw new Error("Invalid send key");
  } else if (operation === "setInteractionPreferences") assertInteractionPreferences(value.preferences);
  else if (operation === "setOnboardingState") {
    if (!completedAt(value.onboardingCompletedAt)) throw new Error("Invalid onboarding state");
  } else if (operation === "setTheme") {
    if (!themeName(value.theme)) throw new Error("Invalid theme");
  } else throw new Error("Unsupported preference operation");
}
