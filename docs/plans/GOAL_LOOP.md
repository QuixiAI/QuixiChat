# Implementation loop prompt

Run one bounded iteration of the implementation goal, then hand off. Each
iteration starts from verified repository state, delivers one complete and
verified slice, records the result, and continues.

Invoke with the self-paced loop:

```text
/loop Read docs/plans/GOAL_LOOP.md and execute exactly one iteration.
```

## Goal

Complete every in-scope plan in `docs/plans/`: plans **01–14 and 16–24**.
Plans **15 (local OCR), 25 and 26 (Cloud)** are deferred by the user on
2026-09-08. Do not implement, download, build, or expose them, and do not count
them in any completion gate. PDF native-text extraction, scanned/low-text
detection, document navigation, lexical search and semantic document search stay
in scope.

`docs/plans/GOAL.md` holds the full requirements, architectural constraints and
completion rules. `docs/product.md` is the requirements baseline and the
numbered plans are the roadmap. This file only defines how one loop iteration
proceeds; where they differ, GOAL.md's requirements win.

## One iteration

1. **Orient, bounded and read-only.** Read the handoff in
   `docs/plans/README.md` (completed, underway, planned, current work, next
   concrete steps). Run `git status --short`. Open only the plan files relevant
   to the candidate slice and the `product.md` sections they cite. Trust the
   handoff unless the repository contradicts it; if it does, correcting the
   handoff is the first slice.
2. **Select one slice, in this priority order.**
   1. Anything currently broken: `npm run check`, a failing suite, or a
      documented claim the code or evidence no longer supports.
   2. The roadmap's stated next concrete steps.
   3. The open task or acceptance criterion in the lowest-numbered underway plan
      whose prerequisites are met.
   4. The next planned plan whose prerequisites are met. Do its required
      research, measurements or design review first.

   A slice is one complete vertical increment (UI, worker, storage, host,
   error handling as applicable) that this iteration can implement and verify.
   Prefer closing an acceptance criterion over opening a new area. Never redo
   work the roadmap records as complete. If the last handoff says work stopped
   mid-slice, resume it.
3. **Implement fully.** No scaffolds, placeholder screens, mocks presented as
   product, or TODO-gated acceptance. Verify current external API and
   dependency facts against official sources before relying on them and record
   the dated sources. Bound memory, queues, transfers and inference; support
   cancellation and recovery where the plan requires it. Only the Storage Worker
   owns SQLite; respect package and host boundaries.
4. **Verify with real checks.** Run the affected unit and integration suites
   and the actual Chromium and WebKit browser or native proofs the plan's
   acceptance requires. Record environment, commands, results and limits. Keep
   retained reports and their source hashes consistent with the sources they
   describe. Fix causes rather than weakening checks. `npm run check` must pass
   before the iteration ends.
5. **Record.** Update the numbered plan file (tick tasks and acceptance criteria
   only with linked evidence), the roadmap handoff (completed, underway,
   outstanding gates, next concrete steps), the validation documents, and
   `docs/decisions/` for consequential decisions. A gate that cannot be
   verified here is an explicit outstanding requirement with what would unblock
   it, never a passing check.
6. **Report and continue.** End with a short report: the slice delivered, the
   evidence (suites and pass counts), what remains, and the next slice. While
   in-scope work remains, schedule the next iteration with the minimum delay.

If a slice proves too large for one iteration, split it, land the verified
part, and write the remaining steps into the handoff. Never leave the tree in a
state where `npm run check` fails at the end of an iteration.

## Rules that hold every iteration

- Never reduce scope silently. Resolve conflicts with `product.md` explicitly
  and record them.
- A working feature slice does not complete a plan. Completion needs every task
  and acceptance criterion backed by implementation and validation evidence.
- Do not commit, push, deploy, publish, spend money, or transmit private data
  unless the user has explicitly authorized it. Use synthetic or redistributable
  fixtures only.
- Preserve unrelated changes and keep `legacy/prototype/` as reference material.
- When credentials, hardware or external services block a gate, record exactly
  what remains unverified and pick other in-scope work. Do not idle.
- When a decision is genuinely the user's, write the exact question and the
  current state into the handoff and the report, then continue with other work.

## Stopping

Stop the loop only when plans 01–14 and 16–24 have every task and acceptance
criterion checked with linked evidence, the roadmap says so, and `npm run
check` plus the required suites pass from a clean checkout. Then give the final
account GOAL.md requires and end the loop. If an iteration finds nothing left
except gates only the user can unblock, list them precisely and stop.
