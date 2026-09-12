/** A1 developer database only. Canonical history APIs follow in plans 02–03. */
export interface ProofRecord { id: string; text: string; updatedAt: number }
export interface StorageDiagnostics {
  backend: "sqlite-wasm-opfs-sahpool";
  sqliteVersion: string;
  vectorVersion: string;
  schemaVersion: number;
  integrity: string;
  recordCount: number;
  operationCount: number;
  ownerId: string;
  namespace: string;
  poolCapacity: number;
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
}
export interface ProofOperations {
  diagnostics: { args: undefined; result: StorageDiagnostics };
  put: { args: { id: string; text: string }; result: ProofRecord };
  list: { args: { afterId?: string; limit?: number }; result: ProofRecord[] };
  search: { args: { query: string; limit?: number }; result: ProofRecord[] };
  remove: { args: { id: string }; result: boolean };
  rollbackProbe: { args: undefined; result: { rolledBack: boolean } };
  migrationProbe: { args: undefined; result: { rolledBack: boolean } };
  vectorProbe: { args: undefined; result: { nearestId: number; distance: number } };
  fullProbe: { args: undefined; result: { rejected: boolean; integrity: string } };
  beginInterruptedWrite: { args: { id: string }; result: { pending: true } };
}
export type Operation = keyof ProofOperations;
export type StorageErrorCode = "UNSUPPORTED" | "INVALID_REQUEST" | "OVERLOADED" | "CLOSED" | "INITIALIZATION_FAILED" | "DATABASE_ERROR" | "UNKNOWN_OUTCOME";
export interface SerializedStorageError { code: StorageErrorCode; message: string }
export type StorageRequest = {
  [K in Operation]: { type: "request"; id: string; operation: K; args: ProofOperations[K]["args"] }
}[Operation];
export type StorageResponse =
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; error: SerializedStorageError };
export type WorkerInput = StorageRequest | { type: "init"; namespace: string } | { type: "close" } | { type: "cancel"; id: string };
export type WorkerOutput = StorageResponse | { type: "fatal"; error: SerializedStorageError } | { type: "changed" } | { type: "closed" };
export const MAX_PENDING = 64;
export const MAX_TEXT_LENGTH = 65_536;
/** Validate before structured cloning, and again at the worker boundary. */
export function validateRequest(request: StorageRequest): void {
  if (typeof request.id !== "string" || request.id.length > 128) throw new Error("Invalid request ID");
  const args = request.args;
  const object = (keys: string[]): Record<string, unknown> => {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !keys.includes(key))) throw new Error("Invalid request arguments");
    return args as Record<string, unknown>;
  };
  const text = (value: unknown, max: number, empty = false) => {
    if (typeof value !== "string" || (!empty && !value.length) || value.length > max) throw new Error("Invalid or oversized request text");
  };
  switch (request.operation) {
    case "put": { const a = object(["id", "text"]); text(a.id, 128); text(a.text, MAX_TEXT_LENGTH, true); break; }
    case "remove": case "beginInterruptedWrite": { text(object(["id"]).id, 128); break; }
    case "list": case "search": {
      const a = object(request.operation === "list" ? ["afterId", "limit"] : ["query", "limit"]);
      if (a.limit !== undefined && (!Number.isInteger(a.limit) || Number(a.limit) < 1 || Number(a.limit) > 100)) throw new Error("Invalid page limit");
      if (request.operation === "search") text(a.query, 1024, true);
      else if (a.afterId !== undefined) text(a.afterId, 128, true);
      break;
    }
    case "diagnostics": case "rollbackProbe": case "migrationProbe": case "vectorProbe": case "fullProbe":
      if (args !== undefined) throw new Error("This operation takes no arguments");
      break;
    default: throw new Error("Unknown storage operation");
  }
}
export function serializeError(error: unknown, code: StorageErrorCode = "DATABASE_ERROR"): SerializedStorageError {
  const detail = error instanceof Error ? error.message : String(error);
  const message = code === "DATABASE_ERROR" && /SQLITE_IOERR|disk I\/O error/i.test(detail)
    ? `Local archive storage could not complete an I/O operation. Check available disk/site storage and permissions, then close and reopen the archive before inspecting and retrying the change. ${detail}`
    : detail;
  return { code, message };
}
