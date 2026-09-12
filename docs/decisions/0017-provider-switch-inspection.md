# ADR 0017 — Provider switching: compatibility reports and recorded switches

Date: 2026-09-09  
Status: Accepted for the first slice described here; the routing, compaction and fallback decisions remain open and are listed under "Not decided here".

## Context

[Plan 10](../plans/10_add_routing_and_provider_switching.md) lets a user continue
a conversation with another provider while inspecting what the new request
carries, what it changes, what it drops and what it cannot carry, and records
that switch as a thread event ([product §22](../product.md#22-thread-events),
[§35](../product.md#35-privacy-classes), [§36](../product.md#36-compatibility-inspector)).

What already existed before this slice, each with evidence:

- The [request mapper](../../packages/providers/src/request.ts) turns the
  canonical parts of an active path into one provider request and refuses the
  whole request with a `CompatibilityError` listing every issue at once
  ([providers README](../../packages/providers/README.md)). It never rewrites a part into
  another kind: an unmappable part is refused, not converted.
- The [chat workflow](../../packages/app/src/workflows/chat.ts) decides, before
  the adapter sees anything, which parts a request never carries: internal
  provider provenance records and assistant turns that were left empty by a
  failed or stopped attempt. It also inlines long text parts from their stored
  bytes ([ADR 0013](./0013-streaming-text-and-provenance.md)).
- The canonical schema records `ThreadEvent` rows (`events` table, schema 8) and
  the storage worker accepts a `CreateThreadEvent` mutation in the same
  transaction as any other canonical mutation ([ADR 0004](./0004-canonical-history.md)).
- Every configured connection reports a host-declared privacy class
  ([ADR 0011](./0011-provider-account-setup.md)) and records account health from
  what the provider last answered ([plan 06](../plans/06_integrate_live_providers.md)).

The product text describes transformations such as "2 tool calls converted to
text". No adapter performs such a conversion today, so the first slice reports
exactly what the code does and nothing it does not.

## Decisions

### 1. The compatibility report is the request mapper, not a parallel model

`analyzeCompatibility` runs the same `map` function that `prepare` runs and
returns a `CompatibilityReport` instead of throwing: the target protocol and
model, the parts the request carries counted by kind, the parts it refuses with
the mapper's own issue code and message, request-level constraints (unregistered
model, unsupported system prompt, request size), the encoded request size and a
single `sendable` flag. Because the report and the sent request come from one
mapping of one input, the reviewed report cannot disagree with the transmitted
request; there is no second implementation to drift. `ProviderAdapter.analyze`
exposes this for any protocol.

### 2. Omissions and transformations decided before mapping belong to the workflow

The workflow's `context` builder now counts what it omits (internal provenance
parts, empty assistant turns) and what it transforms (text parts inlined from
their stored bytes). `inspectSwitch` returns the adapter's report together with
these counts for the active branch, so the composer can show preserved,
transformed, omitted and blocked figures that add up to the parts on the path.
The inspection reads the branch and commits nothing.

### 3. A switch is a change of connection or model relative to the last attempt

The composer treats the selected connection or model as a switch when it differs
from the provider or model of the last generation attempt on the active path.
The report is computed for the active branch. Regenerating an earlier turn under
a switch is gated by the same review even though its request is a prefix of the
inspected path; a blocked part later in the branch therefore blocks a
regeneration that would map cleanly. This is deliberately conservative for the
first slice and is recorded as a limitation in plan 10.

### 4. Consequential switches need a review scoped to the exact report

A switch is consequential when the connection changes, the privacy class
changes, or the report shows anything transformed, omitted or blocked. A
consequential switch cannot be sent until the user ticks a review whose key is
the thread, leaf, target connection and model, message count, the four counts,
both privacy classes and the blocked issue codes. Any change to the branch, the
target or the report invalidates the review. This is the "confirmation reuse"
scope from plan 10's last task: an approval applies to one reviewed
transformation and privacy scope and to nothing else. A switch whose report is
not sendable cannot be sent at all; the user switches back or branches.

### 5. A reviewed switch is recorded with the user turn it applies to

`send` records a `ProviderSwitch` thread event in the same commit as the user
message it applies to, with `messageId` set to that message. The details are the
source and target connection ids, model ids and privacy classes, the four counts
and the review time. The library reads a bounded page of the open conversation's
events (24 rows, 200,000 bytes) and the header lists them from their recorded
details alone, naming connections by label when one is configured and by id
otherwise, so the record stays readable after a reload without any connection.

### 6. Context room and cost come from the catalog; token counts stay on request

The report carries the target's reviewed context window, the requested output
limit and the room that leaves for input (window minus output), plus the
target's reviewed price. The composer turns these into context and cost lines:
without a count it quotes the room and the reviewed rates and, where the
connection publishes a count endpoint, offers the existing "Count prompt
tokens" action; with a count taken for this exact draft, branch and target it
states whether the prompt fits or by how many tokens it exceeds the room, and
estimates the input cost at the reviewed uncached rate (the request asks for no
caching) beside an upper bound for the requested output. A count over the room
blocks sending, because the provider
would refuse the request and compaction does not exist yet. Counting is never
automatic: it transmits the branch to the target provider, which a
privacy-changing switch must not do before the user has reviewed it. A count
belongs to the target it was taken for and is discarded when the connection,
model or draft changes. The recorded switch keeps the count and room it was
reviewed with.

### 7. Portability status is derived live from the same reports, never stored

The open conversation's portability status is computed from the active path
analysed against every configured connection's reviewed models (bounded to 32
targets), using the same `analyze` reports as the switch inspection: fully
portable when every target carries every part, portable with transformations
when every target carries the path but long text is sent inline from stored
bytes, provider-dependent when only some targets carry it, blocked when none
do, and unknown when no connection is configured. Each status carries one
reason per target in the adapter's own terms (counts of refused parts by kind
with their issue codes, request-level constraints) plus what is never sent to
any provider. The status is recomputed whenever the path, the configured
targets or the output setting change, which keeps it current without a stored
value that could go stale; nothing is persisted and no provider is contacted.
Library-wide counts by status and filtering belong to plan 12's bulk migration
and would need a stored, invalidated assessment; that is not decided here.

