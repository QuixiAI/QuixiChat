export type BrowserEngineName = "chromium" | "webkit";
export function parseBrowserNames(value: string | undefined): BrowserEngineName[];
export function browserNames(): BrowserEngineName[];
export function browserEngines<T>(engines: Record<BrowserEngineName, T>): [BrowserEngineName, T][];
