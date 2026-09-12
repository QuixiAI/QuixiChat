import type { CapabilityState, OAuthRequest, OAuthResult, ProviderBinding, SecretHandle } from '@quixi/core/contracts';
import type { WebDestination } from './index.ts';
import { failure } from './transfers.ts';

/** Trusted composition registration for a direct, public-client browser flow. */
export interface WebOAuthConfiguration {
  id: string;
  binding: ProviderBinding;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri: string;
  issuer: string;
  clientId: string;
  allowedScopes: string[];
  timeoutMs: number;
  /** Synthetic or explicitly configured device-local endpoints only. */
  allowInsecureLoopback?: boolean;
}
interface Operation {
  controller: AbortController;
  dispatched: boolean;
  complete: boolean;
  timers: ReturnType<typeof setTimeout>[];
  binding?: ProviderBinding;
}
interface Hooks {
  ensure(requestId: string): void;
  begin(requestId: string): Operation;
  finish(requestId: string): void;
  connected(binding: ProviderBinding): boolean;
  publish(requestId: string, binding: ProviderBinding, token: Uint8Array): SecretHandle;
}
interface Pending {
  request: OAuthRequest;
  config: WebOAuthConfiguration;
  operation: Operation;
  state: string;
  verifier: string;
  deadline: number;
  exchanging: boolean;
  channel: BroadcastChannel;
  popup: Window;
  resolve(result: OAuthResult): void;
  reject(error: Error): void;
  abort(): void;
}
const key = (binding: ProviderBinding): string => JSON.stringify([binding.providerId, binding.accountId, binding.destinationId, binding.transportId]);
const control = /[\u0000-\u0020\u007f-\u009f]/;
const loopback = (url: URL): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !control.test(value);
const scope = (value: unknown): value is string => typeof value === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(value) && value !== 'offline_access';
const scopes = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 32 && value.every(scope) && new Set(value).size === value.length;
const encoder = new TextEncoder();
function endpoint(value: unknown, insecure: boolean): URL {
  if (!text(value, 2048) || /[\\]/.test(value)) throw new Error('Invalid OAuth endpoint registration.');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (insecure && url.protocol === 'http:' && loopback(url))))
    throw new Error('Invalid OAuth endpoint registration.');
  return url;
}
function contextAvailable(): boolean {
  return typeof window !== 'undefined' && window.top === window && window.isSecureContext === true && window.crossOriginIsolated === true && typeof BroadcastChannel === 'function' && typeof crypto?.subtle?.digest === 'function';
}
function random(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  try { return base64url(bytes); } finally { bytes.fill(0); }
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function callback(raw: unknown, config: WebOAuthConfiguration, state: string): { code: string } | { denied: true } | null {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\u0000-\u0020\u007f-\u009f#\\]/.test(raw)) return null;
  const split = raw.indexOf('?');
  if (split < 0 || raw.slice(0, split) !== config.redirectUri) return null;
  const fields = raw.slice(split + 1).split('&');
  if (fields.length < 3 || fields.length > 5) return null;
  const values = new Map<string, string>();
  for (const field of fields) {
    const at = field.indexOf('=');
    if (at < 1) return null;
    const name = field.slice(0, at);
    if (!['state', 'iss', 'code', 'error', 'error_description', 'error_uri'].includes(name) || values.has(name)) return null;
    let value: string;
    try { value = decodeURIComponent(field.slice(at + 1).replace(/\+/g, ' ')); } catch { return null; }
    if (!value || value.length > (name === 'code' ? 4096 : name === 'iss' ? 2048 : 1024) || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
    values.set(name, value);
  }
  if (values.get('state') !== state || values.get('iss') !== config.issuer) return null;
  if (values.has('code')) return values.size === 3 ? { code: values.get('code')! } : null;
  return values.has('error') ? { denied: true } : null;
}

// JSON.parse establishes syntax first; this bounded lexical pass rejects duplicate
// top-level names (including escaped aliases) before any token can be published.
function tokenObject(source: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(source);
  if (!plain(parsed)) throw new Error();
  const names = new Set<string>();
  let depth = 0; let expectingKey = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      const start = index++;
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index] === '"') break;
        else index++;
      }
      if (depth === 1 && expectingKey) {
        const name = JSON.parse(source.slice(start, index + 1)) as string;
        if (names.has(name) || !['access_token', 'token_type', 'expires_in', 'scope', 'refresh_token', 'id_token'].includes(name)) throw new Error();
        names.add(name); expectingKey = false;
      }
    } else if (character === '{' || character === '[') { depth++; if (depth === 1) expectingKey = true; }
    else if (character === '}' || character === ']') depth--;
    else if (character === ',' && depth === 1) expectingKey = true;
  }
  return parsed;
}

