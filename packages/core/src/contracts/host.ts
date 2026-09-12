import type { JsonObject, QuixiId } from "../model/types.ts";
import type { ByteChunk, ChunkAcknowledgement } from "./transfer.ts";
import type { ExtensionOffer, ExtensionTransferProgress } from "./extension-import.ts";

export interface CapabilityState {
  available: boolean; permission: "not_required" | "prompt" | "granted" | "denied"; reason: string | null;
}
export type PrivacyClass = "local" | "direct_provider" | "quixi_relay" | "self_hosted_remote" | "custom_remote";
export interface ProviderTransport {
  id: string; kind: "browser_direct" | "native_direct" | "relay"; capability: CapabilityState;
  privacy: PrivacyClass;
  endpointOrigin: string; relayIdentity: string | null;
  /** Host-owned route declaration, independent of credential eligibility. */
  regionalProcessing?: RegionalProcessingEvidence;
}
export interface RegionalProcessingEvidence {
  version: 1;
  configurationId: string;
  binding: ProviderBinding;
  region: "us" | "eu";
  upstreamOrigin: string;
  modelIds: string[];
  endpoints: string[];
  inputModalities: ("text" | "image")[];
  sourceUrl: string;
  reviewedAt: number;
  /** Host-admitted operator and configuration for the relay hop, when present. */
  relay?: {
    configurationId: string;
    operator: string;
    origin: string;
    region: "us" | "eu";
    destinationId: string;
  };
}
export interface HostCapabilities {
  host: "web" | "desktop"; nativeFiles: CapabilityState; notifications: CapabilityState; oauth: CapabilityState;
  /** Writing text to the system clipboard; the interface shows copy controls only when available. */
  clipboard: CapabilityState;
  /** Receiving provider history bundles from the Quixi browser extension (product §24). */
  extensionTransfers: CapabilityState;
  secretPersistence: "session" | "native"; providerTransports: ProviderTransport[];
}
/** The host owns the page-boundary listener, pairing and staging; the shared
 * application only sees offers, progress and a verified staged HostFile. */
export interface ExtensionBridge {
  /** Shown in the interface for the user to type into the extension; rotates per session. */
  pairingCode(): string;
  onOffer(listener: (offer: ExtensionOffer) => void): () => void;
  onProgress(listener: (progress: ExtensionTransferProgress) => void): () => void;
  /** Resolves once every byte is received and verified against the bundle digest. */
  accept(requestId: QuixiId, offerId: QuixiId): Promise<HostFile>;
  reject(requestId: QuixiId, offerId: QuixiId, reason: string): Promise<void>;
  cancel(requestId: QuixiId, offerId: QuixiId): Promise<void>;
  /** Tell the extension how its bundle ended so it can advance its checkpoint. */
  report(requestId: QuixiId, offerId: QuixiId, outcome: { runId: QuixiId | null; outcome: "complete" | "failed" | "paused"; reason: string | null }): Promise<void>;
}
/** Host-registered destination fixes provider, account, credential origin and allowed routes. */
export interface ProviderBinding { providerId: string; accountId: string; destinationId: string; transportId: string }
export interface SecretHandle { id: string; persistence: "session" | "native"; binding: ProviderBinding }
export interface HostFile { id: QuixiId; name: string; mediaType: string | null; byteLength: number | null }
/** A file the interface received from the platform (a drag and drop) rather
 * than a host dialog. The host adopts it as an ordinary bounded HostFile; the
 * interface never streams platform file objects itself. */
export interface AdoptableFile { name: string; mediaType: string | null; byteLength: number; read(start: number, end: number): Promise<Uint8Array> }
export interface ProviderHttpRequest {
  requestId: QuixiId; binding: ProviderBinding; method: "GET" | "POST" | "PUT" | "DELETE";
  /** Relative route under the host-registered destination; adapter rejects escapes and disallowed redirects. */
  path: string;
  /** Query parameters the host encodes onto the registered path. Only names
   * the route registration permits are accepted; hosts reject the rest. */
  query?: Readonly<Record<string, string>>;
  headers: Record<string, string>; credential: SecretHandle | null; bodyTransferId: QuixiId | null;
  timeout: { connectMs: number; idleMs: number; totalMs: number };
}
export interface HostHttpResponse { requestId: QuixiId; status: number; headers: Record<string,string>; bodyTransferId: QuixiId | null }
export interface HostTransfer { transferId: QuixiId; maxChunkBytes: number; maxInFlight: number }
export interface HostCancellationResult {
  requestId: QuixiId; outcome: "not_dispatched" | "cancelled" | "already_completed" | "unknown_outcome";
  /** Cancelling after dispatch cannot promise prevention of external computation or billing. */
  externalEffect: "not_dispatched" | "may_have_occurred";
}
export interface OAuthRequest {
  requestId: QuixiId; providerId: string; configurationId: string;
  /** Host configuration owns exact endpoints/callback, one-use state and PKCE verifier. */
  scopes: string[];
}
/** Native registration currently requires a disconnected binding; callers must
 * explicitly disconnect before replacing a credential. Codes, state, verifiers
 * and token responses never cross this result boundary. */