### 8. Fallback is a per-conversation policy, never silent, always a separate attempt

A conversation may name one fallback target (connection and model) and whether
that fallback may change the privacy class. The policy lives in the thread
state's routing profile (`SetRoutingProfile`, schema 8), so it survives reload
and export and needs no new migration. When a primary attempt ends without
completing, the workflow resolves the candidate at that moment, with the
candidate connection's account health as of then, analyses the same request
input against the candidate model, and decides in the open: a user stop never
falls back; a candidate that is not configured, lacks the named model, is the
connection that failed, would change the privacy class without allowance,
cannot send now by its health, or cannot carry the path is refused with that
reason shown to the user. When the fallback runs, it is a separate generation
record under the same user turn, and its `AutomaticFallback` event is committed
in the same transaction as that record (the generation run accepts mutations to
create with), naming the primary attempt, its status and failure code, both
targets with their privacy classes and the decision's reason. The primary
attempt keeps its own status and committed text: a partial answer stays a
partial attempt on a sibling branch, never the active path's completed answer.
A blocked primary connection still refuses sending up front rather than falling
back before trying; using health to route before the first attempt belongs with
routing profiles.

### 9. An imported conversation's origin is its import source

When the active path has no generation attempt, the origin of the path is the
thread's import source: the library resolves the source record by the thread's
`importSourceId` (a bounded lookup) and the composer treats any configured
connection or model as a switch from that provider. The imported history has
no transport privacy class on this device, so the origin's class is unknown
and continuing an imported conversation is always a reviewed switch; the
recorded `ProviderSwitch` event names the origin as `{provider, model:
"imported", privacy: null}`. The imported records are never rewritten: the
continuation appends a user turn and an attempt under the chosen branch, and
imported parts the adapters cannot carry (for example a provider artifact kept
from unrecognised export content) block that branch with the mapper's reason
while a text-only sibling branch stays portable.

