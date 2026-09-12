# Provider capability review — counting and regional processing

Recorded 2026-09-10 on macOS 26.6.2, arm64. The preceding goal iteration made
verified progress on request-cost enforcement. This iteration corrected a
provider-wide claim contradicted by current official documentation, then
completed the region design prerequisite. **Regional routing remains unimplemented.**

## Implemented correction

The Chat Completions adapter used to say the provider publishes no counting
endpoint. Its unavailable result now says counting is not implemented for this
connection. The reviewed catalog shown in Providers, composer switch inspection,
summary fallback text, contract comments and plan 06 use the same limited claim.

OpenAI documents a Responses input-count endpoint. Its input format does not
establish an exact count for Quixi's Chat Completions request. The provider
README records that distinction with the [official counting guide](https://developers.openai.com/api/docs/guides/token-counting),
opened on 2026-09-10. This iteration adds no counting protocol, approximate
conversion or implicit request. Anthropic counting and existing request-cost
behavior retain their implementations.

The existing adapter and switch-context expectations now check the corrected
wording. The production app browser proof verifies the unavailable count result
and the switch-inspector explanation, and reruns all earlier send, fallback,
summary, cost, alias and restart checks. Provider settings also runs its actual
model discovery, streaming, credential replacement/disconnect and reload proof.
The settings screenshot was inspected; its capability details are collapsed,
so that screenshot alone is not evidence of the corrected catalog sentence.

## Executed checks

| Command | Result |
| --- | --- |
| `npm run test:providers` | 32 passed |
| `npm run test:app:switching` | 51 passed |
| `npm run test:app:browser` | 39 groups in each of Chromium and WebKit |
| `npm run test:app:providers:browser` | 5 groups in each of Chromium and WebKit |
| `npm run check` | SQLite artifact verification, typecheck, web and desktop frontend builds passed |

[Unit/build capture](results/provider-capability-unit-macos.json),
[application report](results/provider-capability-app-macos.json), and
[provider-settings report](results/provider-capability-settings-macos.json)
record the environment, commands or runtime checks, and source hashes. All
captured hashes were checked against the final runtime/test sources. Historical
reports retain their earlier hashes and are not rewritten to look current.
The browser fixtures use synthetic secrets and loopback HTTP with real adapters,
host transfers and, in the application proof, the production Storage Worker.
No paid API, private history or native runtime was exercised by this iteration.
Build output retains its existing large-chunk advisory; the check exited zero.

## Region design review

[ADR 0023](../decisions/0023-regional-processing-evidence.md) records the dated
provider evidence, current host gaps, design decisions and alternatives. An
independent agent reviewed the regional positive path and refusal requirements;
its findings were incorporated. This is design evidence, not a regional test
suite. The ADR's matrix lists tests still required and does not count them as
passed.

The next implementation must add a real regional connection with host-owned
route evidence before claiming usable constrained routing. It must carry the
policy through aliases, initial route selection, counting, send, regeneration,
fallback and summaries, preserve exact canonical snapshots, and prove current
connection/relay evidence after asynchronous operations. Current native and web
registrations do not yet carry that evidence. Plan 10 task 1 remains open.

Actual summary-fidelity qualification still has zero scored model runs. The
broader implementation goal, native qualification and release gates remain open.
