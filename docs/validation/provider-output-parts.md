# Provider-specific output parts

This plan-06 slice makes assistant turns that carried citations, structured
output or raw-only provider blocks continuable on every target with a named
transformation, under [ADR 0033](../decisions/0033-provider-output-parts.md).

## Behavior

Before mapping, the workflow sends a Citation as a plain `[Source: …]` note,
sends other structured output as JSON text, and omits refusal markers and the
generation's own raw-only stream artifacts, counting each for the switch
report, portability and the recorded switch. Import-derived artifacts stay for
the mapper's refusal, which now names `citation_unsupported`,
`structured_data_unsupported` and `provider_artifact_unsupported`.

## Evidence

- **95 provider tests** (one new): both protocols refuse the three kinds by
  name; the earlier ReasoningMetadata expectation is unchanged.
- **89 switching unit tests** (four new in
  [output-parts.test.ts](../../packages/app/tests/switching/output-parts.test.ts)):
  source-note forms, marker omission versus JSON flattening within its bound,
  stream-located versus import-derived artifacts, and the report wording.
- **66 shared-application groups per engine** (`npm run test:app:browser`,
  Chromium and WebKit), one new: an Anthropic response with a citation delta
  and an unknown output block, and an OpenAI response with a URL annotation
  and a `reasoning_content` delta, are retained as Citation and stream-located
  ProviderArtifact parts and shown; the next count, send, regeneration and
  cross-provider switch carry the answer with the source note after the text
  and none of the provider-specific records; the switch report names each
  transformation; the imported ChatGPT branch with an unsupported part remains
  blocked, now by `provider_artifact_unsupported`.
- **29 provider browser checks per engine** and `npm run check`
  re-run against the changed mapper.

## Limits

Source notes are plain text the model reads as part of the answer; they are
not provider citations and cannot be re-cited. Structured output larger than
64 KiB of JSON text is still refused. No live provider run is involved.

## Retained evidence

The [aggregate record](results/provider-output-parts-checks-macos.json)
verifies source hashes and hashes the retained
[application](results/provider-output-parts-app-macos.json) and
[provider browser](results/provider-output-parts-providers-browser-macos.json)
reports.
