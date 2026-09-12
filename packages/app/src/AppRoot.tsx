import { AUDIO_MEDIA_TYPES, FILE_MEDIA_TYPES, IMAGE_MEDIA_TYPES } from "@quixi/providers";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useFocusRecovery } from "./features/accessibility/useFocusRecovery.ts";
import { CompatibilityAnnouncement } from "./features/accessibility/CompatibilityAnnouncement.tsx";
import { createPreferenceController } from './features/preferences/controller.ts';
import { PreferencesPanel } from './features/preferences/PreferencesPanel.tsx';
import { ModelSwitcher } from './features/preferences/ModelSwitcher.tsx';
import { MessageTimestamp } from './features/preferences/MessageTimestamp.tsx';
import { createStorageHealthController, createDoctorAuditController, createBlobHashAuditController } from './features/diagnostics/controller.ts';
import { BlobHashAuditPanel } from './features/diagnostics/BlobHashAuditPanel.tsx';
import { createCleanupController } from './features/diagnostics/cleanup-controller.ts';
import { createMigrationController } from './features/migration/controller.ts';
import { MigrationPanel } from './features/migration/MigrationPanel.tsx';
import { DoctorAuditPanel } from './features/diagnostics/DoctorAuditPanel.tsx';
import { createDiagnosticsController } from './features/diagnostics/report-controller.ts';
import { DiagnosticsPanel } from './features/diagnostics/DiagnosticsPanel.tsx';
import { StorageHealthPanel } from './features/diagnostics/StorageHealthPanel.tsx';
import { isSendKey } from './features/preferences/send-key.ts';
import { createAliasController } from './features/preferences/aliases-controller.ts';
import { RoutingAliasesPanel, ApplyRoutingAlias } from './features/preferences/RoutingAliases.tsx';
import { routingAliasSnapshot } from '@quixi/core/contracts';
import { createCompactionController } from './features/compaction/controller.ts';
import { createSummaryController } from './features/compaction/summaries.ts';
import { SummaryCompaction } from './features/compaction/SummaryCompaction.tsx';
import { assessProcessingRegion, processingRegionKey, regionalAttemptOrigin } from "./runtime/processing-region.ts";
import { assessRequestCost } from "./runtime/request-cost.ts";
import { FreshBranch } from './features/compaction/FreshBranch.tsx';
import { AttachmentCompaction } from './features/compaction/AttachmentCompaction.tsx';
import type { SearchHit, ArchiveSelection } from '@quixi/core/contracts';
import type { ContentPart, Message, JsonObject } from "@quixi/core/model";
import { isInternalProvenancePart, isReasoningEvidencePart } from "@quixi/core/model";
/** Provider records shown under "Response source records": transport
 * evidence plus the receipts and locators that verify reasoning markers. */
const internalProvenance = (part: ContentPart) => isInternalProvenancePart(part) || isReasoningEvidencePart(part);
import {
  createLibraryController,
  type AppServices,
  type LibraryController,
  type LibrarySnapshot,
} from "./runtime/library.ts";
import {
  createChatController,
  type GenerationSettings,
} from "./workflows/chat.ts";
import {
  createContentAccess,
  ContentPartView,
} from "./features/content/index.ts";
import { createConversationSearchController } from "./features/content/conversation-search.ts";
import { ConversationSearchFocus } from "./features/content/ConversationSearchFocus.tsx";
import { createExportController } from "./features/archives/controller.ts";
import { ExportPanel } from "./features/archives/ExportPanel.tsx";
import { createRestoreController } from './features/archives/restore-controller.ts';
import { RestorePanel } from './features/archives/RestorePanel.tsx';
import { ImportPanel } from "./features/imports/index.ts";
import {
  adoptableFile,
  createComposerAttachments,
  ComposerAttachmentsView,
} from "./features/attachments/index.ts";
import {
  describeConnectionHealth,
  observedHealth,
} from "./features/providers/health.ts";
import { describeAttemptUsage, describeThreadUsage } from "./runtime/usage.ts";
import { describeThreadEvent } from "./runtime/events.ts";
import { describeSwitchContext } from "./runtime/switching.ts";
import { describePortability, describeTransformations } from "./runtime/portability.ts";
import { describePrivacyClass } from "./runtime/fallback.ts";
import {
  EMPTY_ROUTING_PROFILE,
  ROUTING_CANDIDATE_LIMIT,
  chooseRoute,
  describeCandidate,
  parseRoutingProfile,
  routingProfileJson,
  type RouteCandidate,
  type RoutingProfile,
} from "./runtime/routing.ts";
import type { FallbackPlan, RoutedAttempt } from "./workflows/chat.ts";
import type { PortabilityInspection } from "./workflows/chat.ts";
import type { ProviderSwitch, SwitchInspection } from "./workflows/chat.ts";
import { createDocumentController } from './features/documents/controller.ts';
import { createSemanticController } from './features/semantic/controller.ts';
import { createOnboardingController } from './features/onboarding/controller.ts';
import { OnboardingPanel, StorageStatus } from './features/onboarding/OnboardingPanel.tsx';
import { SemanticPanel } from './features/semantic/SemanticPanel.tsx';
import { DocumentPanel } from './features/documents/DocumentPanel.tsx';
import {
  createProviderSettingsController,
  ProviderSettingsPanel,
} from "./features/providers/index.ts";

/** Streaming checkpoints retain individual canonical parts; join adjacent inline
 * text for presentation so transport fragmentation cannot break Markdown. */
function displayParts(parts: ContentPart[], generated: boolean): ContentPart[] {
  const output: ContentPart[] = [];
  for (const part of parts.filter((value) => !internalProvenance(value))) {
    const previous = output.at(-1);
    if (
      generated &&
      part.kind === "Text" &&
      !part.data.textBlob &&
      previous?.kind === "Text" &&
      !previous.data.textBlob
    )
      output[output.length - 1] = {
        ...previous,
        data: { text: (previous.data.text ?? "") + (part.data.text ?? "") },
      };
    else output.push(part);
  }
  return output;
}

function ThreadDetails({
  library,
  state,
}: {
  library: LibraryController;
  state: LibrarySnapshot;
}) {
  const view = state.thread!;
  const [title, setTitle] = useState(view.state.title),
    [tags, setTags] = useState(view.state.tags.join(", ")),
    [prompt, setPrompt] = useState(view.context.systemPrompt ?? "");
  useEffect(() => setTitle(view.state.title), [view.state.title]);
  const savedTags = view.state.tags.join(", ");
  useEffect(() => setTags(savedTags), [savedTags]);
  useEffect(
    () => setPrompt(view.context.systemPrompt ?? ""),
    [view.context.id],
  );
  return (
    <details className="thread-details">
      <summary>Conversation settings</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void library.update("SetTitle", title);
        }}
      >
        <label>
          Title
          <input
            value={title}
            maxLength={512}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <button disabled={state.pendingMutation}>Rename</button>
      </form>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void library.update("SetTags", [
            ...new Set(
              tags
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
            ),
          ]);
        }}
      >
        <label>
          Tags, separated by commas
          <input
            value={tags}
            maxLength={4096}
            onChange={(event) => setTags(event.target.value)}
          />
        </label>
        <button disabled={state.pendingMutation}>Save tags</button>
      </form>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void library.systemPrompt(prompt);
        }}
      >
        <label>
          System prompt
          <textarea
            aria-label="System prompt"
            value={prompt}
            maxLength={16384}
            rows={4}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <button disabled={state.pendingMutation || state.busy}>
          Save system prompt
        </button>
      </form>
      <div className="actions">
        <button
          disabled={state.pendingMutation}
          onClick={() => void library.update("SetPinned", !view.state.pinned)}
        >
          {view.state.pinned ? "Unpin" : "Pin"}
        </button>
        <button
          disabled={state.pendingMutation}
          onClick={() =>
            void library.update("SetArchived", !view.state.archived)
          }
        >
          {view.state.archived ? "Unarchive" : "Archive"}
        </button>
      </div>
    </details>
  );
}

/** Own listeners for exactly the lifetime of this conditional panel. */
function RoutingProfileRegion({ children }: { children: import("react").ReactNode }) {
  const focus = useFocusRecovery();
  return <section className="routing-profile" aria-label="Conversation routing" ref={focus.rootRef} onFocusCapture={focus.onFocusCapture}>
    <h3 ref={focus.anchorRef} tabIndex={-1} className="focus-anchor">Conversation routing</h3>
    {children}
  </section>;
}

function MessageEdit({
  message,
  text,
  library,
  disabled,
  onSaved,
  contextLabel,
}: {
  contextLabel: string;
  message: Message;
  text: string;
  library: LibraryController;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [value, setValue] = useState(text);
  // Keyboard focus must never fall to the document body: the edit field takes
  // focus when it opens, and cancelling returns focus to the opening button.
  const opener = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) {
      const element = field.current;
      if (element) {
        element.focus();
        element.setSelectionRange(element.value.length, element.value.length);
      }
    } else if (wasEditing.current) opener.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  if (!editing)
    return (
      <button
        ref={opener}
        aria-label={`Edit as new branch — ${contextLabel}`}
        disabled={disabled}
        onClick={() => {
          setValue(text);
          setEditing(true);
        }}
      >
        Edit as new branch
      </button>
    );
  return (
    <form
      className="message-edit"
      onSubmit={(event) => {
        event.preventDefault();
        void library.edit(message, value).then(() => {
          setEditing(false);
          onSaved();
        });
      }}
    >
      <label>
        Edit message
        <textarea
          ref={field}
          aria-label="Edit message"
          rows={3}
          value={value}
          maxLength={16384}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <button disabled={disabled || !value.trim()}>Save edited branch</button>
      <button type="button" onClick={() => setEditing(false)}>
        Cancel edit
      </button>
    </form>
  );
}

