# Recorded layout acceptance

Final capture completed 2026-09-09T09:34:40.492Z with all 26 recorded source
hashes unchanged during capture and matching the workspace on final review.

| Actual engine | Authored pages | Source spans checked | Generated spans checked | Workers released |
| --- | ---: | ---: | ---: | ---: |
| Chromium 153.0.8010.12 | 5 | 66 | 72 | 9 |
| WebKit 26.6 | 5 | 66 | 72 | 9 |

Each source span matched an independent raw PDF.js item slice and its complete
geometry. All original item characters were covered exactly once. All generated
newlines/tabs had null source ranges. Both engines passed the unmodified
authored column/paragraph order, table cell associations and exact code/list
indentation. The rotated page preserved raw text in source order and emitted
`{mode:"source_order",reasons:["rotated_or_skewed"],columns:1}`.

The largest live raw page contained 23 items; the largest normalized page had
663 UTF16 units. Production range reads reached 3,308 bytes on these tiny
fixtures. No workers remained alive after each fixture and no external requests
or browser errors were observed. This is correctness evidence, not a maximum
memory or performance qualification.

Report: `browser-evidence.json`.

SHA-256: `ac4e4d2503d1079769f9a2b2ebcd9a9b4b3dc24448771a4e6394bc53f7eb8a75`.

Earlier successful intermediate snapshots remain in `attempts/`; the final
report adds explicit separator/adversarial-order assertions and the core
normalizer-version source fingerprint. No failed reading-order assertion was
weakened to obtain a pass. Durable fallback-notice persistence and RTL remain
outside this harness's evidence scope.