### 10. An image without usable bytes is sent as a note, as a reviewed transformation

The first imported continuation exposed a hard block: the export listed a
sketch whose bytes it did not include, the attachment is recorded as missing,
and the mapper refused the whole path with `image_unavailable`. That would
leave every imported conversation with a missing file unable to continue
anywhere. The workflow now sends such an image (missing, unavailable, or
outside the request profile) as a text note naming the file, counts it as a
transformation the switch report and portability status name before use, and
records it in the switch's transformed count; the history keeps the original
image part. Excluding attachments deliberately remains plan 10's compaction
task.

### 11. Routing profiles are per conversation; the route is chosen before the first attempt

The conversation's routing profile (version 2 of the same routing-profile
field) holds an optional name, ordered fallback candidates, requirements every
candidate must meet (tool support, image input, a minimum declared context
window, a maximum estimated input cost for the counted prompt) and the
privacy-change allowance. The selected connection is always the primary. Before
the first attempt the composer chooses the first candidate in
[primary, ...candidates] that is configured, holds the primary's privacy class
(or the profile allows a change), can send now by its account health, meets
every requirement from catalog facts, and whose compatibility report (from the
portability assessment) does not refuse the path; every examined candidate's
outcome is shown in a route line. A primary whose only failure is its report is
still chosen so the report explains the refusal. When the route lands on a
candidate other than the selected connection, the attempt is created with an
`AutomaticFallback` event whose primary status is `not_attempted` and whose
reason is the route line. The compatibility review concerns the chosen target,
so the reviewed report is the transmitted request's. After a failed attempt the
remaining candidates are tried in order with the same eligibility rules. Cost
is checked only when a prompt count exists for the candidate and is said to be
unchecked otherwise; region constraints have no catalog data and are not
offered. Library-wide aliases that resolve to shared profiles need a local
settings path that does not exist yet (plan 13 names it too); until then the
profile's name is per conversation.

## Evidence

- [Provider compatibility tests](../../packages/providers/tests/compatibility.test.ts):
  a clean path preserves every part by kind with a positive request size;
  refused Image, File and ReasoningMetadata parts are listed with the mapper's
  codes and `prepare` refuses the same path; an unregistered model and an
  unsupported system prompt are constraints without throwing.
- [Shared application acceptance](../validation/shared-app.md), check
  twenty-six in Chromium and WebKit: selecting the OpenAI connection after an
  Anthropic attempt shows the report with zero blocked parts and the
  different-provider notice, the Send button stays disabled until the review is
  ticked, the send records an OpenAI attempt and a `ProviderSwitch` event whose
  `messageId` is the parent of that attempt and whose preserved count equals the
  displayed report, the header lists the switch, and after a browser restart with
  no connection configured the event is still listed by its recorded ids.
- [Switch context tests](../../packages/app/tests/switching/context.test.ts):
  the room, the count-on-request prompt and the reviewed rates without a count;
  a fitting count with spare room and an input-plus-bounded-output estimate; a
  count over the room with the excess stated; and a connection without a count
  endpoint, an unknown window and no price, each stated as such.
- The shared-app switch check also shows the OpenAI target's room (window
  minus the requested output), its lack of a count endpoint and its reviewed
  rates, records the room and a null count on the switch event, and under the
  Anthropic target takes an on-request count whose fit, spare room and reviewed
  input estimate match the count the fixture returned.
- [Portability tests](../../packages/app/tests/switching/portability.test.ts):
  fully portable with one reason per target and the never-sent note; portable
  with transformations from inlined text; provider-dependent naming each
  refusal by kind and code; blocked with constraints quoted; unknown without a
  target.