/** Pending state is owned by this original document and never persisted. */
export class WebOAuth {
  private readonly configurations = new Map<string, WebOAuthConfiguration>();
  private readonly pending = new Map<string, Pending>();
  constructor(configurations: WebOAuthConfiguration[], destinations: WebDestination[], private readonly hooks: Hooks) {
    if (!Array.isArray(configurations) || configurations.length > 32) throw new Error('Invalid OAuth registrations.');
    for (const config of structuredClone(configurations)) {
      if (!plain(config) || Object.keys(config).some(name => !['id', 'binding', 'authorizationEndpoint', 'tokenEndpoint', 'redirectUri', 'issuer', 'clientId', 'allowedScopes', 'timeoutMs', 'allowInsecureLoopback'].includes(name)) || !text(config.id, 128) || this.configurations.has(config.id) || !plain(config.binding) || Object.keys(config.binding).sort().join(',') !== 'accountId,destinationId,providerId,transportId' || !Object.values(config.binding).every(value => text(value, 256)) || !text(config.clientId, 512) || !scopes(config.allowedScopes) || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 300000 || (config.allowInsecureLoopback !== undefined && typeof config.allowInsecureLoopback !== 'boolean'))
        throw new Error('Invalid OAuth registration.');
      const insecure = config.allowInsecureLoopback === true;
      for (const value of [config.authorizationEndpoint, config.tokenEndpoint, config.issuer]) endpoint(value, insecure);
      const redirect = endpoint(config.redirectUri, insecure);
      if (typeof window === 'undefined' || redirect.href !== config.redirectUri || config.redirectUri !== new URL('/oauth/callback.html', window.location.origin).href)
        throw new Error('OAuth requires the registered same-origin callback page.');
      const destination = destinations.find(value => key(value.binding) === key(config.binding));
      if (!destination || destination.transport.kind !== 'browser_direct' || destination.credential.header.toLowerCase() !== 'authorization' || destination.credential.prefix !== 'Bearer ')
        throw new Error('OAuth requires a registered direct Bearer resource destination.');
      this.configurations.set(config.id, config);
    }
  }
  capability(): CapabilityState {
    return this.configurations.size > 0 && contextAvailable()
      ? { available: true, permission: 'prompt', reason: null }
      : { available: false, permission: 'not_required', reason: 'OAuth requires a registered public client and an isolated, secure top-level browser session.' };
  }
  invalidate(binding: ProviderBinding): void {
    for (const pending of this.pending.values()) if (key(pending.config.binding) === key(binding))
      pending.operation.controller.abort(failure('CANCELLED', 'OAuth connection changed.', pending.request.requestId));
  }
  private current(pending: Pending): void {
    this.hooks.ensure(pending.request.requestId);
    if (this.pending.get(pending.request.requestId) !== pending || pending.operation.controller.signal.aborted || performance.now() >= pending.deadline)
      throw failure('CANCELLED', 'OAuth request ended.', pending.request.requestId);
    if (this.hooks.connected(pending.config.binding)) throw failure('CONFLICT', 'Disconnect this binding before authorizing.', pending.request.requestId);
  }
  private settle(pending: Pending, result: OAuthResult | Error): void {
    if (this.pending.get(pending.request.requestId) !== pending) return;
    this.pending.delete(pending.request.requestId);
    pending.operation.controller.signal.removeEventListener('abort', pending.abort);
    pending.channel.close();
    try { pending.popup.close(); } catch { /* COOP may sever the popup reference. */ }
    pending.state = ''; pending.verifier = '';
    this.hooks.finish(pending.request.requestId);
    if (result instanceof Error) pending.reject(result); else pending.resolve(result);
  }
  /** Deliberately synchronous through popup creation, preserving the caller's user gesture. */
  start(request: OAuthRequest): Promise<OAuthResult> {
    try {
      if (!plain(request) || typeof request.requestId !== 'string' || typeof request.configurationId !== 'string')
        throw failure('INVALID_REQUEST', 'Invalid OAuth request.', crypto.randomUUID());
      this.hooks.ensure(request.requestId);
      const config = this.configurations.get(request.configurationId);
      if (!config || !this.capability().available) throw failure('UNSUPPORTED', 'This browser OAuth configuration is unavailable.', request.requestId);
      if (!plain(request) || Object.keys(request).sort().join(',') !== 'configurationId,providerId,requestId,scopes' || request.providerId !== config.binding.providerId || !scopes(request.scopes) || request.scopes.some(value => !config.allowedScopes.includes(value)))
        throw failure('INVALID_REQUEST', 'OAuth request does not match its registration.', request.requestId);
      request = structuredClone(request);
      if (this.hooks.connected(config.binding) || [...this.pending.values()].some(value => key(value.config.binding) === key(config.binding)))
        throw failure('CONFLICT', 'Disconnect or cancel this binding before authorizing.', request.requestId);
      const operation = this.hooks.begin(request.requestId);
      operation.binding = structuredClone(config.binding);
      let popup: Window | null = null;
      let channel: BroadcastChannel | null = null;
      try {
        const state = random();
        const verifier = random();
        channel = new BroadcastChannel(`quixi-oauth-v1:${state}`);
        popup = window.open('about:blank', '_blank', 'popup,width=600,height=760');
        if (!popup) throw failure('UNSUPPORTED', 'Allow the authorization popup and retry from a user action.', request.requestId);
        popup.opener = null;
        if (popup.opener !== null) throw failure('UNSUPPORTED', 'The authorization popup could not be isolated.', request.requestId);
        let pending!: Pending;
        const promise = new Promise<OAuthResult>((resolve, reject) => {
          pending = { request: structuredClone(request), config, operation, state, verifier, deadline: performance.now() + config.timeoutMs, exchanging: false, channel: channel!, popup: popup!, resolve, reject, abort: () => this.settle(pending, failure('CANCELLED', 'OAuth request cancelled or expired.', request.requestId)) };
        });
        this.pending.set(request.requestId, pending);
        operation.controller.signal.addEventListener('abort', pending.abort, { once: true });
        operation.timers.push(setTimeout(() => operation.controller.abort(), config.timeoutMs));
        channel.onmessage = event => {
          if (this.pending.get(request.requestId) !== pending) return;
          let active = true;
          try { this.current(pending); } catch { active = false; }
          const data: unknown = event.data;
          const parsed = active && event.origin === window.location.origin && plain(data) && Object.keys(data).sort().join(',') === 'type,url' && data.type === 'quixi-oauth-callback' && !pending.exchanging ? callback(data.url, config, pending.state) : null;
          pending.channel.postMessage({ type: 'quixi-oauth-result', status: parsed ? 'accepted' : 'rejected' });
          if (!parsed) return;
          pending.exchanging = true; // Consume before any asynchronous exchange.
          if ('denied' in parsed) this.settle(pending, failure('IO_ERROR', 'Authorization was declined by the provider.', request.requestId));
          else void this.exchange(pending, parsed.code);
        };
        void this.authorize(pending);
        return promise;
      } catch (error) {
        channel?.close(); try { popup?.close(); } catch { /* Best effort. */ }
        this.hooks.finish(request.requestId);
        if (error instanceof Error && 'code' in error) throw error;
        throw failure('IO_ERROR', 'The authorization window could not be opened.', request.requestId);
      }
    } catch (error) { return Promise.reject(error); }
  }
  private async authorize(pending: Pending): Promise<void> {
    const bytes = encoder.encode(pending.verifier);
    try {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      this.current(pending);
      const url = new URL(pending.config.authorizationEndpoint);
      url.search = new URLSearchParams({ response_type: 'code', client_id: pending.config.clientId, redirect_uri: pending.config.redirectUri, scope: pending.request.scopes.join(' '), state: pending.state, code_challenge: base64url(digest), code_challenge_method: 'S256' }).toString();
      digest.fill(0);
      if (url.href.length > 8192) throw failure('INVALID_REQUEST', 'OAuth authorization parameters exceed their limit.', pending.request.requestId);
      // A popup-owned link gives the navigation its own explicit referrer
      // policy; the opener's document/header defaults are not relied upon.
      const link = pending.popup.document.createElement('a');
      link.href = url.href;
      link.target = '_self';
      link.rel = 'noreferrer';
      link.referrerPolicy = 'no-referrer';
      pending.popup.document.body.append(link);
      pending.operation.dispatched = true;
      try { link.click(); } finally { link.remove(); }
    } catch { this.settle(pending, failure('IO_ERROR', 'The authorization window could not be opened.', pending.request.requestId)); }
    finally { bytes.fill(0); }
  }
  private async exchange(pending: Pending, code: string): Promise<void> {
    const bytes = new Uint8Array(32768);
    let tokenBytes: Uint8Array | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => { clearTimeout(timer); timer = setTimeout(() => pending.operation.controller.abort(), Math.min(10000, Math.max(1, pending.deadline - performance.now()))); };
    try {
      this.current(pending);
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: pending.config.redirectUri, client_id: pending.config.clientId, code_verifier: pending.verifier });
      arm();
      response = await fetch(pending.config.tokenEndpoint, { method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: pending.operation.controller.signal });
      this.current(pending);
      let count = 0; let headerBytes = 0;
      for (const [name, value] of response.headers) { count++; headerBytes += name.length + value.length; if (count > 32 || headerBytes > 8192) throw new Error(); }
      const declared = response.headers.get('content-length');
      if (!response.ok || !response.body || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > bytes.length))) throw new Error();
      reader = response.body.getReader();
      let length = 0;
      for (;;) {
        arm();
        const result = await reader.read();
        this.current(pending);
        if (result.done) break;
        if (result.value.byteLength > bytes.length - length) throw new Error();
        bytes.set(result.value, length); length += result.value.byteLength;
      }
      clearTimeout(timer);
      const token = tokenObject(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
      if (!plain(token) || typeof token.access_token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(token.access_token) || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer' || (token.expires_in !== undefined && (typeof token.expires_in !== 'number' || !Number.isSafeInteger(token.expires_in) || token.expires_in < 1)) || ['refresh_token', 'id_token'].some(name => token[name] !== undefined && typeof token[name] !== 'string')) throw new Error();
      if (token.scope !== undefined && (typeof token.scope !== 'string' || (token.scope !== '' && (!scopes(token.scope.split(' ')) || token.scope.split(' ').some(value => !pending.request.scopes.includes(value)))))) throw new Error();
      tokenBytes = encoder.encode(token.access_token);
      this.current(pending);
      // Publication and terminal completion share one synchronous turn with cancellation.
      const credential = this.hooks.publish(pending.request.requestId, pending.config.binding, tokenBytes);
      this.settle(pending, { requestId: pending.request.requestId, binding: structuredClone(pending.config.binding), credential });
    } catch {
      this.settle(pending, failure('IO_ERROR', 'OAuth token exchange failed.', pending.request.requestId));
      pending.operation.controller.abort();
    }
    finally {
      clearTimeout(timer); bytes.fill(0); tokenBytes?.fill(0);
      try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch { /* No provider error text escapes. */ }
    }
  }
}
