# Provider audio-input qualification

This plan-06 increment implements verified WAV/MP3 inputs through an explicit
GPT-Audio-1.5 model choice. [ADR 0030](../decisions/0030-provider-audio-input.md)
records the dated protocol sources, bounds and capability decisions.

## Implemented behavior

The general OpenAI connection offers the existing GPT-4.1 mini model and the
reviewed audio model. Only the latter admits WAV/MP3 attachments. Picker/drop
staging retains exact original bytes as Attachment and Audio records; draft
removal and cancellation release staged work. Unsupported protocols/models,
missing bytes, formats and limits produce compatibility refusals. Historical
MIME aliases normalize only in request metadata. Regeneration reads the same
verified original blobs. Reviewed regional routes keep their explicit model
allowlist and do not acquire audio support from the general catalog.

The adapter sends input_audio blocks and explicitly requests text output. It
preserves reported usage but leaves the audio model's estimated cost unknown;
a single text-token rate cannot price a mixture of audio and text. The existing
OpenAI Chat Completions counting refusal remains explicit. Summary proposals
require explicit reviewed exclusion of audio occurrences.

Raw attachment occurrences share a 2.5 MiB budget, with at most 20 composer
attachments and 20 audio occurrences per request; encoded JSON remains capped
at 4 MiB. Audio header checks are bounded admission checks, not a full decoder.
No microphone, audio generation, realtime session or automatic playback is added.

## Evidence

Application, provider-browser and native transport qualifications pass on the
same final source set. The full application passes **63 groups per engine**;
provider transport passes **25 checks per engine** and **18 actual macOS Tauri
checks**, including disposable keychain cleanup. `npm run check` passes.
The four unit suites total **231 distinct tests**:

- `npm run test:providers`: 77 tests, including nine audio mapping/catalog groups.
- `npm run test:app:attachments`: 40 tests, including audio signature/MIME,
  split-prefix transfer, metadata, budget and cancellation cases.
- `npm run test:app:switching`: 81 tests, including seven audio-context groups
  covering inspection, counting/preparation, send/regeneration, missing data,
  exclusions, aggregate allocation and malformed transfer cleanup.
- `npm run test:app:providers`: 33 tests, including additional reviewed models,
  bounded/unique model identities and regional model exclusion.

The new integrated scenario checks original WAV/MP3 bytes in HTTP, canonical
records, regeneration, portable TAR members, managed restore and a fresh browser
process. Both engines pass all 63 groups in the complete application suite.
The provider-host scenario passes 25 checks per browser engine and 18 checks
through the actual macOS Tauri host. It sends each format through browser/native HTTP;
its loopback server refuses any changed byte or unintended output-audio request.

The first app attempt had a stale expectation of two configured targets; the
new model correctly made three. The test now verifies the audio model's reason
explicitly. The second attempt exposed real enlarged-text overflow in an image
branch's new portability refusal. Portability reasons now wrap within their
panel, and the unchanged 320px/200% measurement must pass. Failed reports/logs
and the layout measurement are retained under
[attempt 1](results/attempts/provider-audio-input-01/app-browser.json) and
[attempt 2](results/attempts/provider-audio-input-02/app-browser.json).

The [third attempt](results/attempts/provider-audio-input-03/app-browser.json)
dropped the MP3 immediately after closing the WAV picker, while the first
selection was still staging. The controller permits one staging operation at
a time. The scenario now waits for the WAV entry and enabled Attach files
button before dropping the MP3; it retains both exact-byte assertions.

The [first provider-host attempt](results/attempts/provider-audio-input-host-01/providers-browser.json)
failed because its audio fixture passed `crypto.randomUUID` as an unbound
callback. Wrapping the call with its Crypto receiver restores browser transport;
the controlled server then verifies exact WAV and MP3 bytes in both engines.
The initial passing application report is retained separately because that
fixture correction changed one of its tracked source hashes.

## Limits

Synthetic recordings and controlled provider responses establish request
mapping, host transport and persistence, not live account access, provider codec
acceptance, semantic quality, real usage or billing. WAV signatures and MP3
headers do not prove the entire file decodes. Native transport qualification
is separate from native picker/drop and assistive-technology qualification.
Broader provider content, reasoning continuation and release-scale gates remain
open. Actual audio output and summary-audio input are separate contracts.

## Retained qualification

The [aggregate record](results/provider-audio-input-checks-macos.json) verifies
134 retained final source hashes against the worktree and hashes all 29
artifacts, including reports, logs and screenshots. The application and native runners also verify that their
tracked sources stayed unchanged during qualification. Final evidence includes
[application](results/provider-audio-input-app-macos.json),
[browser transport](results/provider-audio-input-providers-browser-macos.json),
[native transport](results/provider-audio-input-providers-native-macos.json),
and the [staged attachment view](results/provider-audio-input/audio-input-chromium-staged.png)
and [WebKit restart view](results/provider-audio-input/audio-input-webkit-restart.png).
The native run uses macOS 26.6.2 and system WebKit 21624.5.1.11.3.

The application fixture uses a 1,644-byte synthesized PCM WAV tone and a 522-byte
MP3 containing five synthetic silence frames. The MP3 passes an independent
ffmpeg decode and [ffprobe inspection](results/provider-audio-input/mp3-probe.json).
The separate transport fixture uses deterministic header/payload bytes solely to
verify exact transport; it does not claim provider codec acceptance.
