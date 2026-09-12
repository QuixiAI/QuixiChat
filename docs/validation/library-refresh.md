# Bounded automatic conversation refresh

Plan [08](../plans/08_build_chat_and_library_ui.md), product sections 29 and 107.
This correction keeps conversation views usable while storage changes continue.

## Failure and correction

The previous controller scheduled a new view every 200 ms after qualifying
storage-change notifications, even if the preceding view was still loading.
Each new load invalidated the previous load's epoch. A slow view could therefore
finish repeatedly without ever publishing its result.

The [original controller probe](results/attempts/library-refresh-continuous-changes-probe.ts)
and [output](results/attempts/library-refresh-continuous-changes-probe.log)
reproduced six reads, five superseded completions and no publication until
notifications stopped. The [baseline source](results/library-refresh/library-before.ts.txt)
matches the library source hash in the preceding
[application report](results/composer-files-app-macos.json). This is separate
from the archive-opening navigation race recorded in [composer files](composer-files.md).

The controller now retains one dirty flag and at most one refresh timer.
Automatic refresh waits until active view loads settle, then starts one read
after 200 ms if a notification arrived during those loads. A load consumes the
previous dirty flag and timer when it starts. Notifications cannot supersede
an active view; explicit navigation still starts immediately and takes priority.
Any later automatic refresh uses the latest navigation target.

Each message group waits for all of its bounded parallel reads to settle,
including after a sibling fails, before releasing the automatic refresh slot.
Epoch checks stop obsolete loads between read stages and prevent stale failures
from replacing the current error. Disposal clears pending refresh work and
prevents later publication. A changed archive selection prevents automatic
reads through the old selection. A failed read alone does not schedule retries;
another change can request a new refresh.

The existing twelve-message window, four parallel message reads, page budgets
and bounded import-source lookup remain in effect. Explicit navigation may
overlap an older read; automatic notifications add no concurrent view load.
The controller does not cancel a storage request that has already been issued.

## Qualification

On 2026-09-10 (local date), the final checks pass on macOS 26.6.2:

| Check | Result | Evidence |
| --- | --- | --- |
| Controller regressions and test typecheck | 9 passed | [log](results/library-refresh/controller-tests.log), [stable source hashes](results/library-refresh/controller-tests-sources.json) |
| Same regressions against previous controller | 7 failed, 2 passed as expected | [baseline record](results/library-refresh/baseline-tests.json), [log](results/library-refresh/baseline-tests.log) |
| Summary and branch regressions | 31 passed | [log](results/library-refresh/summaries.log) |
| Switching/context workflows | 74 passed | [log](results/library-refresh/switching.log) |
| Application browser integration | 44 per engine | [report](results/library-refresh-app-macos.json) |
| Workspace check | Passed | [log](results/library-refresh/check.log) |

The [aggregate record](results/library-refresh-checks-macos.json) verifies the
final source hashes, commands and logs. Browser sources stayed unchanged during
qualification. The baseline comparison used an isolated copy of the previous
controller and redirected only the regression test's import; it never replaced
worktree source. Seven failures cover automatic supersession, initial navigation,
queued refresh after navigation, stale error publication, failed parallel groups,
disposal during a read, and changed archive selection.

Commands for this slice:

- `npm run test:app:library`
- `npm run test:app:summaries`
- `npm run test:app:switching`
- `npm run test:app:browser`
- `npm run check`

The new [controller regression tests](../../packages/app/tests/library-refresh.test.ts)
use deferred storage replies and real bounded timers to control the failure
conditions. They exercise the production controller, including slow initial and
automatic loads, coalescing, immediate navigation, stale errors, failed groups,
recovery, disposal, and changed archive selection. Controlled replies establish scheduling behavior; the
shared application browser suite separately exercises the production Storage
Worker, SQLite/WASM/OPFS, rendering, streaming, branching and archive flows.
These checks do not complete wider host or release-scale qualification.

Implementation: [library controller](../../packages/app/src/runtime/library.ts).