- The shared-app portability check (twenty-seven): the comet conversation is
  fully portable across both configured targets with a reason each, a seeded
  conversation whose assistant turn carries reasoning metadata is blocked for
  both targets with the mapper's `content_mapping` reason, and after the
  browser restart with no connection the status is explicitly unknown.
- [Fallback tests](../../packages/app/tests/switching/fallback.test.ts): the
  routing profile round-trips a policy and rejects other shapes; a provider
  failure with a healthy, compatible, same-privacy target applies; a user stop
  never falls back; a missing connection, missing model or the failed target
  itself are refused by name; a privacy-class change is refused unless allowed
  and the allowance is recorded in the reason; a target whose health blocks
  sending or whose report refuses the path is not used.
- The shared-app fallback check (twenty-eight): the stored policy is shown and
  persisted, a synthetic 503 on the Anthropic connection produces a failed
  Anthropic attempt and a complete OpenAI attempt under the same user turn with
  an `AutomaticFallback` event whose `generationId` is the fallback attempt and
  whose details name the primary attempt and reason, the active leaf is the
  fallback's answer and the header lists the fallback; an in-stream error after
  three deltas leaves a partial Anthropic attempt with its committed text beside
  a complete fallback; a user stop records a cancelled attempt and no fallback;
  after the browser restart the stored policy is shown by id as not configured.
- The shared-app imported-continuation check (twenty-nine): the synthetic
  ChatGPT export is imported through the production import panel, its
  artifact-bearing branch is blocked for both targets with the mapper's reason,
  the text branch is chosen through branch navigation and is portable with
  one transformation (the sketch without exported bytes, sent as a note naming
  the file), the switch to the Anthropic connection shows the import notice,
  the transformation and the unknown privacy class and is reviewed, the request
  carries exactly the imported path plus the note and the new turn with no
  image block, the recorded switch names the import origin with one
  transformation, and every imported message and part is byte-for-byte
  unchanged afterwards.
- [Routing tests](../../packages/app/tests/switching/routing.test.ts): a
  version 1 policy reads as a one-candidate profile and version 2 round-trips
  with invalid shapes refused; a qualifying primary is chosen without examining
  the rest; a primary that cannot send now or fails a requirement is routed
  around; capability, privacy, cost and configuration refusals are named; a
  primary whose report refuses the path is chosen when nothing else qualifies.
- The shared-app routing check (thirty): a minimum context window the selected
  connection does not meet routes the send to the candidate with an
  `AutomaticFallback` event (`primaryStatus: "not_attempted"`) naming the
  requirement, a minimum no candidate meets refuses sending with both reasons,
  clearing it restores the selected connection, a credential the provider
  rejected routes the next send around the selected connection from its
  recorded health, and a connection check restores it.
- The same run exposed and fixed a defect: `inspectSwitch` and `countPrompt`
  reused the generation's cancellation flag after a stopped attempt and failed
  with "Generation cancelled before sending." Reads outside a generation now
  clear that flag, which only ever applies to the run it interrupted.

## Not decided here

- Model aliases, routing profiles and ordered candidates.
- Stored, library-wide portability counts and filtering (plan 12).
- A local token estimate for connections without a count endpoint; the report
  quotes the encoded request size only, and no tokenizer is bundled.
- Context compaction choices and `ContextCompaction` events.
- Library-wide aliases and shared routing profiles (need the local settings
  path), region constraints, and cost constraints without a prompt count.
- A regenerate-specific report for an ancestor turn.

## Consequences

- Adapters must add new part kinds to the mapper's preserved list when they map
  them; the compatibility test fails if a mapped kind is not counted.
- Any future transformation (for example converting tool calls to text) must be
  performed inside `map` so the report and the request stay one mapping.
- The portability and switch reports name each transformation kind
  separately (inlined text, images sent as notes); a new transformation must be
  added to that list so it is never silent.
- A user sees a large "omitted" figure on conversations with many attempts,
  because every internal provenance record counts; the report explains that
  these records are never sent.
