import type { SendKey } from "@quixi/core/contracts";
type Key = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat" | "isComposing" | "keyCode">;
export function isSendKey(event: Key, preference: SendKey, composing = false): boolean {
  if (event.key !== "Enter" || composing || event.isComposing || event.keyCode === 229 || event.repeat || event.shiftKey || event.altKey) return false;
  return preference === "enter" || event.metaKey || event.ctrlKey;
}
