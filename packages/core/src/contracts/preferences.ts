/** Device-local, archive-scoped preferences; excluded from canonical exports. */
export type SendKey = "mod-enter" | "enter";
export interface InteractionPreferences {
  showTimestamps: boolean;
  showModelBadges: boolean;
  composerLayout: "comfortable" | "compact";
  modelSwitcherStyle: "select" | "list";
}
export interface LocalPreferences extends InteractionPreferences {
  version: 2;
  revision: number;
  sendKey: SendKey;
}
export const DEFAULT_LOCAL_PREFERENCES: Readonly<LocalPreferences> = Object.freeze({
  version: 2, revision: 0, sendKey: "mod-enter",
  showTimestamps: false, showModelBadges: true, composerLayout: "comfortable", modelSwitcherStyle: "select",
});
export interface PreferenceOperations {
  readLocalPreferences: { args: null; result: LocalPreferences };
  setSendKey: { args: { expectedRevision: number; sendKey: SendKey }; result: LocalPreferences };
  setInteractionPreferences: { args: { expectedRevision: number; preferences: InteractionPreferences }; result: LocalPreferences };
}
const revision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const sendKey = (value: unknown): value is SendKey => value === "enter" || value === "mod-enter";
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
export function assertLocalPreferences(value: unknown): asserts value is LocalPreferences {
  if (!closed(value, ["version", "revision", "sendKey", ...interactionKeys]) ||
    value.version !== 2 || !revision(value.revision) || !sendKey(value.sendKey) || !interactionValues(value))
    throw new Error("Local preferences are invalid or from an unsupported version. Stored preferences have been preserved.");
}
/** Decode a stored closed v1 row without writing a migration. Public results are always v2. */
export function normalizeLocalPreferences(value: unknown): LocalPreferences {
  if (closed(value, ["version", "revision", "sendKey"]) && value.version === 1 && revision(value.revision) && sendKey(value.sendKey))
    return { ...DEFAULT_LOCAL_PREFERENCES, revision: value.revision, sendKey: value.sendKey };
  assertLocalPreferences(value);
  return { ...value };
}
export function assertPreferenceArgs(operation: keyof PreferenceOperations, value: unknown): void {
  if (operation === "readLocalPreferences") {
    if (value !== null) throw new Error("Reading local preferences takes null arguments");
    return;
  }
  const field = operation === "setSendKey" ? "sendKey" : "preferences";
  if (!closed(value, ["expectedRevision", field]) || !revision(value.expectedRevision) || value.expectedRevision >= Number.MAX_SAFE_INTEGER - 1)
    throw new Error("Invalid preference change or revision");
  if (operation === "setSendKey") {
    if (!sendKey(value.sendKey)) throw new Error("Invalid send key");
  } else if (operation === "setInteractionPreferences") assertInteractionPreferences(value.preferences);
  else throw new Error("Unsupported preference operation");
}
