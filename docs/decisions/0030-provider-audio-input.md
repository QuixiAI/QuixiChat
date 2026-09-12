# ADR 0030 — Verified audio inputs with an explicit audio model

Date: 2026-09-10. Status: accepted; qualification is recorded in
[provider audio input](../validation/provider-audio-input.md).

## Decision

Add GPT-Audio-1.5 as an additional reviewed model under the existing general
OpenAI connection. The primary GPT-4.1 mini model remains available. Each
connection has at most 16 unique reviewed model identities. Provider discovery
does not establish model capabilities or account access. Regional connections
filter the catalog by their independently reviewed model IDs and modalities;
a general catalog addition cannot enroll an audio model in those routes.

The provider model describes text/audio input and output; Quixi's effective
profile requests text output explicitly. WAV and MP3 user Audio parts map to
Chat Completions input_audio blocks with base64 data and a wav/mp3 format.
The implemented Anthropic Messages profile and general GPT-4.1 mini reject audio
with named compatibility issues. No transcript or text substitute is invented.

The composer admits audio only for a selected model with reviewed audio MIME
types. Picker and drop staging recognize RIFF/WAVE, ID3 or MPEG Layer III headers,
normalize common MIME aliases and retain the original bytes. Header validation
is an admission check, not a complete codec parser. Audio has metadata and a
removal action in the composer, without automatic playback. Existing history
attachment details and original downloads apply to retained Audio parts.

Images, files and audio share the existing 2.5 MiB raw request budget. Each
occurrence counts before base64 allocation, even when attachment IDs repeat;
encoded JSON remains bounded at 4 MiB. Composer selections are limited to
20 attachments, and the request profile limits audio to 20 occurrences. Storage
staging, transfer acknowledgements, cancellation and cleanup use existing paths.
Canonical Audio and Attachment contracts already exist, so no migration is added.

Compatibility inspection, prompt preparation and regeneration load verified
retained audio through the same bounded attachment reader. MIME normalization
changes request metadata only. Missing or unsupported audio remains an Audio
part with an explicit refusal. Reviewed attachment exclusions omit bytes before
loading them. Archive export/restore retains original metadata and blob identity.
The summary-proposal builder continues to require explicit exclusion of audio
occurrences; this slice does not silently broaden its separate input contract.

The audio model's pricing remains unknown in Quixi: its current single input
rate cannot correctly estimate mixed text/audio token charges. Reported usage
and raw evidence remain preserved, and cost-constrained routes require sufficient
known pricing/count evidence. OpenAI Chat Completions prompt counting remains
unavailable in this adapter. Audio generation, microphone recording, realtime
sessions and live-provider acceptance are separate requirements.

## Official protocol review

Sources fetched on 2026-09-10:

- [GPT-Audio-1.5](https://developers.openai.com/api/docs/models/gpt-audio-1.5):
  Chat Completions, text/audio modalities, 128,000 context, 16,384 output,
  streaming and function calling; distinct text/audio rates.
- [Audio in Chat Completions](https://developers.openai.com/api/docs/guides/audio-chat-completions)
  and [create completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create):
  input_audio data/format and the output modalities parameter.
- [Create a Message](https://platform.claude.com/docs/en/api/messages/create):
  the reviewed content-block union has no audio input block. This supports the
  implemented profile's refusal, not a claim about all future Claude products.

Synthetic transport fixtures verify mapping and persistence. They do not
establish real account access, provider codec acceptance, transcription quality,
real billing or the advertised model's semantic behavior.