export function AppRoot({
  services,
  onShutdown,
}: {
  services: AppServices;
  onShutdown?: (task: Promise<void>) => void;
}) {
  const library = useMemo(() => createLibraryController(services), [services]);
  const preferences = useMemo(() => createPreferenceController(services.storage), [services]);
  const storageHealth = useMemo(() => createStorageHealthController(services.storage), [services]);
  const diagnostics = useMemo(() => createDiagnosticsController(services.storage, services.host), [services]);
  const doctorAudit = useMemo(() => createDoctorAuditController(services.storage), [services]);
  const hashAudit = useMemo(() => createBlobHashAuditController(services.storage), [services]);
  const cleanup = useMemo(() => createCleanupController(services.storage, storageHealth), [services, storageHealth]);
  const semantic = useMemo(() => createSemanticController({ storage: services.storage, embedding: services.embedding }), [services]);
  const semanticState = useSyncExternalStore(semantic.subscribe, semantic.getSnapshot);
  const onboarding = useMemo(() => createOnboardingController({ storage: services.storage, host: services.host, hostProvidesModel: !!services.embedding }), [services]);
  const onboardingState = useSyncExternalStore(onboarding.subscribe, onboarding.getSnapshot);
  const preference = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  // Product §92: the theme is a root attribute so tokens restyle the whole document.
  useEffect(() => {
    document.documentElement.dataset.theme = preference.value.theme;
    return () => { delete document.documentElement.dataset.theme; };
  }, [preference.value.theme]);
  const aliases = useMemo(() => createAliasController(services.storage), [services]);
  const aliasState = useSyncExternalStore(aliases.subscribe, aliases.getSnapshot);
  useEffect(() => {
    const refresh = () => { void aliases.refresh(); };
    refresh(); window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [aliases]);
  const composingRef = useRef(false);
  useEffect(() => {
    const refresh = () => { void preferences.refresh(); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [preferences]);
  const exports = useMemo(() => createExportController(services), [services]);
  const content = useMemo(() => createContentAccess(services), [services]);
  const conversationSearch = useMemo(() => createConversationSearchController(services), [services]);
  const selectedContent = useSyncExternalStore(conversationSearch.subscribe, conversationSearch.getSnapshot);
  const chat = useMemo(
    () => createChatController(library, services),
    [library, services],
  );
  const state = useSyncExternalStore(library.subscribe, library.getSnapshot);
  const summaries = useMemo(() => createSummaryController(library, services), [library, services]);
  const summaryState = useSyncExternalStore(summaries.subscribe, summaries.getSnapshot);
  useEffect(() => { summaries.reset(); }, [summaries, state.thread?.thread.id, state.thread?.state.revision, state.thread?.context.id, state.leaf]);
  const compaction = useMemo(() => createCompactionController(services.storage), [services]);
  const [compactionSaving, setCompactionSaving] = useState(false);
  const [branchSaving, setBranchSaving] = useState(false);
  useEffect(() => { compaction.cancel(); }, [compaction, state.thread?.thread.id, state.thread?.state.revision, state.thread?.context.id, state.leaf]);
  useEffect(() => () => compaction.cancel(), [compaction]);
  const attachments = useMemo(
    () => createComposerAttachments(services),
    [services],
  );
  const staged = useSyncExternalStore(
    attachments.subscribe,
    attachments.getSnapshot,
  );
  const [dropping, setDropping] = useState(false);
  const [providers, setProviders] = useState(services.providers ?? []);
  const providersRef = useRef(providers); providersRef.current = providers;
  const migration = useMemo(() => createMigrationController({ storage: services.storage, assess: (threadId, targets, settings) => chat.assessThreadPortability(threadId, targets, settings), providers: () => providersRef.current, settings: () => ({ maxOutputTokens: 1024 }) }), [services, chat]);
  // The device's own offline signal is authoritative when false; the
  // provider's answers establish everything else about a connection.
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const settings = useMemo(
    () =>
      services.providerSettings
        ? createProviderSettingsController({
            ...services.providerSettings,
            host: services.host,
            onChange: setProviders,
          })
        : null,
    [services],
  );
  const [section, setSection] = useState<
    "library" | "imports" | "providers" | "exports" | "documents" | "preferences" | "storage-health" | "semantic" | "portability"
  >("library");
  const [searchMode, setSearchMode] = useState<"best" | "exact" | "semantic">("best");
  const [searchNotice, setSearchNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState(""),
    [query, setQuery] = useState(""),
    [draft, setDraft] = useState(""),
    [providerId, setProviderId] = useState(""),
    [modelId, setModelId] = useState(""),
    [outputLimit, setOutputLimit] = useState("1024"),
    [temperature, setTemperature] = useState(""),
    [topP, setTopP] = useState(""),
    [stopSequences, setStopSequences] = useState(""),
    [thinkingBudget, setThinkingBudget] = useState("");
  const [openingSearch, setOpeningSearch] = useState(false);
  const [selectionChanged, setSelectionChanged] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [routingSaving, setRoutingSaving] = useState(false);
  const [quoteNotice, setQuoteNotice] = useState<string | null>(null);
  // Switching the active path to another connection or model shows what the
  // request would carry; a consequential switch needs an explicit review
  // scoped to this exact report before sending.
  const [switchInspection, setSwitchInspection] = useState<{
    key: string;
    inspection: SwitchInspection | null;
    error: string | null;
  } | null>(null);
  const [switchReviewed, setSwitchReviewed] = useState<string | null>(null);
  const [candidateDraft, setCandidateDraft] = useState("");
  // Drafts of the profile's typed fields; committed on blur, reset from the
  // stored profile whenever it or the open conversation changes.
  const [routingDrafts, setRoutingDrafts] = useState({ context: "", cost: "", requestCost: "", alias: "" });
  const invalidRoutingCost = [routingDrafts.cost, routingDrafts.requestCost].some(value => value.trim() !== "" && !/^\d{1,9}(\.\d{1,9})?$/.test(value.trim()));
  // The open conversation's portability across every configured target,
  // recomputed whenever the path, the targets or the settings change.
  const [portability, setPortability] = useState<{
    key: string;
    inspection: PortabilityInspection | null;
  } | null>(null);
  const [promptCount, setPromptCount] = useState<
    | { kind: "counted"; tokens: number; label: string; target: { provider: string; model: string } }
    | { kind: "unavailable"; reason: string }
    | null
  >(null);
  const [counting, setCounting] = useState(false);
  useEffect(() => {
    if (!settings) return;
    const update = () => settings.setActivity({ online: navigator.onLine !== false, visible: document.visibilityState === 'visible', busy: state.busy || counting });
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      settings.setActivity({ online: false, visible: false, busy: false });
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [settings, state.busy, counting]);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const workspaceStatusFocus = useFocusRecovery();
  const [workspaceStatusRevealed, setWorkspaceStatusRevealed] = useState(false);
  const conversationHeadingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** Return keyboard focus to the composer after a control it activated is
   * replaced or disabled, so focus never silently drops to the document. */
  const focusComposer = () =>
    setTimeout(() => messageRef.current?.focus({ preventScroll: true }), 0);
  const [openingArchive, setOpeningArchive] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /** An unsent message is draft text or a staged image. */
  const unsent = () =>
    draftRef.current.length > 0 || attachments.getSnapshot().items.length > 0;
  const documents = useMemo(() => {
    const session = services.archiveSession;
    if (!session) return createDocumentController(services);
    const requireIdle = () => {
      if (library.getSnapshot().busy)
        throw new Error('Stop active responses and wait for history changes before checking the previous archive.');
      const exporting = exports.getSnapshot();
      if (exporting.busy || exporting.saving)
        throw new Error('Wait for export preparation or saving before checking the previous archive.');
    };
    return createDocumentController({ ...services, archiveSession: {
      ...session,
      reconcilePreviousOperations: ids => { requireIdle(); return session.reconcilePreviousOperations(ids); },
      ...(session.reconcilePreviousExtractionOperation ? {
        reconcilePreviousExtractionOperation: (pending: { operationId: string; requestDigest: string }) => {
          requireIdle(); return session.reconcilePreviousExtractionOperation!(pending);
        },
      } : {}),
    } });
  }, [services, library, exports]);
  const replacementBlock = () => {
    if (unsent()) return 'Copy or clear your unsent message before replacing or opening another archive.';
    const current = library.getSnapshot();
    if (current.pendingMutation) return 'Check the outcome of your pending history change before opening another archive.';
    if (current.busy) return 'Stop active responses and wait for history changes to finish before replacing the archive.';
    const exporting = exports.getSnapshot();
    if (exporting.busy || exporting.saving) return 'Wait for export preparation or saving to finish.';
    return documents.replacementBlock();
  };
  const replacementBlockRef = useRef(replacementBlock);
  replacementBlockRef.current = replacementBlock;
  const restore = useMemo(() => services.archiveSession ? createRestoreController({
    storage: services.storage,
    host: services.host,
    selection: services.archiveSession.selection,
    activationStatus: services.archiveSession.activationStatus,
    canReplace: () => replacementBlockRef.current(),
  }) : null, [services]);
  useEffect(() => services.archiveSession?.onSelectionChange(() => setSelectionChanged(true)), [services]);
  useEffect(() => { if (selectionChanged) { storageHealth.invalidate(); diagnostics.invalidate(); doctorAudit.invalidate(); hashAudit.invalidate(); } }, [selectionChanged, storageHealth, diagnostics, doctorAudit, hashAudit]);
  const openSelectedArchive = async (expected?: ArchiveSelection) => {
    if (!services.archiveSession || openingArchive) return;
    const reason = replacementBlock();
    if (reason) { setSessionError(reason); return; }
    setOpeningArchive(true); setSessionError(null);
    try { await services.archiveSession.openSelectedArchive(expected); }
    catch (error) { setSessionError(error instanceof Error ? error.message : String(error)); }
    finally { setOpeningArchive(false); }
  };
  const routingProfile = parseRoutingProfile(state.thread?.state.routingProfile ?? null);
  const unsupportedRouting = state.thread?.state.routingProfile?.version !== undefined && !routingProfile;
  const primary = routingProfile?.primary;
  const provider = primary
    ? providers.find(value => value.id === primary.provider)
    : providers.find(value => value.id === providerId) ?? providers[0];
  const model = primary
    ? provider?.models.find(value => value.id === primary.model)
    : provider?.models.find(value => value.id === modelId) ?? provider?.models[0];
  const capabilities = model && provider?.adapter.capabilities(model.id);
  const supportsOutputLimit =
    capabilities?.parameters.includes("maxOutputTokens") ?? false;
  const outputTokens = Number(outputLimit);
  const validOutputLimit =
    supportsOutputLimit &&
    outputLimit.trim() !== "" &&
    Number.isSafeInteger(outputTokens) &&
    outputTokens >= 1 &&
    (capabilities?.maxOutputTokens == null ||
      outputTokens <= capabilities.maxOutputTokens);
  // Sampling settings appear only when the reviewed catalog permits them. A
  // blank field keeps the provider default; an invalid one blocks sending and
  // keeps the draft, so no message or request is created from bad settings.
  const supportsTemperature =
    capabilities?.parameters.includes("temperature") ?? false;
  const supportsTopP = capabilities?.parameters.includes("topP") ?? false;
  const supportsStopSequences =
    capabilities?.parameters.includes("stopSequences") ?? false;
  const temperatureMax = model?.protocol === "anthropic" ? 1 : 2;
  const sampling = (raw: string, max: number) => {
    const text = raw.trim();
    if (text === "") return { value: undefined, valid: true };
    const value = Number(text);
    return {
      value,
      valid: /^(\d+\.?\d*|\.\d+)$/.test(text) && value >= 0 && value <= max,
    };
  };
  const temperatureSetting = sampling(temperature, temperatureMax);
  const topPSetting = sampling(topP, 1);
  const stopList = stopSequences
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);
  const validStopSequences =
    stopList.length <= 4 && stopList.every((line) => line.length <= 1024);
  // Manual thinking appears only for a reviewed profile. A blank budget keeps
  // thinking off; a set budget must be a whole number of at least 1,024 tokens
  // below the output limit, with temperature blank and top-p blank or 0.95–1,
  // as Anthropic's extended-thinking contract requires.
  const supportsThinking =
    capabilities?.parameters.includes("thinkingBudgetTokens") ?? false;
  const thinkingText = thinkingBudget.trim();
  const thinkingValue = thinkingText === "" ? undefined : Number(thinkingText);
  const thinkingEnabled = supportsThinking && thinkingValue !== undefined;
  const thinkingProblem = !thinkingEnabled
    ? null
    : !/^\d+$/.test(thinkingText) || !Number.isSafeInteger(thinkingValue) || thinkingValue < 1024
      ? "Enter a whole number of at least 1,024 tokens."
      : !validOutputLimit || thinkingValue >= outputTokens
        ? "The budget must be below the output-token limit."
        : temperatureSetting.value !== undefined
          ? "Clear temperature while thinking is enabled."
          : topPSetting.value !== undefined && !(topPSetting.value >= 0.95 && topPSetting.value <= 1)
            ? "Top-p must be blank or between 0.95 and 1 while thinking is enabled."
            : null;
  const validSettings =
    validOutputLimit &&
    (!supportsTemperature || temperatureSetting.valid) &&
    (!supportsTopP || topPSetting.valid) &&
    (!supportsStopSequences || validStopSequences) &&
    thinkingProblem === null;
  const generationSettings: GenerationSettings = {
    maxOutputTokens: outputTokens,
    ...(thinkingEnabled && thinkingProblem === null ? { thinkingBudgetTokens: thinkingValue } : {}),
    ...(supportsTemperature && temperatureSetting.value !== undefined
      ? { temperature: temperatureSetting.value }
      : {}),
    ...(supportsTopP && topPSetting.value !== undefined
      ? { topP: topPSetting.value }
      : {}),
    ...(supportsStopSequences && stopList.length
      ? { stopSequences: stopList }
      : {}),
  };
  const promptScope = JSON.stringify([provider?.id, model?.id, generationSettings, state.thread?.thread.id, state.thread?.state.revision, state.thread?.context.id, state.thread?.state.routingProfile, provider ? processingRegionKey(provider) : null, state.leaf, draft, staged.items.map(item => item.id)]);
  const promptScopeRef = useRef(promptScope), promptAdapterRef = useRef(provider?.adapter);
  promptScopeRef.current = promptScope; promptAdapterRef.current = provider?.adapter;
  useEffect(() => { setPromptCount(null); }, [promptScope, provider?.adapter]);
  useEffect(() => {
    void library.initialize();
    void settings?.initialize();
    void semantic.initialize();
    void onboarding.initialize();
    return () => {
      const task = Promise.allSettled([
        onboarding.dispose(),
        semantic.dispose(),
        chat.dispose(),
        summaries.dispose(),
        attachments.dispose(),
        library.dispose(),
        settings?.dispose(),
        content.dispose(),
        conversationSearch.dispose(),
        exports.dispose(),
        restore?.dispose(),
        documents.dispose(),
        storageHealth.dispose(),
        diagnostics.dispose(),
        doctorAudit.dispose(),
        hashAudit.dispose(),
        cleanup.dispose(),
        migration.dispose(),
      ]).then(() => {});
      onShutdown?.(task);
    };
  }, [library, chat, summaries, attachments, settings, content, conversationSearch, exports, restore, documents, storageHealth, diagnostics, doctorAudit, hashAudit, cleanup, migration, semantic, onboarding, onShutdown]);
  useEffect(() => {
    setPromptCount(null);
    setSwitchReviewed(null);
  }, [provider?.id, model?.id, state.thread?.context.id]);
  useEffect(() => {
    setDraft("");
    setQuoteNotice(null);
    setPromptCount(null);
    void attachments.clear();
  }, [state.thread?.thread.id, attachments]);
  const open = (threadId: string, leaf: string | null = null) => {
    if (openingArchive || selectionChanged) return;
    conversationSearch.clear();
    setSection("library");
    void library.open(threadId, leaf);
  };
  const openImportedThread = (threadId: string) => {
    if (openingArchive || selectionChanged) return;
    conversationSearch.clear();
    setSection("library");
    void library.open(threadId).then(() => requestAnimationFrame(() => {
      const heading = conversationHeadingRef.current;
      // Opening an import removes its panel and initiating button. Only hand
      // off focus if navigation has finished and the user has not moved it.
      if (heading?.dataset.threadId === threadId && document.activeElement === document.body)
        heading.focus();
    }));
  };
  /** Exact never embeds. Best and Semantic embed the query with query
   * semantics when the local runtime can; Best otherwise stays lexical and
   * says so, while Semantic reports why it cannot run. */
  const lastVector = useRef<{ query: string; vector: number[] } | null>(null);
  const runSearch = async (cursor: string | null) => {
    const text = cursor ? state.query : query;
    if (searchMode === "exact") { setSearchNotice(null); lastVector.current = null; await library.search(text, cursor, { mode: "exact" }); return; }
    let vector = cursor && lastVector.current?.query === text ? lastVector.current.vector : null;
    if (!vector) {
      const embedded = await semantic.embedQuery(text);
      if (embedded.vector) { vector = embedded.vector; lastVector.current = { query: text, vector }; setSearchNotice(null); }
      else {
        lastVector.current = null;
        if (searchMode === "semantic") { setSearchNotice(`Semantic search is unavailable: ${embedded.reason}`); return; }
        setSearchNotice(`Semantic ranking unavailable (${embedded.reason}). Showing text matches.`);
      }
    }
    await library.search(text, cursor, { mode: searchMode, ...(vector ? { queryVector: vector } : {}) });
  };
  const openConversationHit = async (hit: SearchHit) => {
    const current = library.getSnapshot();
    if (hit.threadId !== current.thread?.thread.id && unsent()) {
      conversationSearch.refuse('Copy or clear your unsent message before opening a search result in another conversation.');
      return;
    }
    if (hit.threadId !== current.thread?.thread.id && current.busy) {
      conversationSearch.refuse('Wait for the active response before opening another conversation.');
      return;
    }
    const focus = await conversationSearch.resolve(hit);
    if (!focus || conversationSearch.getSnapshot().focus !== focus) return;
    const latest = library.getSnapshot();
    if (latest.thread?.thread.id !== current.thread?.thread.id || latest.leaf !== current.leaf) {
      conversationSearch.clear();
      return;
    }
    if (focus.threadId !== latest.thread?.thread.id && (unsent() || latest.busy)) {
      conversationSearch.refuse('Keep your current draft or response open. Copy or clear the draft and wait for active work before changing conversations.');
      return;
    }
    setOpeningSearch(true);
    setSection('library');
    try {
      await library.open(focus.threadId, focus.messageId);
      if (conversationSearch.getSnapshot().focus !== focus) return;
      const opened = library.getSnapshot();
      if (opened.error || opened.thread?.thread.id !== focus.threadId || !opened.messages.some(item => item.message.id === focus.messageId))
        conversationSearch.refuse('This search result could not be opened at its original message. Search again to refresh the results.');
    } finally { setOpeningSearch(false); }
  };
  const send = async () => {
    if (
      openingSearch ||
      invalidRoutingCost ||
      unsupportedRouting ||
      routingSaving ||
      compactionSaving ||
      selectionChanged ||
      !provider ||
      !model ||
      !validSettings ||
      attachments.getSnapshot().busy ||
      switchBlocks ||
      !target ||
      !targetModel
    )
      return;
    messageRef.current?.focus({ preventScroll: true });
    const value = draft,
      threadId = state.thread?.thread.id,
      images = attachments.staged();
    if (await chat.send(value, target, targetModel.id, generationSettings, images, providerSwitch, fallbackPlan, routed)) {
      attachments.consumed(images.map((image) => image.id));
      if (library.getSnapshot().thread?.thread.id === threadId)
        setDraft((current) => (current === value ? "" : current));
    }
  };
  const imagesSupported = capabilities?.images === "supported" && capabilities.inputModalities.includes("image");
  const fileMediaTypes = capabilities?.files === "supported" && capabilities.inputModalities.includes("file")
    ? (capabilities.fileMediaTypes ?? []).filter(type => FILE_MEDIA_TYPES.includes(type)) : [];
  const audioMediaTypes = capabilities?.inputModalities.includes("audio")
    ? (capabilities.audioMediaTypes ?? []).filter(type => AUDIO_MEDIA_TYPES.includes(type)) : [];
  const attachmentMediaTypes = [...(imagesSupported ? IMAGE_MEDIA_TYPES : []), ...fileMediaTypes, ...audioMediaTypes];
  useEffect(() => { attachments.cancelPending(); }, [attachments, provider?.adapter, model?.id]);
  // Routing: the selected connection is the primary; the conversation's
  // profile adds ordered fallback candidates and requirements. The route is
  // chosen before the first attempt from health, capability, privacy, context
  // and cost facts, and the compatibility review below concerns the chosen
  // target, so the reviewed report is the transmitted request's.
  const routeCandidate = (requested: { provider: string; model: string }): RouteCandidate => {
    const configured = providers.find((value) => value.id === requested.provider) ?? null;
    const description = configured?.models.find((item) => item.id === requested.model) ?? null;
    const health = configured
      ? describeConnectionHealth(observedHealth(configured.adapter.accountHealth()), clock, online)
      : null;
    const counted =
      promptCount?.kind === "counted" &&
      promptCount.target.provider === requested.provider &&
      promptCount.target.model === requested.model
        ? promptCount.tokens
        : null;
    return {
      requested,
      provider: configured
        ? { id: configured.id, label: configured.label, privacy: configured.privacy ?? null }
        : null,
      model: description
        ? {
            id: description.id,
            name: description.name,
            capabilities: {
              tools: description.capabilities.tools,
              images: description.capabilities.images,
              contextWindow: description.capabilities.contextWindow,
            },
          }
        : null,
      health: health
        ? { blocksSending: health.blocksSending, label: health.label, detail: health.detail }
        : null,
      report:
        portability?.inspection?.targets.find(
          (item) => item.provider.id === requested.provider && item.model.id === requested.model,
        )?.report ?? null,
      region: assessProcessingRegion(routingProfile?.requirements ?? {}, configured, requested.model),
      cost: assessRequestCost({ requirements: routingProfile?.requirements ?? {},
        pricing: description?.pricing ?? null, contextWindow: description?.capabilities.contextWindow ?? null,
        maxOutputTokens: generationSettings.maxOutputTokens, countedInputTokens: counted }),
    };
  };
  const route =
    provider && model
      ? chooseRoute(
          routingProfile,
          routeCandidate({ provider: provider.id, model: model.id }),
          (routingProfile?.candidates ?? []).map(routeCandidate),
        )
      : null;
  const target = route?.chosen?.provider
    ? providers.find((value) => value.id === route.chosen!.provider!.id) ?? null
    : null;
  const targetModel =
    target && route?.chosen?.model
      ? target.models.find((item) => item.id === route.chosen!.model!.id) ?? null
      : null;
  // Eligibility/credentials can replace an adapter while retaining its public
  // connection/model IDs. Cached reports and their reviews belong to that
  // exact adapter instance and the current published target collection.
  const targetInspectionRevision = useMemo(() => crypto.randomUUID(), [target?.adapter]);
  const portabilityRevision = useMemo(() => crypto.randomUUID(), [providers]);
  const routed: RoutedAttempt | null =
    route && route.chosenIndex > 0 && provider && model
      ? {
          from: { provider: provider.id, model: model.id, privacy: provider.privacy ?? null },
          reason: route.reasons.join(" "),
        }
      : null;
  const lastAttempt =
    [...state.messages].reverse().find((item) => item.generation)?.generation ??
    null;
  // Regional attempts share the provider's account identity; the reviewed
  // processing note distinguishes the registered connection used for the attempt.
  const lastConnection = lastAttempt ? providers.find(value => {
    const region = value.regionalProcessing?.region;
    if (!region || value.adapter.binding.providerId !== lastAttempt.provider || value.adapter.binding.accountId !== lastAttempt.providerAccountId) return false;
    const assessment = assessProcessingRegion({ processingRegion: region }, value, lastAttempt.model ?? "");
    return assessment.allowed && lastAttempt.compatibility.includes(assessment.reason);
  }) ?? regionalAttemptOrigin(lastAttempt) ?? providers.find(value => value.id === lastAttempt.provider) : null;
  // The active path's origin: its last attempt, else the import it came
  // from. An import's privacy class is not one of this device's transport
  // classes, so it is unknown and continuing it is always reviewed.
  const origin: {
    provider: string;
    model: string | null;
    label: string;
    privacy: string | null;
    imported: boolean;
  } | null = lastAttempt
    ? {
        provider: lastConnection?.id ?? lastAttempt.provider ?? "unknown",
        model: lastAttempt.model ?? null,
        label:
          lastConnection?.label ??
          lastAttempt.provider ??
          "unknown",
        privacy:
          lastConnection?.privacy ?? null,
        imported: false,
      }
    : state.origin
      ? {
          provider: state.origin.provider,
          model: null,
          label: `${state.origin.provider} (imported)`,
          privacy: null,
          imported: true,
        }
      : null;
  const switching =
    !!target &&
    !!targetModel &&
    !!origin &&
    (origin.provider !== target.id ||
      (origin.model !== null && origin.model !== targetModel.id));
  const switchKey =
    switching && state.thread
      ? `${state.thread.thread.id}:${state.thread.context.id}:${state.leaf}:${target!.id}:${targetModel!.id}:${targetInspectionRevision}:${state.messages.length}:${JSON.stringify(generationSettings)}:${staged.items.map(item => item.id).join(",")}`
      : null;
  useEffect(() => {
    if (!switchKey || !target || !targetModel || state.busy) return;
    let active = true;
    setSwitchInspection({ key: switchKey, inspection: null, error: null });
    chat.inspectSwitch(target, targetModel.id, generationSettings, attachments.staged()).then(
      (inspection) => {
        if (active)
          setSwitchInspection({
            key: switchKey,
            inspection,
            error: inspection ? null : "The active branch could not be inspected.",
          });
      },
      (error) => {
        if (active)
          setSwitchInspection({
            key: switchKey,
            inspection: null,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      active = false;
    };
    // The key binds the branch, adapter instance, settings and staged attachments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switchKey, state.busy]);
  const inspection =
    switchInspection?.key === switchKey ? switchInspection.inspection : null;
  const portabilityKey = state.thread
    ? `${state.thread.thread.id}:${state.thread.context.id}:${state.leaf}:${state.messages.length}:${providers
        .map((value) => `${value.id}=${value.models.map((item) => item.id).join("|")}`)
        .join(",")}:${portabilityRevision}:${JSON.stringify(generationSettings)}`
    : null;
  useEffect(() => {
    if (!portabilityKey || state.busy) return;
    let active = true;
    chat.assessPortability(providers, generationSettings).then(
      (result) => {
        if (active) setPortability({ key: portabilityKey, inspection: result });
      },
      () => {
        if (active) setPortability({ key: portabilityKey, inspection: null });
      },
    );
    return () => {
      active = false;
    };
    // The key names everything the assessment depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portabilityKey, state.busy]);
  const portabilityView =
    portability?.key === portabilityKey && portability.inspection && !portability.inspection.empty
      ? describePortability(
          portability.inspection.targets,
          portability.inspection.transformed,
          portability.inspection.neverSent,
        )
      : null;
  const privacyFrom = origin?.privacy ?? null;
  const privacyTo = target?.privacy ?? null;
  const switchSummary = inspection
    ? {
        // A note standing in for an image is counted once, as transformed.
        preserved: inspection.report.preserved.parts - inspection.transformed.unavailableImages - (inspection.transformed.excludedAttachments ?? 0) - Number(Boolean(inspection.transformed.reviewedSummary)),
        transformed: inspection.transformed.inlinedBlobText + inspection.transformed.unavailableImages + (inspection.transformed.excludedAttachments ?? 0) + Number(Boolean(inspection.transformed.reviewedSummary)) + (inspection.transformed.reasoningOmittedUnverified ?? 0) + (inspection.transformed.reasoningOmittedForeign ?? 0) + (inspection.transformed.citationsTransformed ?? 0) + (inspection.transformed.structuredDataFlattened ?? 0) + (inspection.transformed.providerArtifactsDegraded ?? 0),
        omitted: inspection.omitted.internalProvenance + inspection.omitted.emptyAssistant,
        blocked: inspection.report.blocked.length,
      }
    : null;
  const consequential =
    switching &&
    !!origin &&
    !!target &&
    (target.id !== origin.provider ||
      privacyFrom !== privacyTo ||
      (switchSummary
        ? switchSummary.omitted + switchSummary.transformed + switchSummary.blocked > 0
        : true));
  const reviewKey =
    switchKey && switchSummary
      ? `${switchKey}:${JSON.stringify({ ...switchSummary, privacyFrom, privacyTo, codes: inspection!.report.blocked.map((item) => item.code) })}`
      : null;
  // A count belongs to the target it was taken for; counting is never
  // automatic because it sends the branch to that provider.
  const targetCount =
    promptCount?.kind === "counted" &&
    target &&
    targetModel &&
    promptCount.target.provider === target.id &&
    promptCount.target.model === targetModel.id
      ? { tokens: promptCount.tokens, label: promptCount.label }
      : null;
  const switchContext =
    inspection && target && targetModel
      ? describeSwitchContext(
          inspection.report,
          targetCount,
          {
            input: (count) =>
              target.adapter.estimateCost(targetModel.id, {
                inputTokens: count,
                outputTokens: 0,
                // The request asks for no caching, so the estimate prices
                // every input token at the uncached rate.
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                reasoningTokens: null,
                raw: {},
                source: "provider",
              }).cost,
            output: (count) =>
              target.adapter.estimateCost(targetModel.id, {
                inputTokens: 0,
                outputTokens: count,
                // The request asks for no caching, so the estimate prices
                // every input token at the uncached rate.
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                reasoningTokens: null,
                raw: {},
                source: "provider",
              }).cost,
          },
          { label: target.label, countsTokens: targetModel.protocol === "anthropic" },
        )
      : null;
  const switchBlocks =
    switching &&
    (!inspection ||
      !inspection.report.sendable ||
      (switchContext?.overRoomBy ?? 0) > 0 ||
      (consequential && switchReviewed !== reviewKey));
  const providerSwitch: ProviderSwitch | null =
    switching && origin && target && targetModel && switchSummary
      ? {
          from: { provider: origin.provider, model: origin.model ?? "imported", privacy: privacyFrom },
          to: { provider: target.id, model: targetModel.id, privacy: privacyTo },
          ...switchSummary,
          promptTokens: targetCount?.tokens ?? null,
          inputRoom: switchContext?.inputRoom ?? null,
          reviewedAt: Date.now(),
        }
      : null;
  const privacyLabel = describePrivacyClass;
  // The conversation's stored fallback and the plan a send carries: the
  // candidate is resolved when a primary attempt fails, with its health then.
  const routingStored = {
    context: String(routingProfile?.requirements.contextAtLeast ?? ""),
    cost: routingProfile?.requirements.maxRequestCost ?? "",
    requestCost: routingProfile?.requirements.maxEstimatedRequestCost ?? "",
    alias: routingProfile?.alias ?? "",
  };
  useEffect(() => {
    setRoutingDrafts(routingStored);
    // The stored values are the dependency; the object is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.thread?.thread.id, routingStored.context, routingStored.cost, routingStored.requestCost, routingStored.alias]);
  const saveRoutingProfile = (value: JsonObject | null) => {
    if (routingSaving || state.busy || state.pendingMutation || selectionChanged) return;
    setRoutingSaving(true); setSwitchReviewed(null); setPromptCount(null);
    void library.update("SetRoutingProfile", value).finally(() => setRoutingSaving(false));
  };
  const setRoutingProfile = (next: RoutingProfile | null) =>
    saveRoutingProfile(routingProfileJson(state.thread?.state.routingProfile ?? null, next));
  const patchRoutingProfile = (patch: Partial<RoutingProfile>) => {
    const { aliasSource: _source, ...current } = routingProfile ?? EMPTY_ROUTING_PROFILE;
    setSwitchReviewed(null); setPromptCount(null);
    setRoutingProfile({ ...current, ...patch });
  };
  const selectPrimary = (provider: string, model: string) => {
    if (primary) patchRoutingProfile({ primary: { provider, model },
      candidates: (routingProfile?.candidates ?? []).filter(value => value.provider !== provider || value.model !== model) });
    else { setProviderId(provider); setModelId(model); }
  };
  const fallbackPlan: FallbackPlan | null =
    route && route.chosen && routingProfile && routingProfile.candidates.length > route.chosenIndex
      ? {
          allowPrivacyChange: routingProfile.allowPrivacyChange,
          primaryLabel: target?.label ?? "The selected connection",
          primaryPrivacy: target?.privacy ?? null,
          candidates: () =>
            routingProfile.candidates.slice(route.chosenIndex).map((requested) => {
              const candidate = routeCandidate(requested);
              return {
                requested,
                configured: providers.find((value) => value.id === requested.provider) ?? null,
                model: candidate.model ? { id: candidate.model.id, name: candidate.model.name } : null,
                health: candidate.health ?? { blocksSending: true, label: "Not configured", detail: null },
              };
            }),
        }
      : null;
  const remainingCandidates =
    route && routingProfile ? routingProfile.candidates.slice(Math.max(0, route.chosenIndex)) : [];
  const routeSummary = route
    ? `Route: ${route.reasons.join(" ")}${
        route.chosen && remainingCandidates.length
          ? ` If it fails, continue with ${remainingCandidates.map((item) => describeCandidate(routeCandidate(item))).join(", then ")}. A stopped response never falls back.`
          : ""
      }`
    : null;
  /** Count the prompt as it would be sent; an explicit action because it is a
   * provider request, and a result that belongs to this exact draft. */
  const countPrompt = async () => {
    if (counting || compactionSaving || routingSaving || selectionChanged || library.getSnapshot().busy || library.getSnapshot().pendingMutation || unsupportedRouting || !provider || !model || !validSettings) return;
    const value = draft, capturedPromptScope = promptScopeRef.current;
    const captured = library.getSnapshot().thread;
    const stillCurrent = () => {
      const latest = library.getSnapshot().thread;
      return promptAdapterRef.current === provider.adapter && promptScopeRef.current === capturedPromptScope && draftRef.current === value && latest?.thread.id === captured?.thread.id && latest?.state.revision === captured?.state.revision && latest?.context.id === captured?.context.id && latest?.state.activeLeafMessageId === captured?.state.activeLeafMessageId;
    };
    setCounting(true);
    try {
      const result = await chat.countPrompt(
        value,
        provider,
        model.id,
        generationSettings,
        attachments.staged(),
      );
      if (!result) return;
      if (!stillCurrent()) return;
      setPromptCount(
        result.tokens !== null
          ? {
              kind: "counted",
              tokens: result.tokens,
              label: provider.label,
              target: { provider: provider.id, model: model.id },
            }
          : {
              kind: "unavailable",
              reason: result.reason ?? "The provider did not report a count.",
            },
      );
    } catch (error) {
      if (!stillCurrent()) return;
      setPromptCount({
        kind: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCounting(false);
    }
  };
  const connectionHealth = describeConnectionHealth(
    provider ? observedHealth(provider.adapter.accountHealth()) : null,
    clock,
    online,
  );
  // A known retry time re-enables sending by the clock without a reload.
  useEffect(() => {
    if (connectionHealth.retryAt === null) return;
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.max(250, connectionHealth.retryAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [connectionHealth.retryAt]);
  const hasFiles = (transfer: DataTransfer | null) =>
    !!transfer && Array.from(transfer.types).includes("Files");
  const regenerate = (parent: Message) => {
    if (!selectionChanged && !compactionSaving && !routingSaving && !invalidRoutingCost && !unsupportedRouting && target && targetModel && validSettings && !switchBlocks)
      void chat.regenerate(parent, target, targetModel.id, generationSettings, fallbackPlan, routed);
  };
  /** Quote the text selected inside this message, or its whole inline text,
   * as a Markdown blockquote appended to the draft. The draft is never
   * truncated: an over-limit quote is refused and reported instead. */
  const quote = (
    item: LibrarySnapshot["messages"][number],
    element: HTMLElement | null,
  ) => {
    const selection = window.getSelection();
    let text = "";
    if (
      selection &&
      !selection.isCollapsed &&
      selection.rangeCount > 0 &&
      element?.contains(selection.getRangeAt(0).commonAncestorContainer)
    )
      text = selection.toString();
    else
      text = displayParts(item.parts, !!item.generation)
        .map((part) =>
          part.kind === "Text" && !part.data.textBlob
            ? (part.data.text ?? "")
            : "",
        )
        .join("");
    text = text.replace(/\s+$/, "");
    if (!text) {
      setQuoteNotice(
        "Select text in this message before quoting; long or non-text content is not quoted automatically.",
      );
      return;
    }
    const block =
      text
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n") + "\n\n";
    const current = draftRef.current;
    const next = current
      ? current + (current.endsWith("\n") ? "" : "\n\n") + block
      : block;
    if (next.length > 16384) {
      setQuoteNotice(
        "Quoting this text would exceed the 16,384-character message limit. Select a shorter passage.",
      );
      return;
    }
    setQuoteNotice(null);
    setDraft(next);
    const field = messageRef.current;
    if (field)
      setTimeout(() => {
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }, 0);
  };
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#workspace"
        onClick={(event) => {
          event.preventDefault();
          workspaceRef.current?.focus();
        }}
      >
        Skip to conversation
      </a>
      <aside className="sidebar" aria-label="Conversation library">
        <a className="brand" href="/" aria-label="Quixi home">
          Quixi<span>Your history. Your choice.</span>
        </a>
        <button
          className="primary"
          disabled={state.loading || state.pendingMutation || openingArchive || selectionChanged}
          onClick={() => {
            setSection("library");
            void library.create().then(focusComposer);
          }}
        >
          New conversation
        </button>
        <nav aria-label="Workspace">
          <button
            aria-current={section === "preferences" ? "page" : undefined}
            onClick={() => { setSection("preferences"); void preferences.refresh(); void aliases.refresh(); }}
          >Preferences</button>
          <button aria-current={section === 'storage-health' ? 'page' : undefined} onClick={() => { setSection('storage-health'); void onboarding.refresh(); }}>Storage health</button>
          <button aria-current={section === 'portability' ? 'page' : undefined} onClick={() => setSection('portability')}>Portability</button>
          <button aria-current={section === 'semantic' ? 'page' : undefined} onClick={() => { setSection('semantic'); void semantic.refresh(); }}>Semantic search</button>
          <button
            aria-current={section === "library" ? "page" : undefined}
            onClick={() => setSection("library")}
          >
            Library
          </button>
          <button
            aria-current={section === "imports" ? "page" : undefined}
            onClick={() => setSection("imports")}
          >
            Import history
          </button>
          <button
            aria-current={section === "providers" ? "page" : undefined}
            onClick={() => setSection("providers")}
          >
            Providers
          </button>
          <button
            aria-current={section === 'documents' ? 'page' : undefined}
            onClick={() => { setSection('documents'); void documents.refresh(); }}
          >Documents</button>
          <button
            aria-current={section === "exports" ? "page" : undefined}
            onClick={() => setSection("exports")}
          >
            Export history
          </button>
        </nav>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void library.filter(state.archived, filter);
          }}
        >
          <label>
            Filter titles
            <input
              value={filter}
              maxLength={512}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <button>Filter</button>
        </form>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={state.archived}
            onChange={(event) =>
              void library.filter(event.target.checked, filter)
            }
          />{" "}
          Archived conversations
        </label>
        {state.libraryDirty && (
          <button onClick={() => void library.refresh()}>
            Refresh library
          </button>
        )}
        <ul className="thread-list">
          {state.library.items.map((thread) => (
            <li key={thread.threadId}>
              <button
                disabled={openingArchive || selectionChanged}
                aria-current={
                  state.thread?.thread.id === thread.threadId
                    ? "true"
                    : undefined
                }
                onClick={() => open(thread.threadId)}
              >
                <span>
                  {thread.pinned ? "★ " : ""}
                  {thread.title || "Untitled conversation"}
                  {thread.titleTruncated ? "…" : ""}
                </span>
                <small>
                  {thread.tags.join(" · ")}
                  {thread.tagsTruncated ? " …" : ""}
                </small>
              </button>
            </li>
          ))}
        </ul>
        {!state.loading && !state.library.items.length && (
          <p className="muted">No conversations in this view.</p>
        )}
        <div className="actions">
          <button onClick={() => void library.previousLibrary()}>
            Previous
          </button>
          <button
            disabled={!state.library.nextCursor}
            onClick={() => void library.nextLibrary()}
          >
            Next
          </button>
        </div>
        <p className="local-note">
          History stays on this device. Sending shares the selected branch with
          your chosen provider.
        </p>
      </aside>
      <main
        id="workspace"
        className="workspace"
        tabIndex={-1}
        ref={workspaceRef}
      >
        <section aria-label="Workspace status" ref={workspaceStatusFocus.rootRef} onFocusCapture={event => {
          workspaceStatusFocus.onFocusCapture(event);
          // Keep the revealed destination in flow after blur, so a pointer
          // leaving it cannot move its next target between down and up.
          if (event.target === workspaceStatusFocus.anchorRef.current) setWorkspaceStatusRevealed(true);
        }}>
          <h2 ref={workspaceStatusFocus.anchorRef} tabIndex={-1} className={workspaceStatusRevealed ? "focus-anchor" : "visually-hidden focus-anchor"}>Workspace status</h2>
        {services.startupNotice && (
          <p role="status">{services.startupNotice}</p>
        )}
        {selectionChanged && (
          <div role="status">
            <p>The active archive has changed. This view and your unsent message remain here.</p>
            <button disabled={openingArchive || !!draft.length || state.busy || state.pendingMutation} onClick={() => void openSelectedArchive()}>
              {openingArchive ? 'Opening selected archive…' : 'Open selected archive'}
            </button>
            {!!draft.length && <p>Copy or clear your unsent message before opening the selected archive.</p>}
          </div>
        )}
        {sessionError && <p role="alert" className="error">{sessionError}</p>}
        {preference.error && <div role="alert" className="error">
          <p>{preference.error}</p>
          {section !== "preferences" && <button disabled={preference.busy} onClick={() => void preferences.refresh()}>Reload preferences</button>}
        </div>}
        {state.notice && <p role="status">{state.notice}</p>}
        {state.pendingRecovery && (
          <section aria-label="Pending change recovery" className="pending-recovery">
            <h3>Pending change</h3>
            <p>{state.pendingRecovery.threadTitle
              ? <>Conversation: <strong>{state.pendingRecovery.threadTitle}</strong>.</>
              : "A change in this archive is awaiting confirmation."}</p>
            <p role="status" aria-atomic="true">{state.pendingRecovery.checking
              ? "Checking the original change…"
              : state.pendingRecovery.message}</p>
            <button type="button" disabled={state.pendingRecovery.checking} onClick={() => void library.reconcile()}>
              Check pending change
            </button>
          </section>
        )}
        {state.error && (
          <div className="error" role="alert">
            <p>{state.error}</p>
            <button onClick={() => library.dismissError()}>Dismiss</button>
          </div>
        )}
        {state.loading && <p role="status">Opening your library…</p>}
        </section>
        {section === "preferences" && <>
          <PreferencesPanel controller={preferences} snapshot={preference} onboarding={{ completedAt: onboardingState.completedAt ?? null, busy: onboardingState.busy, showAgain: async () => { await onboarding.reset(); setSection("library"); } }} />
          <RoutingAliasesPanel controller={aliases} snapshot={aliasState} providers={providers} />
        </>}
        {section === 'documents' && <DocumentPanel controller={documents} workspaceId={state.workspaceId} />}
        {section === 'storage-health' && <>
          <section aria-label="Storage" className="storage-section"><h2>Storage</h2>
            <StorageStatus status={onboardingState.storage} busy={onboardingState.busy} onRequestPersistence={() => void onboarding.requestPersistentStorage()} onExportBackup={() => setSection("exports")} notice={onboardingState.notice} />
          </section>
          <DiagnosticsPanel controller={diagnostics} semantic={semantic} semanticState={semanticState} disabled={selectionChanged} />
          <StorageHealthPanel controller={storageHealth} cleanup={cleanup} disabled={selectionChanged} />
          <DoctorAuditPanel controller={doctorAudit} disabled={selectionChanged} />
          <BlobHashAuditPanel controller={hashAudit} disabled={selectionChanged} />
        </>}
        {section === 'semantic' && <SemanticPanel controller={semantic} snapshot={semanticState} />}
        {section === 'portability' && <MigrationPanel controller={migration} onOpen={threadId => { setSection('library'); void library.open(threadId); }} disabled={selectionChanged} />}
        {section === "imports" && state.workspaceId && (
          <ImportPanel
            storage={services.storage}
            host={services.host}
            archiveId={services.archiveId}
            workspaceId={state.workspaceId}
            onOpenThread={openImportedThread}
            onImportComplete={() => void library.refresh()}
          />
        )}
        {section === "exports" && <>
          <ExportPanel controller={exports} {...(restore ? { onReviewRestore: (jobId: string) => void restore.resume(jobId) } : {})} />
          {restore && <RestorePanel controller={restore} onOpenRestored={receipt => void openSelectedArchive(receipt.selected)} />}
        </>}
        {section === "providers" &&
          (settings ? (
            <ProviderSettingsPanel controller={settings} />
          ) : (
            <>
              <h1>Providers</h1>
              <p>This host has no provider setup configured.</p>
            </>
          ))}
        {section === "library" && (
          <>
            <form
              className="search"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                void runSearch(null);
              }}
            >
              {/* Mode precedes the query so the qualified keyboard path from the
                  field to the first result (Search → Close results → hit) is unchanged. */}
              <label htmlFor="search-mode">Search mode</label>
              <select id="search-mode" value={searchMode} onChange={(event) => setSearchMode(event.target.value as typeof searchMode)}>
                <option value="best">Best</option>
                <option value="exact">Exact</option>
                <option value="semantic">Semantic</option>
              </select>
              <label>
                Search your history
                <input
                  ref={searchRef}
                  value={query}
                  maxLength={4096}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find a conversation or document"
                />
              </label>
              <button>Search</button>
            </form>
            {searchNotice && <p role="status" className="search-notice">{searchNotice}</p>}
            {state.search && (
              <section aria-label="Search results" className="search-results">
                <div className="actions">
                  <h2>Search results</h2>
                  <button
                    onClick={() => {
                      library.clearSearch();
                      searchRef.current?.focus();
                    }}
                  >
                    Close results
                  </button>
                </div>
                <p data-testid="search-mode-used">
                  {state.search.modeUsed === "hybrid"
                    ? "Text and semantic matches"
                    : state.search.modeUsed === "semantic"
                      ? "Semantic matches"
                      : state.search.modeUsed === "best_lexical"
                        ? `Text matches · semantic search is unavailable${state.search.index.semantic.reason ? `: ${state.search.index.semantic.reason}` : ""}`
                        : "Text matches"}{" "}
                  · {state.search.index.pendingSources} sources awaiting
                  indexing
                </p>
                {state.search.items.length === 0 && (
                  <p className="search-empty" data-testid="search-empty">
                    No matches. Try fewer or different words, use quotes for an exact phrase, or check that indexing has finished.
                  </p>
                )}
                {state.search.items.map((hit) => (
                  <article key={hit.chunkId}>
                    <button
                      disabled={openingSearch || selectedContent.busy || (!hit.threadId && !hit.documentId)}
                      onClick={() => {
                        if (hit.documentId) { conversationSearch.clear(); setSection('documents'); void documents.openHit(hit); }
                        else if (hit.threadId) void openConversationHit(hit);
                      }}
                    >
                      {hit.title || (hit.documentId ? 'Untitled document' : 'Untitled conversation')}
                    </button>
                    <p className="excerpt">{hit.excerpt.text}</p>
                    <small>{hit.explanation}</small>
                    {hit.position.page !== null && <small> · Page {hit.position.page}</small>}
                  </article>
                ))}
                {!state.search.items.length && <p>No indexed matches.</p>}
                {state.search.nextCursor && (
                  <button
                    onClick={() => void runSearch(state.search!.nextCursor)}
                  >
                    Next results
                  </button>
                )}
              </section>
            )}
            {(selectedContent.busy || openingSearch) && <p role="status">Opening the matching message content…</p>}
            {selectedContent.error && <p role="alert">{selectedContent.error}</p>}
            {!state.thread && !state.loading && onboardingState.loaded && onboardingState.completedAt === null && (
              <OnboardingPanel controller={onboarding} snapshot={onboardingState} semantic={semantic} semanticState={semanticState}
                providersConfigured={services.providerSettings?.connections.length ?? providers.length}
                navigate={{ imports: () => setSection("imports"), exports: () => setSection("exports"), providers: () => setSection("providers"), semantic: () => setSection("semantic"), extension: () => setSection("imports") }} />
            )}
            {!state.thread && !state.loading && (
              <section className="welcome">
                <p className="eyebrow">A home for your conversations</p>
                <h1>Pick up where you left off.</h1>
                <p>
                  Import your history, find an old idea, or start a conversation
                  with a provider of your choice.
                </p>
                <div className="actions">
                  <button
                    className="primary"
                    disabled={openingArchive || selectionChanged}
                    onClick={() => void library.create()}
                  >
                    Start a conversation
                  </button>
                  <button onClick={() => setSection("imports")}>
                    Import history
                  </button>
                </div>
              </section>
            )}
            {state.thread && (
              <>
                <header className="conversation-header">
                  <h1 ref={conversationHeadingRef} data-thread-id={state.thread.thread.id} tabIndex={-1} className="focus-anchor">{state.thread.state.title || "Untitled conversation"}</h1>
                  <p className="muted conversation-usage">
                    {describeThreadUsage(state.thread.usage)}
                  </p>
                  {portabilityView && (
                    <section className="portability" aria-label="Portability">
                      <p className="muted">
                        Portability: {portabilityView.label}. {portabilityView.summary}
                      </p>
                      <ul aria-label="Portability reasons">
                        {portabilityView.reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {state.events.length > 0 && (
                    <ul className="thread-events" aria-label="Conversation events">
                      {state.events.map((event) => (
                        <li key={event.id}>
                          {describeThreadEvent(
                            event,
                            (providerId) =>
                              providers.find((value) => value.id === providerId)?.label ?? providerId,
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <ThreadDetails
                    key={state.thread.thread.id}
                    library={library}
                    state={state}
                  />
                </header>
                {!openingSearch && selectedContent.focus && selectedContent.focus.threadId === state.thread.thread.id && state.messages.some(item => item.message.id === selectedContent.focus!.messageId) &&
                  <ConversationSearchFocus focus={selectedContent.focus} access={content} onClose={() => { conversationSearch.clear(); searchRef.current?.focus(); }} />}
                <div className="actions">
                  <button
                    disabled={!state.older}
                    onClick={() => { conversationSearch.clear(); void library.older(); }}
                  >
                    Older messages
                  </button>
                  <button onClick={() => { conversationSearch.clear(); void library.latest(); }}>
                    Latest messages
                  </button>
                  <button onClick={() => void library.branches(null)}>
                    Show starting branches
                  </button>
                </div>
                <section
                  aria-label="Conversation messages"
                  className="messages"
                  aria-busy={state.busy}
                >
                  {state.messages.length === 0 && !state.busy && (
                    <p className="messages-empty muted" data-testid="messages-empty">
                      No messages yet. Write the first message below; it is saved on this device as soon as you send it.
                    </p>
                  )}
                  {state.messages.map((item, messageIndex) => (
                    <article
                      className={`message ${item.message.role}`}
                      key={item.message.id}
                      data-message-id={item.message.id}
                      aria-label={`${item.message.role === "user" ? "You" : item.message.role === "assistant" ? "Assistant" : item.message.role}, message ${messageIndex + 1} on this page`}
                    >
                      <header>
                        <strong>
                          {item.message.role === "user"
                            ? "You"
                            : item.message.role === "assistant"
                              ? "Assistant"
                              : item.message.role}
                        </strong>
                        {item.generation && (
                          <small>
                            {preference.value.showModelBadges && <><span className="model-badge">{item.generation.provider ?? "Unknown provider"} · {item.generation.model ?? "Unknown model"}</span>{" · "}</>}
                            {item.generation.status}
                          </small>
                        )}
                        {preference.value.showTimestamps && <MessageTimestamp message={item.message} />}
                      </header>
                      {displayParts(item.parts, !!item.generation).map(
                        (part) => (
                          <ContentPartView
                            key={part.id}
                            part={part}
                            access={content}
                          />
                        ),
                      )}
                      {item.parts.some(internalProvenance) && (
                        <details>
                          <summary>Response source records</summary>
                          {item.parts.filter(internalProvenance).map((part) => (
                            <ContentPartView
                              key={part.id}
                              part={part}
                              access={content}
                            />
                          ))}
                        </details>
                      )}
                      {!item.parts.length && (
                        <p>
                          {item.message.sealed
                            ? "No displayable content."
                            : "Waiting for response…"}
                        </p>
                      )}
                      {item.generation && (
                        <p className="muted attempt-usage">
                          {describeAttemptUsage(item.generation)}
                        </p>
                      )}
                      {item.message.role === "user" &&
                        item.message.sealed &&
                        !item.nextParts &&
                        item.parts.every(
                          (part) => part.kind === "Text" && !part.data.textBlob,
                        ) &&
                        item.parts.reduce(
                          (sum, part) =>
                            sum +
                            (part.kind === "Text"
                              ? (part.data.text ?? "").length
                              : 0),
                          0,
                        ) <= 16384 && (
                          <MessageEdit
                            message={item.message}
                            text={item.parts
                              .map((part) =>
                                part.kind === "Text"
                                  ? (part.data.text ?? "")
                                  : "",
                              )
                              .join("")}
                            library={library}
                            disabled={state.pendingMutation || state.busy}
                            onSaved={focusComposer}
                            contextLabel={`${item.message.role === "user" ? "You" : item.message.role}, message ${messageIndex + 1} on this page`}
                          />
                        )}
                      <div className="actions message-actions">
                        <button
                          aria-label={`Quote in reply — ${item.message.role === "user" ? "You" : item.message.role === "assistant" ? "Assistant" : item.message.role}, message ${messageIndex + 1} on this page`}
                          type="button"
                          disabled={!item.message.sealed || openingSearch}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={(event) =>
                            quote(item, event.currentTarget.closest("article"))
                          }
                        >
                          Quote in reply
                        </button>
                        <button
                          aria-label={`First parts — ${item.message.role === "user" ? "You" : item.message.role === "assistant" ? "Assistant" : item.message.role}, message ${messageIndex + 1} on this page`}
                          onClick={() => {
                            conversationSearch.clear();
                            void library.moreParts(item.message.id, true);
                          }}
                        >
                          First parts
                        </button>
                        {item.nextParts && (
                          <button
                          aria-label={`Next parts — ${item.message.role === "user" ? "You" : item.message.role === "assistant" ? "Assistant" : item.message.role}, message ${messageIndex + 1} on this page`}
                            onClick={() => {
                              conversationSearch.clear();
                              void library.moreParts(item.message.id);
                            }}
                          >
                            Next parts
                          </button>
                        )}
                        <button
                          aria-label={`Sibling branches — ${item.message.role === "user" ? "You" : item.message.role === "assistant" ? "Assistant" : item.message.role}, message ${messageIndex + 1} on this page`}
                          onClick={() =>
                            void library.branches(item.message.parentId)
                          }
                        >
                          Sibling branches
                        </button>
                        <button
                          aria-label={`Continue from here — ${item.message.role === "user" ? "You" : item.message.role === "assistant" ? "Assistant" : item.message.role}, message ${messageIndex + 1} on this page`}
                          disabled={
                            state.pendingMutation ||
                            state.busy ||
                            !item.message.sealed
                          }
                          onClick={() =>
                            void library.selectBranch(item.message.id)
                          }
                        >
                          Continue from here
                        </button>
                        {item.message.role === "user" && (
                          <button
                          aria-label={`Generate another response — ${item.message.role === "user" ? "You" : item.message.role === "assistant" ? "Assistant" : item.message.role}, message ${messageIndex + 1} on this page`}
                            disabled={
                              !provider ||
                              !model ||
                              !validSettings ||
                              state.busy ||
                              state.pendingMutation ||
                              invalidRoutingCost ||
                              !targetModel ||
                              switchBlocks
                            }
                            onClick={() => {
                              regenerate(item.message);
                              focusComposer();
                            }}
                          >
                            Generate another response
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </section>
                <section className="branches" aria-label="Branch choices">
                  <h2>
                    {state.branchParent
                      ? "Branch continuations"
                      : "Starting branches"}
                  </h2>
                  {state.branches.items.map((branch) => (
                    <button
                      key={branch.id}
                      disabled={state.pendingMutation || state.busy}
                      onClick={() => void library.selectBranch(branch.id)}
                    >
                      {branch.role} ·{" "}
                      {new Date(
                        branch.createdAt ?? branch.recordedAt,
                      ).toLocaleString()}{" "}
                      · {branch.id.slice(0, 8)}
                    </button>
                  ))}
                  {!state.branches.items.length && (
                    <p className="muted">No further branches here.</p>
                  )}
                  {state.branches.nextCursor && (
                    <button
                      onClick={() =>
                        void library.branches(
                          state.branchParent,
                          state.branches.nextCursor,
                        )
                      }
                    >
                      More branches
                    </button>
                  )}
                </section>
                <form
                  className={dropping ? "composer dropping" : "composer"}
                  data-layout={preference.value.composerLayout}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                  }}
                  onDragOver={(event) => {
                    if (!hasFiles(event.dataTransfer)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    setDropping(true);
                  }}
                  onDragLeave={(event) => {
                    if (
                      !event.currentTarget.contains(
                        event.relatedTarget as Node | null,
                      )
                    )
                      setDropping(false);
                  }}
                  onDrop={(event) => {
                    if (!hasFiles(event.dataTransfer)) return;
                    event.preventDefault();
                    setDropping(false);
                    if (state.busy || state.pendingMutation || !attachmentMediaTypes.length)
                      return;
                    void attachments.adopt(
                      Array.from(event.dataTransfer.files).map(adoptableFile),
                      attachmentMediaTypes,
                    );
                  }}
                >
                  <div className="composer-options">
                    <label>
                      Provider
                      <select
                        aria-label="Provider"
                        value={provider?.id ?? ""}
                        onChange={(event) => {
                          const next = providers.find(value => value.id === event.target.value);
                          if (next?.models[0]) selectPrimary(next.id, next.models[0].id);
                        }}
                        disabled={state.busy || state.pendingMutation || routingSaving}
                      >
                        {primary && !provider && <option value="">{primary.provider} (not configured)</option>}
                        {!providers.length && !primary && (
                          <option value="">Connect a provider</option>
                        )}
                        {providers.map((value) => (
                          <option value={value.id} key={value.id}>
                            {value.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <ModelSwitcher style={preference.value.modelSwitcherStyle}
                      models={provider?.models ?? []} selected={model?.id ?? ""}
                      placeholder={primary && !model ? `${primary.model} (not configured)` : "No model selected"}
                      disabled={state.busy || state.pendingMutation || routingSaving}
                      onSelect={modelId => { if (provider) selectPrimary(provider.id, modelId); }} />
                    {supportsOutputLimit && (
                      <label>
                        Maximum output tokens
                        <input
                          type="number"
                          aria-label="Maximum output tokens"
                          min={1}
                          max={capabilities?.maxOutputTokens ?? undefined}
                          step={1}
                          value={outputLimit}
                          onChange={(event) =>
                            setOutputLimit(event.target.value)
                          }
                          disabled={state.busy}
                          aria-invalid={!validOutputLimit}
                          aria-describedby="output-limit-help"
                        />
                        <small id="output-limit-help">
                          {capabilities?.maxOutputTokens == null
                            ? "Enter a positive whole number. The model’s maximum is unknown."
                            : `Enter 1–${capabilities.maxOutputTokens.toLocaleString()} tokens for this model.`}
                        </small>
                      </label>
                    )}
                    {supportsTemperature && (
                      <label>
                        Temperature
                        <input
                          type="number"
                          inputMode="decimal"
                          aria-label="Temperature"
                          min={0}
                          max={temperatureMax}
                          step={0.1}
                          value={temperature}
                          onChange={(event) =>
                            setTemperature(event.target.value)
                          }
                          disabled={state.busy}
                          aria-invalid={!temperatureSetting.valid}
                          aria-describedby="temperature-help"
                        />
                        <small id="temperature-help">
                          {`Leave blank for the model default, or enter 0–${temperatureMax}.`}
                        </small>
                      </label>
                    )}
                    {supportsTopP && (
                      <label>
                        Top-p
                        <input
                          type="number"
                          inputMode="decimal"
                          aria-label="Top-p"
                          min={0}
                          max={1}
                          step={0.05}
                          value={topP}
                          onChange={(event) => setTopP(event.target.value)}
                          disabled={state.busy}
                          aria-invalid={!topPSetting.valid}
                          aria-describedby="top-p-help"
                        />
                        <small id="top-p-help">
                          Leave blank for the model default, or enter 0–1.
                        </small>
                      </label>
                    )}
                    {supportsStopSequences && (
                      <label>
                        Stop sequences
                        <textarea
                          aria-label="Stop sequences"
                          rows={2}
                          value={stopSequences}
                          onChange={(event) =>
                            setStopSequences(event.target.value)
                          }
                          disabled={state.busy}
                          aria-invalid={!validStopSequences}
                          aria-describedby="stop-sequences-help"
                        />
                        <small id="stop-sequences-help">
                          One per line, up to 4 sequences of 1,024 characters.
                          Blank lines are ignored.
                        </small>
                      </label>
                    )}
                    {supportsThinking && (
                      <label>
                        Thinking budget
                        <input
                          type="number"
                          inputMode="numeric"
                          aria-label="Thinking budget"
                          min={1024}
                          step={256}
                          value={thinkingBudget}
                          onChange={(event) =>
                            setThinkingBudget(event.target.value)
                          }
                          disabled={state.busy}
                          aria-invalid={thinkingProblem !== null}
                          aria-describedby="thinking-budget-help"
                        />
                        <small id="thinking-budget-help">
                          {thinkingProblem ??
                            "Leave blank to keep thinking off, or enter at least 1,024 tokens below the output limit. Thinking tokens count toward the output limit and are billed as output; temperature is unavailable and top-p must be 0.95–1 while it is on."}
                        </small>
                      </label>
                    )}
                  </div>
                  {provider && (
                    <p
                      className="connection-health"
                      data-health={connectionHealth.status}
                    >
                      <strong>{provider.label}:</strong>{" "}
                      {connectionHealth.label}
                      {connectionHealth.detail && ` · ${connectionHealth.detail}`}
                      {connectionHealth.status === "authentication_expired" && (
                        <>
                          {" "}
                          <button
                            type="button"
                            onClick={() => setSection("providers")}
                          >
                            Open Providers
                          </button>
                        </>
                      )}
                    </p>
                  )}
                  {routeSummary && (
                    <p className="muted route-plan">{routeSummary}</p>
                  )}
                  {state.thread && (providers.length > 0 || routingProfile) && (
                    <RoutingProfileRegion>
                      <label htmlFor="fallback-candidate">Fallback candidate</label>
                      <select
                        id="fallback-candidate"
                        value={candidateDraft}
                        disabled={state.busy || state.pendingMutation || routingSaving}
                        onChange={(event) => setCandidateDraft(event.target.value)}
                      >
                        <option value="">Choose a connection and model</option>
                        {providers.flatMap((value) =>
                          value.models
                            .filter(
                              (item) =>
                                !(provider && value.id === provider.id && model && item.id === model.id) &&
                                !(routingProfile?.candidates ?? []).some(
                                  (existing) => existing.provider === value.id && existing.model === item.id,
                                ),
                            )
                            .map((item) => (
                              <option key={`${value.id}:${item.id}`} value={`${value.id}:${item.id}`}>
                                {value.label} · {item.name}
                              </option>
                            )),
                        )}
                      </select>{" "}
                      <button
                        type="button"
                        disabled={
                          !candidateDraft ||
                          state.busy ||
                          state.pendingMutation ||
                          (routingProfile?.candidates.length ?? 0) >= ROUTING_CANDIDATE_LIMIT
                        }
                        onClick={() => {
                          const [providerId, ...rest] = candidateDraft.split(":");
                          const modelId = rest.join(":");
                          if (!providerId || !modelId) return;
                          patchRoutingProfile({
                            candidates: [
                              ...(routingProfile?.candidates ?? []),
                              { provider: providerId, model: modelId },
                            ],
                          });
                          setCandidateDraft("");
                        }}
                      >
                        Add candidate
                      </button>
                      {!!routingProfile?.candidates.length && (
                        <ol aria-label="Fallback candidates">
                          {routingProfile.candidates.map((item, index) => (
                            <li key={`${item.provider}:${item.model}`}>
                              {describeCandidate(routeCandidate(item))}
                              {!routeCandidate(item).model && " (not configured)"}{" "}
                              <button
                                aria-label={`Remove fallback ${index + 1}: ${describeCandidate(routeCandidate(item))}`}
                                type="button"
                                disabled={state.busy || state.pendingMutation || routingSaving}
                                onClick={() =>
                                  patchRoutingProfile({
                                    candidates: routingProfile.candidates.filter((_, at) => at !== index),
                                  })
                                }
                              >
                                Remove
                              </button>
                            </li>
                          ))}
                        </ol>
                      )}
                      <label>
                        <input
                          type="checkbox"
                          checked={routingProfile?.requirements.tools ?? false}
                          disabled={state.busy || state.pendingMutation || routingSaving}
                          onChange={(event) =>
                            patchRoutingProfile({
                              requirements: {
                                ...(routingProfile?.requirements ?? {}),
                                ...(event.target.checked ? { tools: true } : {}),
                              },
                            })
                          }
                        />{" "}
                        Require tool support
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={routingProfile?.requirements.images ?? false}
                          disabled={state.busy || state.pendingMutation || routingSaving}
                          onChange={(event) => {
                            const { images: _images, ...rest } = routingProfile?.requirements ?? {};
                            patchRoutingProfile({
                              requirements: { ...rest, ...(event.target.checked ? { images: true } : {}) },
                            });
                          }}
                        />{" "}
                        Require image input
                      </label>
                      <label htmlFor="processing-region">Required processing region</label>
                      <select id="processing-region" aria-label="Required processing region" value={routingProfile?.requirements.processingRegion ?? ""}
                        disabled={state.busy || state.pendingMutation || routingSaving}
                        onChange={event => {
                          const value = event.target.value;
                          const { processingRegion: _region, ...rest } = routingProfile?.requirements ?? {};
                          if (value === "" || value === "us" || value === "eu") patchRoutingProfile({ requirements: { ...rest, ...(value ? { processingRegion: value } : {}) } });
                        }}>
                        <option value="">Unrestricted</option><option value="us">United States</option><option value="eu">Europe (EEA + Switzerland)</option>
                      </select>
                      {routingProfile?.requirements.processingRegion && <p>This requirement applies to submitted conversation content, including token counting, summaries and every fallback. Connections with unknown or different processing regions are refused. It does not describe all account data or data at rest.</p>}
                      <label htmlFor="request-cost-cap">Maximum estimated request cost per attempt (USD)</label>
                      <input id="request-cost-cap" inputMode="decimal" maxLength={19}
                        value={routingDrafts.requestCost} disabled={state.busy || state.pendingMutation || routingSaving}
                        aria-invalid={routingDrafts.requestCost.trim() !== "" && !/^\d{1,9}(\.\d{1,9})?$/.test(routingDrafts.requestCost.trim())}
                        onChange={event => setRoutingDrafts(value => ({ ...value, requestCost: event.target.value }))}
                        onBlur={event => {
                          const value = event.target.value.trim();
                          if (value !== "" && !/^\d{1,9}(\.\d{1,9})?$/.test(value)) { setSessionError("Enter an estimated request cost with at most nine digits on either side of the decimal point. The saved limit is unchanged."); return; }
                          setSessionError(null);
                          const { maxEstimatedRequestCost: _cap, ...rest } = routingProfile?.requirements ?? {};
                          if (value !== (routingProfile?.requirements.maxEstimatedRequestCost ?? ""))
                            patchRoutingProfile({ requirements: { ...rest, ...(value ? { maxEstimatedRequestCost: value } : {}) } });
                        }} />
                      {(routingProfile?.requirements.maxEstimatedRequestCost !== undefined || routingProfile?.requirements.maxRequestCost !== undefined) &&
                        <p>Each attempt, including fallback and summaries, must fit its cost limits. Without a matching token count, the input budget uses the full model context window. Count explicitly for a tighter estimate; counting sends the prompt to the selected provider. Output uses the selected token limit. Estimates exclude cache discounts and are not a billing guarantee or a combined retry budget.</p>}
                      <label htmlFor="context-at-least">Minimum context window</label>
                      <input
                        id="context-at-least"
                        type="number"
                        min={0}
                        step={1}
                        value={routingDrafts.context}
                        disabled={state.busy || state.pendingMutation || routingSaving}
                        onChange={(event) =>
                          setRoutingDrafts((current) => ({ ...current, context: event.target.value }))
                        }
                        onBlur={(event) => {
                          const value = Number(event.target.value);
                          const { contextAtLeast: _context, ...rest } = routingProfile?.requirements ?? {};
                          const next =
                            event.target.value.trim() && Number.isSafeInteger(value) && value > 0
                              ? { ...rest, contextAtLeast: value }
                              : rest;
                          if (JSON.stringify(next) !== JSON.stringify(routingProfile?.requirements ?? {}))
                            patchRoutingProfile({ requirements: next });
                        }}
                      />
                      <label htmlFor="max-request-cost">Maximum estimated input cost (USD)</label>
                      <input
                        id="max-request-cost"
                        type="text"
                        inputMode="decimal"
                        maxLength={19}
                        aria-invalid={routingDrafts.cost.trim() !== "" && !/^\d{1,9}(\.\d{1,9})?$/.test(routingDrafts.cost.trim())}
                        value={routingDrafts.cost}
                        disabled={state.busy || state.pendingMutation || routingSaving}
                        onChange={(event) =>
                          setRoutingDrafts((current) => ({ ...current, cost: event.target.value }))
                        }
                        onBlur={(event) => {
                          const value = event.target.value.trim();
                          if (value && !/^\d{1,9}(\.\d{1,9})?$/.test(value)) {
                            setSessionError("Enter an estimated input cost with at most nine digits on either side of the decimal point. The saved routing requirement is unchanged.");
                            return;
                          }
                          const { maxRequestCost: _cost, ...rest } = routingProfile?.requirements ?? {};
                          const next = /^\d+(\.\d+)?$/.test(value) ? { ...rest, maxRequestCost: value } : rest;
                          if (JSON.stringify(next) !== JSON.stringify(routingProfile?.requirements ?? {}))
                            patchRoutingProfile({ requirements: next });
                        }}
                      />
                      <label>
                        <input
                          type="checkbox"
                          checked={routingProfile?.allowPrivacyChange ?? false}
                          disabled={state.busy || state.pendingMutation || routingSaving}
                          onChange={(event) =>
                            patchRoutingProfile({ allowPrivacyChange: event.target.checked })
                          }
                        />{" "}
                        Allow the route to change the privacy class
                      </label>
                      <label htmlFor="route-alias">Profile name</label>
                      <input
                        id="route-alias"
                        type="text"
                        maxLength={64}
                        value={routingDrafts.alias}
                        disabled={state.busy || state.pendingMutation || routingSaving}
                        onChange={(event) =>
                          setRoutingDrafts((current) => ({ ...current, alias: event.target.value }))
                        }
                        onBlur={(event) => {
                          const alias = event.target.value.trim() || null;
                          if (alias !== (routingProfile?.alias ?? null)) patchRoutingProfile({ alias });
                        }}
                      />
                    </RoutingProfileRegion>
                  )}
                  {switching && target && targetModel && origin && (
                    <section
                      className="switch-report"
                      aria-label="Compatibility report"
                    >
                      <CompatibilityAnnouncement
                        scope={`${state.thread!.thread.id}:${state.thread!.context.id}:${state.leaf}:${target.id}:${targetModel.id}`}
                        outcome={inspection ? `Last completed compatibility check for ${target.label} · ${targetModel.name}: ${!inspection.report.sendable || (switchContext?.overRoomBy ?? 0) > 0 ? "sending blocked" : consequential ? "review required before sending" : "compatible"}.${inspection.report.blocked.length ? " Unsupported content is listed in the report." : ""}${inspection.report.constraints.length ? " Request constraints are listed in the report." : ""}${(switchContext?.overRoomBy ?? 0) > 0 ? " The counted prompt exceeds the available context." : ""}` : switchInspection?.key === switchKey && switchInspection.error ? `Last completed compatibility check for ${target.label} · ${targetModel.name}: inspection failed. Review the error below.` : null}
                      />
                      <h3>
                        Switching to {target.label} · {targetModel.name}
                      </h3>
                      {inspection && switchSummary ? (
                        <>
                          <p>
                            Preserved: {switchSummary.preserved} parts (
                            {Object.entries(inspection.report.preserved.byKind)
                              .map(([kind, count]) => `${count} ${kind}`)
                              .join(", ") || "none"}
                            ) · Transformed: {switchSummary.transformed} · Omitted:{" "}
                            {switchSummary.omitted} · Blocked: {switchSummary.blocked}
                            {inspection.report.requestBytes !== null &&
                              ` · Request ${inspection.report.requestBytes.toLocaleString()} bytes`}
                          </p>
                          {switchSummary.transformed > 0 && (
                            <p>
                              Transformed: {describeTransformations(inspection.transformed).join("; ")}.
                            </p>
                          )}
                          {switchSummary.omitted > 0 && (
                            <p>
                              {inspection.omitted.emptyAssistant} empty responses and{" "}
                              {inspection.omitted.internalProvenance} internal provider
                              records are never sent.
                            </p>
                          )}
                          {inspection.report.blocked.map((item) => (
                            <p key={item.partId ?? item.code}>
                              Blocked {item.kind ?? "part"}: {item.message}
                            </p>
                          ))}
                          {inspection.report.constraints.map((item) => (
                            <p key={item.code}>
                              {item.message}
                            </p>
                          ))}
                          {switchContext?.lines.map((line) => (
                            <p
                              key={line}
                              className="switch-context"
                            >
                              {line}
                            </p>
                          ))}
                          {privacyFrom !== privacyTo && (
                            <p>
                              Privacy class changes from {privacyLabel(privacyFrom)} to{" "}
                              {privacyLabel(privacyTo)}.
                            </p>
                          )}
                          {target.id !== origin.provider && (
                            <p>Your conversation will be sent to a different provider.</p>
                          )}
                          {origin.imported && (
                            <p>
                              This conversation was imported from {origin.provider}. Its
                              original history stays unchanged; only the active path is
                              sent.
                            </p>
                          )}
                          {consequential && inspection.report.sendable && (
                            <label>
                              <input
                                type="checkbox"
                                checked={switchReviewed === reviewKey}
                                onChange={(event) =>
                                  setSwitchReviewed(event.target.checked ? reviewKey : null)
                                }
                              />{" "}
                              I reviewed this switch and want to continue with{" "}
                              {target.label}
                            </label>
                          )}
                        </>
                      ) : switchInspection?.key === switchKey && switchInspection.error ? (
                        <p>{switchInspection.error}</p>
                      ) : (
                        <p>Inspecting the active branch…</p>
                      )}
                    </section>
                  )}
                  {provider && model && !supportsOutputLimit && (
                    <p>
                      This connection does not have a supported output limit.
                      Choose another model before sending.
                    </p>
                  )}
                  {unsupportedRouting && <p role="alert">This conversation has an unsupported routing profile. Apply a reviewed alias or <button type="button" disabled={state.busy || state.pendingMutation || routingSaving} onClick={() => setRoutingProfile(null)}>Reset routing profile</button> before sending.</p>}
                  {primary && (!provider || !model) && <p role="status">Saved primary {primary.provider} · {primary.model} is not configured on this device. Connect it or deliberately choose another primary.</p>}
                  {routingProfile?.aliasSource && <p>Applied routing alias: {routingProfile.alias}</p>}
                  {routingSaving && <p role="status">Saving routing profile…</p>}
                  <section aria-label="Request context">
                    <p>{state.thread!.context.compaction?.excludedPartIds.length ?? 0} attachment occurrence(s) excluded from future requests. Originals remain in history.</p>
                    <button type="button" disabled={state.busy || state.pendingMutation || compactionSaving || selectionChanged} onClick={() => {
                      const view = state.thread!;
                      void compaction.open({ threadId: view.thread.id, revision: view.state.revision, contextId: view.context.id, leaf: state.leaf }, view.context.compaction?.excludedPartIds ?? []);
                    }}>Review attachment exclusions</button>
                    <AttachmentCompaction controller={compaction} disabled={state.busy || state.pendingMutation || compactionSaving || selectionChanged} apply={ids => {
                      const scope = compaction.getSnapshot().scope;
                      if (!scope || compactionSaving || state.busy || state.pendingMutation) return;
                      setCompactionSaving(true); setSwitchReviewed(null); setPromptCount(null);
                      void library.excludeAttachments(scope, ids).finally(() => { setCompactionSaving(false); compaction.cancel(); });
                    }} />
                  </section>
                  <SummaryCompaction controller={summaries} context={state.thread!.context} provider={validSettings ? provider : undefined} modelId={model?.id} parameters={generationSettings} disabled={state.busy || state.pendingMutation || compactionSaving || invalidRoutingCost || selectionChanged} />
                  <FreshBranch snapshot={state} disabled={state.busy || state.pendingMutation || compactionSaving || routingSaving || selectionChanged || staged.busy || openingSearch}
                    apply={scope => {
                      setBranchSaving(true); setSwitchReviewed(null); setPromptCount(null);
                      void library.startContextBranch(scope).finally(() => { setBranchSaving(false); });
                    }} />
                  <ApplyRoutingAlias key={state.thread!.thread.id} snapshot={aliasState} providers={providers}
                    disabled={state.busy || state.pendingMutation || routingSaving || selectionChanged || openingSearch}
                    apply={(alias, revision) => {
                      saveRoutingProfile(routingAliasSnapshot(alias, revision));
                    }} />
                  {!provider && (
                    <p>
                      <button
                        type="button"
                        onClick={() => setSection("providers")}
                      >
                        Connect a provider to send messages
                      </button>
                    </p>
                  )}
                  <label>
                    Message
                    <textarea
                      ref={messageRef}
                      aria-label="Message"
                      disabled={openingSearch}
                      value={draft}
                      maxLength={16384}
                      rows={preference.value.composerLayout === 'compact' ? 2 : 4}
                      onChange={(event) => {
                        setQuoteNotice(null);
                        setPromptCount(null);
                        setDraft(event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (isSendKey(event.nativeEvent, preference.value.sendKey, composingRef.current)) {
                          event.preventDefault();
                          if (preference.ready && !preference.busy && !state.busy && !state.pendingMutation)
                            void send();
                        }
                      }}
                      onCompositionStart={() => { composingRef.current = true; }}
                      onCompositionEnd={() => { composingRef.current = false; }}
                      onBlur={() => { composingRef.current = false; }}
                      placeholder="Continue the conversation…"
                    />
                  </label>
                  <ComposerAttachmentsView
                    controller={attachments}
                    snapshot={staged}
                    disabled={
                      state.busy || state.pendingMutation || openingSearch
                    }
                    imagesSupported={imagesSupported}
                    fileMediaTypes={fileMediaTypes}
                    audioMediaTypes={audioMediaTypes}
                  />
                  {quoteNotice && <p role="alert">{quoteNotice}</p>}
                  {promptCount && (
                    <p className="muted prompt-count">
                      {promptCount.kind === "counted"
                        ? `Prompt: ${promptCount.tokens.toLocaleString()} tokens counted by ${promptCount.label} for this draft and branch.`
                        : `Token counting is unavailable for this connection: ${promptCount.reason}`}
                    </p>
                  )}
                  <div className="actions">
                    <small>{!preference.ready ? "Keyboard sending unavailable while preferences load" : preference.value.sendKey === "enter" ? "Enter to send · Shift + Enter for a new line" : "⌘ / Ctrl + Enter to send"}</small>
                    <button
                      type="button"
                      onClick={() => void countPrompt()}
                      disabled={
                        counting ||
                        state.pendingMutation ||
                        selectionChanged ||
                        unsupportedRouting ||
                        routingSaving ||
                        compactionSaving ||
                        state.busy ||
                        !provider ||
                        !model ||
                        !validSettings ||
                        (!draft.trim() && !staged.items.length) ||
                        staged.busy
                      }
                    >
                      {counting ? "Counting…" : "Count prompt tokens"}
                    </button>
                    {state.busy ? (
                      <button
                        type="button"
                        onClick={() => void (summaryState.busy ? summaries.cancel() : chat.stop()).then(focusComposer)}
                        disabled={branchSaving}
                      >
                        {branchSaving ? 'Starting branch…' : summaryState.busy ? 'Stop summary operation' : 'Stop response'}
                      </button>
                    ) : (
                      <button
                        className="primary"
                        disabled={
                          !provider ||
                          !model ||
                          !validSettings ||
                          (!draft.trim() && !staged.items.length) ||
                          staged.busy ||
                          openingSearch ||
                          state.pendingMutation ||
                          unsupportedRouting ||
                          routingSaving ||
                          compactionSaving ||
                          invalidRoutingCost ||
                          !targetModel ||
                          switchBlocks
                        }
                      >
                        Send message
                      </button>
                    )}
                  </div>
                  <p
                    className="generation-status"
                    role="status"
                    aria-live="polite"
                  >
                    {state.busy
                      ? "Response in progress. Committed text is saved as it arrives."
                      : state.messages.at(-1)?.generation
                        ? `Response ${state.messages.at(-1)!.generation!.status}.`
                        : ""}
                  </p>
                </form>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
