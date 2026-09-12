# Compare and critique modes

Plan [12](../plans/12_add_compare_critique_and_bulk_migration.md), product
§39/§40, [ADR 0042](../decisions/0042-compare-critique-bulk-migration.md). Last
run 2026-09-12 on macOS 25.6.0 (arm64), Node v22.23.1, Playwright Chromium
and WebKit, against the proof's Anthropic and OpenAI fixtures.

## What is implemented

- The composer's "Compare answers" control lists every configured
  connection's reviewed models; with two to four ticked, "Send to N models"
  replaces the ordinary send for that turn.
- The chat workflow's `compare` prepares and checks every candidate's
  request (region, cost, adapter preparation) before anything is committed,
  then commits the user turn once with a `Compare` event that lists each
  candidate's pre-allocated generation and output ids, selects the turn,
  and starts one coordinated attempt per candidate concurrently. Compare
  attempts create their generations without a revision expectation (they
  are siblings of one parent) and never move the selection; Stop cancels
  all of them. A candidate's failure is named per candidate and leaves the
  others running.
- The conversation shows a "Compared answers" section under the turn:
  each candidate's connection, model, live status, tokens and estimated
  cost, with "Select this answer" (the ordinary `SetActiveBranch`) or a
  Selected marker; the branch choices show the same siblings. Statuses are
  re-read from the generation records on every storage change.
- Events describe the comparison in one line; the reviewed critique event
  description is in place for the critique slice.

## What is proven

The shared-app proof (`npm run test:app:browser`, 98 checks per
engine, [retained](results/shared-app-macos-26.6.2.json)) sends one turn to
Claude Haiku 4.5 and GPT-4.1 mini at once and checks: two new generations
with one parent and two providers, both complete, both outputs sealed, one
`Compare` event naming exactly those generations, the event line, two
assistant branch choices, two Select buttons; selecting the second candidate
marks it, opens its answer and moves the active leaf to its output; after a
reload the compare view and the selection persist from the records alone;
the next turn continues from the chosen answer. A second comparison asks the
Anthropic fixture to fail mid-stream: the OpenAI candidate completes and
stays selectable, the failed one (recorded as `partial`, since its
committed text before the provider's in-stream error is kept) is named in
the error line, and both attempts remain in history with sealed outputs.
The scenario runs late in the proof, after a browser restart, so it
reconnects both credentials, as every restart scenario does.

## Critique

`critique(reviewed, provider, model)` reads the branch through the reviewed
answer, appends the fixed review instruction as the request's last user
turn, and starts one ordinary attempt whose parent is the reviewed answer's
parent turn, with a `Critique` event committed in the generation's own
commit naming the reviewed message and generation and the critic's
connection and model. The critique's article carries a badge naming what it
reviewed; the event line says the reviewed answer is unchanged. Each
assistant answer offers "Critique this answer" with the composer's selected
connection and model as the critic.

The shared-app proof (99 checks per engine) critiques the last
answer after the compare scenario and checks: one new complete generation
whose parent is the reviewed answer's parent, one Critique event naming the
reviewed message and generation and the critic's model, the request's last
turn carrying the review instruction after the reviewed assistant turn, the
reviewed message and its parts byte-equal before and after, the badge on the
critique's article and the event line.

## Limits

- At most four candidates per comparison (ADR 0042 bound).
- Compare attempts do not take the automatic fallback of an ordinary send;
  a failed candidate is reported, not retried on another connection.
- The reviewed bulk migration is not yet implemented. The critique's
  instruction is fixed; a user-authored review prompt is a later refinement.
