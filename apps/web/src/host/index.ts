import { WebOAuth, type WebOAuthConfiguration } from "./oauth.ts";
export type { WebOAuthConfiguration } from "./oauth.ts";
import type { DiskStages, RetainedDownload } from "./disk-stages.ts";
import {
  HOST_BOUNDARIES,
  providerQueryProblem,
  type AdoptableFile,
  type CapabilityState,
  type HostClient,
  type HostHttpResponse,
  type ProviderBinding,
  type ProviderHttpRequest,
  type ProviderTransport,
  type SecretHandle,
} from "@quixi/core/contracts";
import { isQuixiId } from "@quixi/core/model";
import { failure, WEB_HOST_LIMITS, WebTransfers } from "./transfers.ts";
import { reviewedRegionalTransport } from '@quixi/providers';
import { verifyRegionalRelay } from './regional-relay.ts';

export interface WebDestination {
  binding: ProviderBinding;
  baseUrl: string;
  routes: {
    path: string;
    methods: ProviderHttpRequest["method"][];
    headers: string[];
    /** Query parameter names this route accepts; none by default. */
    query?: string[];
  }[];
  credential: { header: string; prefix: string };
  transport: Pick<ProviderTransport, "kind" | "privacy" | "relayIdentity" | "regionalProcessing">;
  /** For a relay, baseUrl is its origin, and this is a server-registered destination ID. */
  relayDestinationId?: string;
  /** Explicitly configured device-local endpoints may use loopback HTTP. */
  allowInsecureLoopback?: boolean;
}
export interface WebHostConfig {
  destinations: WebDestination[];
  oauthConfigurations?: WebOAuthConfiguration[];
  /** Composition-owned profile namespace for temporary exported files. */ fileStagingNamespace?: string;
}
type Secret = { handle: SecretHandle; bytes: Uint8Array };
type Operation = {
  controller: AbortController;
  dispatched: boolean;
  complete: boolean;
  timers: ReturnType<typeof setTimeout>[];
  binding?: ProviderBinding;
  secretId?: string;
};
type SaveWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
  }) => Promise<{
    createWritable(): Promise<{
      write(bytes: Uint8Array): Promise<void>;
      close(): Promise<void>;
      abort(): Promise<void>;
    }>;
  }>;
};
const available: CapabilityState = {
  available: true,
  permission: "not_required",
  reason: null,
};
const unavailable = (reason: string): CapabilityState => ({
  available: false,
  permission: "not_required",
  reason,
});
const bindingKey = (binding: ProviderBinding): string =>
  JSON.stringify([
    binding.providerId,
    binding.accountId,
    binding.destinationId,
    binding.transportId,
  ]);
const forbiddenHeader =
  /^(?:authorization|proxy-authorization|cookie|host|origin|referer|connection|content-length|transfer-encoding|sec-.+|x-quixi-.+)$/i;
const encoder = new TextEncoder();