export interface OAuthResult { requestId: QuixiId; binding: ProviderBinding; credential: SecretHandle }
export const HOST_BOUNDARIES = Object.freeze({ maxSecretBytes:16_384,maxSelectedFiles:256,maxTimeoutMs:3_600_000,maxQueryParameters:8,maxQueryValueLength:256,maxClipboardChars:262_144 });
const QUERY_NAME = /^[a-z][a-z0-9_]{0,31}$/;
/** Shared validation of a request's query against a route's permitted names;
 * returns the reason it is refused, or null. Hosts still enforce their own. */
export function providerQueryProblem(query: ProviderHttpRequest["query"], permitted: readonly string[]): string | null {
  if (query === undefined) return null;
  if (typeof query !== "object" || query === null || Array.isArray(query)) return "Query parameters must be an object.";
  const entries = Object.entries(query);
  if (entries.length > HOST_BOUNDARIES.maxQueryParameters) return "Too many query parameters.";
  for (const [name, value] of entries) {
    if (!QUERY_NAME.test(name) || !permitted.includes(name)) return `Query parameter ${name.slice(0, 40)} is not permitted by this route.`;
    if (typeof value !== "string" || value.length > HOST_BOUNDARIES.maxQueryValueLength || /[\x00-\x1f\x7f]/.test(value)) return `Query parameter ${name} has an invalid value.`;
  }
  return null;
}
/** Privileged capabilities are injected; no filesystem, HTTP, secret, or browser implementation lives in core. */
export interface HostClient {
  capabilities(): Promise<HostCapabilities>;
  /** The local callback rechecks authorization after asynchronous host preparation,
   * immediately before HTTP. It must never be serialized into native IPC or a request. */
  startProviderHttp(request: ProviderHttpRequest, beforeDispatch?: () => Promise<void>): Promise<HostHttpResponse>;
  beginTransfer(requestId: QuixiId, declaration: { purpose: "provider_request" | "file_save"; expectedBytes: number | null; expectedSha256: string | null }): Promise<HostTransfer>;
  finishTransfer(requestId: QuixiId, transferId: QuixiId, expected: { byteLength: number; sha256: string }): Promise<{ transferId: QuixiId; byteLength: number; sha256: string; state: "verified_staged" }>;
  /** Release acknowledged input/output staging or abandon an unfinished transfer; idempotent. */
  releaseTransfer(requestId: QuixiId, transferId: QuixiId): Promise<void>;
  readChunk(transferId: QuixiId): Promise<ByteChunk>;
  acknowledgeChunk(ack: ChunkAcknowledgement): Promise<void>;
  writeChunk(chunk: ByteChunk): Promise<ChunkAcknowledgement>;
  cancel(requestId: QuixiId): Promise<HostCancellationResult>;
  // Secret bytes cross only this privileged host boundary, never history/sync payloads.
  /** Reopen the current opaque credential for an exact registered binding; no plaintext or network probe. */
  openSecret(requestId: QuixiId, binding: ProviderBinding): Promise<SecretHandle | null>;
  storeSecret(requestId: QuixiId, binding: ProviderBinding, value: Uint8Array, replace: SecretHandle | null): Promise<SecretHandle>;
  deleteSecret(requestId: QuixiId, handle: SecretHandle): Promise<void>;
  startOAuth(request: OAuthRequest): Promise<OAuthResult>;
  chooseFiles(requestId: QuixiId, options: { multiple: boolean; mediaTypes: string[] }): Promise<HostFile[]>;
  /** Register dropped files under the same handle bounds as chosen files. */
  adoptFiles(requestId: QuixiId, files: readonly AdoptableFile[]): Promise<HostFile[]>;
  openFileTransfer(requestId: QuixiId, fileId: QuixiId): Promise<HostTransfer>;
  releaseFile(requestId: QuixiId, fileId: QuixiId): Promise<void>;
  saveFileTransfer(requestId: QuixiId, file: { name: string; mediaType: string; transferId: QuixiId }): Promise<void>;
  notify(requestId: QuixiId, notification: { title: string; body: string; action: JsonObject | null }): Promise<void>;
  /** Write bounded text to the system clipboard from a user action; unsupported hosts fail with UNSUPPORTED. */
  writeClipboardText(requestId: QuixiId, text: string): Promise<void>;
  /** Present only where `capabilities().extensionTransfers` can be available. */
  extensionBridge?: ExtensionBridge;
}