/** A composition-root-owned browser session. Configuration is trusted, requests are not. */
export function createWebHost(config: WebHostConfig): HostClient & {
  dispose(): Promise<void>;
  setRelayAuthorization(
    destinationId: string,
    value: Uint8Array | null,
  ): Promise<void>;
  requestNotificationPermission(): Promise<NotificationPermission>;
  readonly limits: typeof WEB_HOST_LIMITS;
  fileSaveCapability(): ReturnType<DiskStages["capabilities"]>;
  listTemporaryDownloads(): Promise<RetainedDownload[]>;
  clearTemporaryDownload(requestId: string, id: string): Promise<void>;
} {
  const destinations = structuredClone(config.destinations);
  const registry = new Map<string, WebDestination>();
  if (destinations.length > 128) throw new Error('Too many registered provider destinations.');
  for (const destination of destinations) {
    const url = new URL(destination.baseUrl);
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    const regional = destination.transport.regionalProcessing;
    if (regional) {
      const reviewed = reviewedRegionalTransport(regional.region, destination.binding, {
        ...destination.transport, id: destination.binding.transportId, endpointOrigin: url.origin, capability: available,
      });
      const models = destination.routes.find(route => route.path === '/v1/models');
      const chat = destination.routes.find(route => route.path === '/v1/chat/completions');
      if (!reviewed?.relay || destination.relayDestinationId !== reviewed.relay.destinationId || destination.routes.length !== 2 ||
        JSON.stringify(models?.methods) !== '["GET"]' || JSON.stringify(models?.headers) !== '[]' || models?.query !== undefined ||
        JSON.stringify(chat?.methods) !== '["POST"]' || JSON.stringify(chat?.headers) !== '["content-type"]' || chat?.query !== undefined ||
        destination.credential.header !== 'Authorization' || destination.credential.prefix !== 'Bearer ')
        throw new Error('Regional relay registration does not match its reviewed binding and routes.');
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          loopback &&
          destination.allowInsecureLoopback
        ))
    )
      throw new Error(
        "Host destination requires an HTTPS origin or explicitly configured loopback HTTP origin.",
      );
    if (
      !["browser_direct", "relay"].includes(destination.transport.kind) ||
      !Object.values(destination.binding).every(
        (value) =>
          typeof value === "string" && value.length > 0 && value.length <= 256,
      ) ||
      registry.has(bindingKey(destination.binding))
    )
      throw new Error("Invalid or duplicate browser destination binding.");
    if (
      destination.transport.kind === "relay" &&
      (!destination.relayDestinationId ||
        !destination.transport.relayIdentity ||
        url.pathname !== "/")
    )
      throw new Error(
        "Relay configuration needs a server destination ID, operator identity and origin URL.",
      );
    if (
      ![
        "local",
        "direct_provider",
        "quixi_relay",
        "self_hosted_remote",
        "custom_remote",
      ].includes(destination.transport.privacy) ||
      (destination.transport.privacy === "local" &&
        (!loopback || destination.transport.kind !== "browser_direct")) ||
      (destination.transport.kind === "relay" &&
        ["local", "direct_provider"].includes(destination.transport.privacy)) ||
      (destination.transport.kind !== "relay" &&
        destination.transport.privacy === "quixi_relay")
    )
      throw new Error(
        "Transport privacy classification does not match its route.",
      );
    if (
      !/^[a-zA-Z0-9-]+$/.test(destination.credential.header) ||
      /[\r\n]/.test(destination.credential.prefix)
    )
      throw new Error("Invalid credential injection configuration.");
    for (const route of destination.routes)
      if (
        !route.path.startsWith("/") ||
        route.path.startsWith("//") ||
        /[\\?#]/.test(route.path) ||
        new URL(route.path, url).pathname !== route.path ||
        route.path.split("/").some((part) => part === "." || part === "..")
      )
        throw new Error(
          "Host routes must be exact normalized paths without query strings.",
        );
    for (const route of destination.routes)
      if (
        route.query !== undefined &&
        (!Array.isArray(route.query) ||
          route.query.length > HOST_BOUNDARIES.maxQueryParameters ||
          route.query.some((name) => !/^[a-z][a-z0-9_]{0,31}$/.test(name)))
      )
        throw new Error(
          "Host route query names must be short lower-case identifiers.",
        );
    for (const route of destination.routes)
      if (
        route.query !== undefined &&
        (!Array.isArray(route.query) ||
          route.query.length > HOST_BOUNDARIES.maxQueryParameters ||
          route.query.some((name) => !/^[a-z][a-z0-9_]{0,31}$/.test(name)))
      )
        throw new Error(
          "Host route query names must be short lower-case identifiers.",
        );
    registry.set(bindingKey(destination.binding), destination);
  }
  const transfers = new WebTransfers(config.fileStagingNamespace);
  const secrets = new Map<string, Secret>();
  const relaySecrets = new Map<string, Uint8Array>();
  const relayAuthorizationEpochs = new Map<string, number>();
  const regionalChecks = new Map<string, { controller: AbortController; promise: Promise<CapabilityState> }>();
  const regionalCapability = (destination: WebDestination): Promise<CapabilityState> => {
    if (closed || suspended) return Promise.resolve(unavailable('Browser host session is closed or suspended.'));
    const evidence = destination.transport.regionalProcessing, token = relaySecrets.get(destination.binding.destinationId);
    if (!evidence || !token) return Promise.resolve(unavailable('Enter a session relay authorization token before connecting.'));
    const key = destination.binding.destinationId, pending = regionalChecks.get(key);
    if (pending) return pending.promise;
    const controller = new AbortController();
    const promise = verifyRegionalRelay(evidence, token, controller.signal)
      .then(() => relaySecrets.get(key) === token && !controller.signal.aborted ? { ...available } : unavailable('Relay authorization changed. Verify this connection again.'))
      .catch(() => unavailable('Regional relay verification failed. Check the operator, processing region and configuration identity.'))
      .finally(() => { if (regionalChecks.get(key)?.controller === controller) regionalChecks.delete(key); });
    regionalChecks.set(key, { controller, promise });
    return promise;
  };
  const operations = new Map<string, Operation>();
  /** Chosen and adopted files share one bounded positional reader shape. */
  const files = new Map<string, AdoptableFile>();
  // The page clipboard is available only in secure contexts and, in most
  // browsers, only from a user gesture; the capability says so.
  const clipboardWriter = (): ((text: string) => Promise<void>) | null =>
    typeof navigator !== "undefined" &&
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
      ? (text) => navigator.clipboard.writeText(text)
      : null;
  const adopt = (file: AdoptableFile, requestId: string): AdoptableFile => {
    if (
      typeof file.name !== "string" ||
      !file.name ||
      file.name.length > 255 ||
      !(file.mediaType === null || (typeof file.mediaType === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(file.mediaType))) ||
      !Number.isSafeInteger(file.byteLength) ||
      file.byteLength < 0 ||
      typeof file.read !== "function"
    )
      throw failure("INVALID_REQUEST", "Adopted files need a bounded name, media type and size.", requestId);
    return { name: file.name, mediaType: file.mediaType, byteLength: file.byteLength, read: (start, end) => file.read(start, end) };
  };
  let closed = false;
  let suspended = false;
  let lifecycleEpoch = 0;
  let resumeRequested = false;
  let admissionCleanupFailed = false;
  let suspensionCleanup: Promise<void> | null = null;
  const transferAdmissions = new Set<Promise<unknown>>();
  const ensure = (requestId: string): void => {
    if (closed || suspended)
      throw failure("CLOSED", "Browser host session is closed or awaiting restoration cleanup.", requestId);
    if (!isQuixiId(requestId))
      throw failure(
        "INVALID_REQUEST",
        "A UUID request ID is required.",
        requestId,
      );
  };
  const destinationFor = (
    binding: ProviderBinding,
    requestId: string,
  ): WebDestination => {
    const destination = registry.get(bindingKey(binding));
    if (!destination)
      throw failure(
        "INVALID_REQUEST",
        "Provider/account/destination binding is not registered.",
        requestId,
      );
    return destination;
  };
  const finish = (requestId: string): void => {
    const operation = operations.get(requestId);
    if (!operation) return;
    operation.complete = true;
    operation.timers.forEach(clearTimeout);
    operation.timers = [];
    // Keep bounded completion tombstones for cancellation without retaining secrets or bodies.
    for (const [id, value] of operations)
      if (operations.size > 64 && value.complete) operations.delete(id);
  };
  const begin = (requestId: string): Operation => {
    ensure(requestId);
    if (operations.has(requestId))
      throw failure(
        "CONFLICT",
        "Request ID was already used in this host session.",
        requestId,
      );
    if (
      [...operations.values()].filter((value) => !value.complete).length >=
      WEB_HOST_LIMITS.requests
    )
      throw failure(
        "OVERLOADED",
        "Browser host request concurrency limit reached.",
        requestId,
      );
    const operation = {
      controller: new AbortController(),
      dispatched: false,
      complete: false,
      timers: [],
    };
    operations.set(requestId, operation);
    return operation;
  };
  const secretValue = (
    handle: SecretHandle,
    binding: ProviderBinding,
    requestId: string,
  ): string => {
    const secret = secrets.get(handle.id);
    if (
      !secret ||
      handle.persistence !== "session" ||
      bindingKey(secret.handle.binding) !== bindingKey(binding) ||
      bindingKey(handle.binding) !== bindingKey(binding)
    )
      throw failure(
        "INVALID_REQUEST",
        "Credential does not belong to this provider/account/destination.",
        requestId,
      );
    return new TextDecoder("utf-8", { fatal: true }).decode(secret.bytes);
  };
  const validateSecret = (value: Uint8Array, requestId: string): void => {
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength === 0 ||
      value.byteLength > HOST_BOUNDARIES.maxSecretBytes
    )
      throw failure(
        "INVALID_REQUEST",
        "Credential length is invalid.",
        requestId,
      );
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      throw failure(
        "INVALID_REQUEST",
        "HTTP credentials must be UTF-8 text.",
        requestId,
      );
    }
    if (/[^\x20-\x7e]/.test(text))
      throw failure(
        "INVALID_REQUEST",
        "HTTP credentials must contain printable ASCII without line breaks.",
        requestId,
      );
  };
  const connected = (binding: ProviderBinding): boolean => [...secrets.values()].some(secret => bindingKey(secret.handle.binding) === bindingKey(binding));
  const publish = (requestId: string, binding: ProviderBinding, bytes: Uint8Array): SecretHandle => {
    ensure(requestId);
    if (connected(binding)) throw failure('CONFLICT', 'Reopen the current credential before replacing it.', requestId);
    if (secrets.size >= 64) throw failure('OVERLOADED', 'Remove a session credential before adding another.', requestId);
    const handle: SecretHandle = { id: crypto.randomUUID(), persistence: 'session', binding: structuredClone(binding) };
    secrets.set(handle.id, { handle, bytes: bytes.slice() });
    return structuredClone(handle);
  };
  const oauth = new WebOAuth(config.oauthConfigurations ?? [], destinations, { ensure, begin, finish, connected, publish });
  const invalidateSession = (): void => {
    lifecycleEpoch++;
    for (const secret of secrets.values()) secret.bytes.fill(0);
    secrets.clear();
    for (const bytes of relaySecrets.values()) bytes.fill(0);
    relaySecrets.clear();
    for (const destination of destinations) {
      const id = destination.binding.destinationId;
      relayAuthorizationEpochs.set(id, (relayAuthorizationEpochs.get(id) ?? 0) + 1);
    }
    for (const check of regionalChecks.values()) check.controller.abort();
    regionalChecks.clear();
    for (const [id, operation] of operations) {
      operation.controller.abort();
      finish(id);
    }
    files.clear();
  };
  const cleanupSession = async (): Promise<void> => {
    // A disk-stage admission can be awaiting OPFS when pagehide fires. Its
    // epoch fence releases the late handle before cleanup can finish.
    await Promise.allSettled([...transferAdmissions]);
    await transfers.dispose();
    if (admissionCleanupFailed) throw failure('IO_ERROR', 'Browser session cleanup could not be completed.', crypto.randomUUID());
  };
  const pagehide = (event: Event): void => {
    if (!(event as PageTransitionEvent).persisted) { void host.dispose().catch(() => {}); return; }
    resumeRequested = false;
    if (closed || suspended) return;
    suspended = true;
    invalidateSession();
    const epoch = lifecycleEpoch;
    suspensionCleanup = cleanupSession();
    void suspensionCleanup.then(() => {
      if (!closed && resumeRequested && lifecycleEpoch === epoch) suspended = false;
    }).catch(() => { /* Failed cleanup leaves this host unavailable. */ });
  };
  const pageshow = (event: Event): void => {
    if (!(event as PageTransitionEvent).persisted || closed || !suspended || !suspensionCleanup) return;
    resumeRequested = true;
    const epoch = lifecycleEpoch;
    void suspensionCleanup.then(() => {
      if (!closed && resumeRequested && lifecycleEpoch === epoch) suspended = false;
    }).catch(() => { /* Reconnection requires a fresh document after cleanup failure. */ });
  };
  const host: HostClient & {
    dispose(): Promise<void>;
    setRelayAuthorization(
      destinationId: string,
      value: Uint8Array | null,
    ): Promise<void>;
    requestNotificationPermission(): Promise<NotificationPermission>;
    readonly limits: typeof WEB_HOST_LIMITS;
    fileSaveCapability(): ReturnType<DiskStages["capabilities"]>;
    listTemporaryDownloads(): Promise<RetainedDownload[]>;
    clearTemporaryDownload(requestId: string, id: string): Promise<void>;
  } = {
    limits: WEB_HOST_LIMITS,
    async fileSaveCapability() {
      return transfers.disk.capabilities();
    },
    async listTemporaryDownloads() {
      return transfers.disk.listRetained();
    },
    async clearTemporaryDownload(requestId, id) {
      ensure(requestId);
      await transfers.disk.clearRetained(id);
    },
    async capabilities() {
      const regionalStates = new Map<string, CapabilityState>();
      const regionalEpochs = new Map(destinations.map(destination => [destination.binding.destinationId, relayAuthorizationEpochs.get(destination.binding.destinationId) ?? 0]));
      // Coalesce concurrent capability reads; content dispatch always performs a fresh check.
      for (const destination of destinations) if (destination.transport.regionalProcessing)
        regionalStates.set(destination.binding.destinationId, await regionalCapability(destination));
      const notificationPermission =
        "Notification" in window ? Notification.permission : null;
      return {
        host: "web",
        secretPersistence: "session",
        nativeFiles: (window as SaveWindow).showSaveFilePicker
          ? { ...available, permission: "prompt" }
          : unavailable(
              "File-input import is available; this browser has no streaming save picker. Exports use disk-backed downloads when OPFS writable streams are available; confirm completion before clearing temporary downloads. The browser provides no download completion callback.",
            ),
        notifications:
          notificationPermission === null
            ? unavailable("This browser does not expose system notifications.")
            : {
                available: notificationPermission === "granted",
                permission:
                  notificationPermission === "default"
                    ? "prompt"
                    : notificationPermission,
                reason:
                  notificationPermission === "granted"
                    ? null
                    : "Enable notifications through an explicit permission action.",
              },
        clipboard: clipboardWriter()
          ? { ...available, permission: "prompt" }
          : unavailable(
              "This browser does not expose clipboard writing to the page.",
            ),
        oauth: closed || suspended ? unavailable('Host is closed or awaiting restoration cleanup.') : oauth.capability(),
        providerTransports: destinations.map((destination) => ({
          id: destination.binding.transportId,
          ...structuredClone(destination.transport),
          endpointOrigin: new URL(destination.baseUrl).origin,
          capability:
            (closed || suspended ? unavailable('Browser host session is closed or suspended.') : regionalStates.has(destination.binding.destinationId)
              ? (!closed && regionalEpochs.get(destination.binding.destinationId) === (relayAuthorizationEpochs.get(destination.binding.destinationId) ?? 0)
                ? regionalStates.get(destination.binding.destinationId)!
                : unavailable('Relay authorization changed. Verify this connection again.'))
              : undefined) ?? (destination.transport.kind === "relay" &&
            !relaySecrets.has(destination.binding.destinationId)
              ? unavailable(
                  "Enter a session relay authorization token before connecting.",
                )
              : { ...available }),
        })),
      };
    },
    async openSecret(requestId, binding) {
      ensure(requestId);
      destinationFor(binding, requestId);
      const matches = [...secrets.values()].filter(
        (secret) => bindingKey(secret.handle.binding) === bindingKey(binding),
      );
      if (matches.length > 1)
        throw failure(
          "CONFLICT",
          "Several session credentials exist for this binding; remove the older handles before reconnecting.",
          requestId,
        );
      return matches[0] ? structuredClone(matches[0].handle) : null;
    },
    async storeSecret(requestId, binding, value, replace) {
      ensure(requestId);
      destinationFor(binding, requestId);
      validateSecret(value, requestId);
      if (replace) secretValue(replace, binding, requestId);
      else if (connected(binding)) throw failure('CONFLICT', 'Reopen the current credential before replacing it.', requestId);
      if (!replace && secrets.size >= 64) throw failure('OVERLOADED', 'Remove a session credential before adding another.', requestId);
      oauth.invalidate(binding);
      // Compare, remove, wipe, and publish without yielding to a competing writer.
      if (replace) {
        const previous = secrets.get(replace.id)!;
        secrets.delete(replace.id);
        previous.bytes.fill(0);
      }
      const handle = publish(requestId, binding, value);
      if (replace) await Promise.all([...operations].filter(([, op]) => op.secretId === replace.id && !op.complete).map(([id]) => host.cancel(id)));
      return handle;
    },
    async deleteSecret(requestId, handle) {
      ensure(requestId);
      destinationFor(handle.binding, requestId);
      const secret = secrets.get(handle.id);
      if (secret) secretValue(handle, secret.handle.binding, requestId);
      oauth.invalidate(handle.binding);
      if (!secret) return;
      secrets.delete(handle.id);
      secret.bytes.fill(0);
      await Promise.all([...operations].filter(([, op]) => op.secretId === handle.id && !op.complete).map(([id]) => host.cancel(id)));
    },
    async setRelayAuthorization(destinationId, value) {
      const requestId = crypto.randomUUID();
      ensure(requestId);
      if (
        !destinations.some(
          (destination) =>
            destination.binding.destinationId === destinationId &&
            destination.transport.kind === "relay",
        )
      )
        throw failure(
          "INVALID_REQUEST",
          "Relay destination is not registered.",
          requestId,
        );
      if (value !== null) validateSecret(value, requestId);
      const replacement = value?.slice() ?? null;
      const epoch = (relayAuthorizationEpochs.get(destinationId) ?? 0) + 1;
      relayAuthorizationEpochs.set(destinationId, epoch);
      regionalChecks.get(destinationId)?.controller.abort();
      regionalChecks.delete(destinationId);
      relaySecrets.get(destinationId)?.fill(0);
      relaySecrets.delete(destinationId);
      try { await Promise.all(
        [...operations]
          .filter(
            ([, op]) =>
              op.binding?.destinationId === destinationId && !op.complete,
          )
          .map(([id]) => host.cancel(id)),
      );
      if (replacement !== null && relayAuthorizationEpochs.get(destinationId) === epoch) {
        ensure(requestId);
        relaySecrets.set(destinationId, replacement.slice());
      }
      } finally { replacement?.fill(0); }
    },
    async startProviderHttp(request, beforeDispatch): Promise<HostHttpResponse> {
      ensure(request.requestId);
      const destination = destinationFor(request.binding, request.requestId);
      const route = destination.routes.find(
        (route) =>
          route.path === request.path && route.methods.includes(request.method),
      );
      if (!route)
        throw failure(
          "INVALID_REQUEST",
          "Provider route or method is not registered.",
          request.requestId,
        );
      const queryProblem = providerQueryProblem(request.query, route.query ?? []);
      if (queryProblem)
        throw failure("INVALID_REQUEST", queryProblem, request.requestId);
      const query = new URLSearchParams(request.query ?? {}).toString();
      if (
        Object.keys(request.headers).length > 64 ||
        encoder.encode(JSON.stringify(request.headers)).byteLength > 16_384
      )
        throw failure(
          "INVALID_REQUEST",
          "Provider headers exceed the metadata limit.",
          request.requestId,
        );
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          forbiddenHeader.test(name) ||
          name.toLowerCase() === destination.credential.header.toLowerCase() ||
          !route.headers.some(
            (allowed) => allowed.toLowerCase() === name.toLowerCase(),
          ) ||
          /[\r\n]/.test(value)
        )
          throw failure(
            "INVALID_REQUEST",
            "A request header is not permitted by this destination.",
            request.requestId,
          );
        headers.set(name, value);
      }
      for (const value of [
        request.timeout.connectMs,
        request.timeout.idleMs,
        request.timeout.totalMs,
      ])
        if (
          !Number.isSafeInteger(value) ||
          value < 1 ||
          value > HOST_BOUNDARIES.maxTimeoutMs
        )
          throw failure(
            "INVALID_REQUEST",
            "Timeouts must be positive and bounded.",
            request.requestId,
          );
      let url = new URL(request.path, destination.baseUrl);
      let method: string = request.method;
      if (url.origin !== new URL(destination.baseUrl).origin)
        throw failure(
          "INVALID_REQUEST",
          "Provider path escapes its destination.",
          request.requestId,
        );
      if (query) url.search = query;
      if (query) url.search = query;
      if (destination.transport.kind === "relay") {
        const relaySecret = relaySecrets.get(destination.binding.destinationId);
        if (!relaySecret)
          throw failure(
            "UNSUPPORTED",
            "This relay requires a session authorization token.",
            request.requestId,
          );
        headers.set(
          "Authorization",
          `Bearer ${new TextDecoder().decode(relaySecret)}`,
        );
        headers.set("X-Quixi-Destination", destination.relayDestinationId!);
        headers.set("X-Quixi-Method", request.method);
        headers.set("X-Quixi-Path", request.path);
        if (destination.transport.regionalProcessing?.relay)
          headers.set('X-Quixi-Configuration', destination.transport.regionalProcessing.relay.configurationId);
        if (query) headers.set("X-Quixi-Query", query);
        if (request.credential)
          headers.set(
            "X-Quixi-Provider-Authorization",
            secretValue(request.credential, request.binding, request.requestId),
          );
        url = new URL("/v1/provider-http", destination.baseUrl);
        method = "POST";
      } else if (request.credential)
        headers.set(
          destination.credential.header,
          destination.credential.prefix +
            secretValue(request.credential, request.binding, request.requestId),
        );
      if (request.method === "GET" && request.bodyTransferId)
        throw failure(
          "INVALID_REQUEST",
          "GET requests cannot carry staged bodies.",
          request.requestId,
        );
      const operation = begin(request.requestId);
      operation.binding = structuredClone(request.binding);
      if (request.credential) operation.secretId = request.credential.id;
      const abort = (): void => {
        operation.controller.abort(
          failure(
            "IO_ERROR",
            "Provider request deadline elapsed.",
            request.requestId,
          ),
        );
        void transfers.cancel(request.requestId);
        finish(request.requestId);
      };
      operation.timers.push(setTimeout(abort, request.timeout.totalMs));
      const headerTimer = setTimeout(abort, request.timeout.connectMs);
      operation.timers.push(headerTimer);
      try {
        const dispatch = async (bytes?: Uint8Array): Promise<Response> => {
          const regional = destination.transport.regionalProcessing;
          if (regional) {
            const token = relaySecrets.get(destination.binding.destinationId);
            if (!token) throw failure('UNSUPPORTED', 'Relay authorization is unavailable.', request.requestId);
            await verifyRegionalRelay(regional, token, operation.controller.signal);
            if (relaySecrets.get(destination.binding.destinationId) !== token)
              throw failure('CANCELLED', 'Relay authorization changed before dispatch.', request.requestId);
          }
          // The workflow's policy can change while relay verification awaits I/O.
          // Keep the final local guard after every host preparation await.
          await beforeDispatch?.();
          if (operation.controller.signal.aborted)
            throw failure(
              "CANCELLED",
              "Request cancelled before dispatch.",
              request.requestId,
            );
          operation.dispatched = true;
          return fetch(url, {
            method,
            headers,
            ...(bytes ? { body: bytes.slice().buffer } : {}),
            credentials: "omit",
            redirect: "error",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            signal: operation.controller.signal,
          });
        };
        const response = request.bodyTransferId
          ? await transfers.withStaged(
              request.bodyTransferId,
              "provider_request",
              dispatch,
            )
          : await dispatch();
        clearTimeout(headerTimer);
        if (operation.controller.signal.aborted) {
          await response.body?.cancel();
          throw failure(
            "CANCELLED",
            "Request was cancelled.",
            request.requestId,
          );
        }
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of response.headers)
          if (
            [
              "content-type",
              "retry-after",
              "x-request-id",
              "request-id",
            ].includes(name)
          )
            responseHeaders[name] = value.slice(0, 4096);
        if (!response.body) {
          finish(request.requestId);
          return {
            requestId: request.requestId,
            status: response.status,
            headers: responseHeaders,
            bodyTransferId: null,
          };
        }
        const transfer = transfers.source(
          request.requestId,
          response.body,
          () => {
            operation.controller.abort();
            finish(request.requestId);
          },
          request.timeout.idleMs,
        );
        return {
          requestId: request.requestId,
          status: response.status,
          headers: responseHeaders,
          bodyTransferId: transfer.transferId,
        };
      } catch (error) {
        const abortReason: unknown = operation.controller.signal.aborted
          ? operation.controller.signal.reason
          : null;
        operation.controller.abort();
        finish(request.requestId);
        if (
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string"
        )
          throw error;
        if (abortReason instanceof Error && "code" in abortReason)
          throw abortReason;
        throw failure(
          "IO_ERROR",
          "Provider transport failed; check endpoint CORS, TLS and configured deadlines.",
          request.requestId,
        );
      }
    },
    async beginTransfer(requestId, declaration) {
      ensure(requestId);
      if (transferAdmissions.size >= WEB_HOST_LIMITS.transfers)
        throw failure('OVERLOADED', 'Transfer admission limit reached.', requestId);
      const epoch = lifecycleEpoch;
      const admission = transfers.begin(requestId, declaration).then(async transfer => {
        if (closed || suspended || epoch !== lifecycleEpoch) {
          try { await transfers.release(transfer.transferId); }
          catch { admissionCleanupFailed = true; throw failure('IO_ERROR', 'Transfer cleanup could not be completed.', requestId); }
          throw failure('CLOSED', 'Transfer belongs to an ended browser session.', requestId);
        }
        return transfer;
      });
      transferAdmissions.add(admission);
      try { return await admission; } finally { transferAdmissions.delete(admission); }
    },
    async finishTransfer(requestId, id, expected) {
      ensure(requestId);
      const epoch = lifecycleEpoch;
      const receipt = await transfers.finish(requestId, id, expected);
      ensure(requestId);
      if (epoch !== lifecycleEpoch) throw failure('CLOSED', 'Transfer belongs to an ended browser session.', requestId);
      return receipt;
    },
    async releaseTransfer(requestId, id) {
      ensure(requestId);
      await transfers.release(id);
    },
    async readChunk(id) {
      if (closed || suspended) throw failure("CLOSED", "Host is closed or suspended.", id);
      return transfers.read(id);
    },
    async acknowledgeChunk(ack) {
      if (closed || suspended) throw failure("CLOSED", "Host is closed or suspended.", ack.transferId);
      await transfers.acknowledge(ack);
    },
    async writeChunk(chunk) {
      if (closed || suspended) throw failure("CLOSED", "Host is closed or suspended.", chunk.transferId);
      return transfers.write(chunk);
    },
    async cancel(requestId) {
      ensure(requestId);
      const operation = operations.get(requestId);
      const completed = operation?.complete === true;
      if (!completed) operation?.controller.abort(
        failure("CANCELLED", "Host request cancelled.", requestId),
      );
      await transfers.cancel(requestId);
      finish(requestId);
      return {
        requestId,
        outcome: completed ? "already_completed" : operation ? "cancelled" : "not_dispatched",
        externalEffect: operation?.dispatched
          ? "may_have_occurred"
          : "not_dispatched",
      };
    },
    startOAuth(request) {
      return oauth.start(request);
    },
    async chooseFiles(requestId, options) {
      const operation = begin(requestId);
      if (
        options.mediaTypes.some((type) => !/^[\w.+-]+\/[\w.+*-]+$/.test(type))
      ) {
        finish(requestId);
        throw failure(
          "INVALID_REQUEST",
          "Invalid accepted media type.",
          requestId,
        );
      }
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = options.multiple;
      input.accept = options.mediaTypes.join(",");
      input.hidden = true;
      document.body.append(input);
      try {
        const selected = await new Promise<File[]>((resolve, reject) => {
          input.addEventListener(
            "change",
            () => resolve([...(input.files ?? [])]),
            { once: true },
          );
          input.addEventListener("cancel", () => resolve([]), { once: true });
          operation.controller.signal.addEventListener(
            "abort",
            () =>
              reject(
                failure("CANCELLED", "File selection cancelled.", requestId),
              ),
            { once: true },
          );
          input.click();
        });
        if (selected.length + files.size > HOST_BOUNDARIES.maxSelectedFiles)
          throw failure(
            "OVERLOADED",
            "Release selected file handles before choosing more files.",
            requestId,
          );
        return selected.map((file) => {
          const id = crypto.randomUUID();
          files.set(id, {
            name: file.name,
            mediaType: file.type || null,
            byteLength: file.size,
            read: async (start, end) =>
              new Uint8Array(await file.slice(start, end).arrayBuffer()),
          });
          return {
            id,
            name: file.name,
            mediaType: file.type || null,
            byteLength: file.size,
          };
        });
      } finally {
        input.remove();
        finish(requestId);
      }
    },
    async writeClipboardText(requestId, text) {
      ensure(requestId);
      if (
        typeof text !== "string" ||
        text.length > HOST_BOUNDARIES.maxClipboardChars
      )
        throw failure(
          "INVALID_REQUEST",
          "Clipboard text exceeds its bound.",
          requestId,
        );
      const writer = clipboardWriter();
      if (!writer)
        throw failure(
          "UNSUPPORTED",
          "This browser does not expose clipboard writing to the page.",
          requestId,
        );
      try {
        await writer(text);
      } catch {
        throw failure(
          "UNSUPPORTED",
          "The browser refused clipboard access; copy from the source view instead.",
          requestId,
        );
      }
    },
    async adoptFiles(requestId, dropped) {
      begin(requestId);
      try {
        if (!Array.isArray(dropped))
          throw failure("INVALID_REQUEST", "Adopted files must be a list.", requestId);
        if (dropped.length + files.size > HOST_BOUNDARIES.maxSelectedFiles)
          throw failure(
            "OVERLOADED",
            "Release selected file handles before adopting more files.",
            requestId,
          );
        const adopted = dropped.map((file) => adopt(file, requestId));
        return adopted.map((file) => {
          const id = crypto.randomUUID();
          files.set(id, file);
          return { id, name: file.name, mediaType: file.mediaType, byteLength: file.byteLength };
        });
      } finally {
        finish(requestId);
      }
    },
    async openFileTransfer(requestId, fileId) {
      ensure(requestId);
      const file = files.get(fileId);
      if (!file)
        throw failure(
          "NOT_FOUND",
          "Selected file was released or belongs to another session.",
          requestId,
        );
      // File.stream() chooses browser-dependent chunk sizes (a multi-MiB
      // selection can arrive in one chunk). Read a bounded slice only when
      // the transfer reader grants demand; cancellation prevents late enqueue.
      let offset = 0, cancelled = false;
      return transfers.source(requestId, new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (cancelled) return;
          if (offset === file.byteLength) { controller.close(); return; }
          const end = Math.min(file.byteLength, offset + WEB_HOST_LIMITS.chunkBytes);
          const bytes = await file.read(offset, end);
          if (cancelled) return;
          if (!(bytes instanceof Uint8Array) || bytes.length !== end - offset)
            throw failure("IO_ERROR", "Selected file changed while it was being read.", requestId);
          offset = end;
          controller.enqueue(bytes);
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 }));
    },
    async releaseFile(requestId, fileId) {
      ensure(requestId);
      files.delete(fileId);
    },
    async saveFileTransfer(requestId, file) {
      const operation = begin(requestId);
      if (
        !file.name ||
        file.name.length > 255 ||
        /[\/\\\x00-\x1f]/.test(file.name)
      ) {
        finish(requestId);
        throw failure(
          "INVALID_REQUEST",
          "Export requires a plain filename.",
          requestId,
        );
      }
      try {
        const picker = (window as SaveWindow).showSaveFilePicker;
        const destination = picker
          ? await picker.call(window, { suggestedName: file.name })
          : null;
        if (operation.controller.signal.aborted)
          throw failure("CANCELLED", "Export was cancelled.", requestId);
        const staged = await transfers.disk.file(file.transferId);
        if (destination) {
          const writable = await destination.createWritable();
          const abort = (): void => {
            void writable.abort().catch(() => {});
          };
          operation.controller.signal.addEventListener("abort", abort, {
            once: true,
          });
          try {
            for (let offset = 0; offset < staged.size; offset += 65536) {
              if (operation.controller.signal.aborted)
                throw failure("CANCELLED", "Export cancelled.", requestId);
              await writable.write(
                new Uint8Array(
                  await staged.slice(offset, offset + 65536).arrayBuffer(),
                ),
              );
            }
            if (operation.controller.signal.aborted)
              throw failure("CANCELLED", "Export cancelled.", requestId);
            await writable.close();
          } catch (error) {
            await writable.abort().catch(() => {});
            throw error;
          } finally {
            operation.controller.signal.removeEventListener("abort", abort);
          }
        } else {
          const url = await transfers.disk.handoff(file.transferId, file.name);
          if (operation.controller.signal.aborted)
            throw failure(
              "CANCELLED",
              "Export cancelled before download handoff.",
              requestId,
            );
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = file.name;
          anchor.click();
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          throw failure(
            "CANCELLED",
            "Export destination selection cancelled.",
            requestId,
          );
        throw error;
      } finally {
        finish(requestId);
      }
    },
    async requestNotificationPermission() {
      if (closed)
        throw failure("CLOSED", "Host is closed.", crypto.randomUUID());
      if (!("Notification" in window))
        throw failure(
          "UNSUPPORTED",
          "Notifications are unavailable.",
          crypto.randomUUID(),
        );
      return Notification.requestPermission();
    },
    async notify(requestId, notification) {
      ensure(requestId);
      if (!("Notification" in window) || Notification.permission !== "granted")
        throw failure(
          "UNSUPPORTED",
          "Enable browser notification permission first.",
          requestId,
        );
      if (notification.action !== null)
        throw failure(
          "UNSUPPORTED",
          "Notification action routing is not wired yet.",
          requestId,
        );
      if (notification.title.length > 256 || notification.body.length > 4096)
        throw failure(
          "INVALID_REQUEST",
          "Notification content exceeds its limit.",
          requestId,
        );
      new Notification(notification.title, { body: notification.body });
    },
    async dispose() {
      if (closed) return;
      closed = true;
      resumeRequested = false;
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('pagehide', pagehide);
        window.removeEventListener('pageshow', pageshow);
      }
      invalidateSession();
      await cleanupSession();
      operations.clear();
    },
  };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', pageshow);
  }
  return host;
}
