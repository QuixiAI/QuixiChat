# Background account-health refresh

This plan-06 increment implements the account-health behavior in product section
32 under [ADR 0028](../decisions/0028-background-account-health.md). It reuses
the existing model-list routes and adapters; no provider generation is used as
a health probe.

## Behavior and bounds

Connected, eligible accounts share one automatic operation and one timer.
Unobserved health waits 30 seconds, healthy observations wait five minutes, and
transient failures back off from 30 seconds to five minutes while respecting a
later retry time. Rejected credentials pause until explicit user action.
Visibility, connectivity and foreground activity gate scheduling and cancel a
held probe. A foreground settings operation takes priority. Model discovery
from an explicit check remains separate from automatic first-page metadata.

The adapter suppresses cancelled and stale probe observations, releases late
response bodies, and preserves health from newer generation/count responses.
Health and eligibility updates reach the shared routing/UI state. Request and
attempt bookkeeping stay bounded by the configured connections and the active
operation.

## Qualification

Qualification passes on macOS 26.6.2 / arm64 / Node 22.23.1:

- **61 shared-application groups per engine** in Chromium and Playwright WebKit.
- **23 provider transport checks per engine**, including durable generation,
  interruption and process restart, and **11 standalone settings checks per engine**.
- **190 unit tests**: 68 provider, 31 settings/controller, 17 health/view/cadence,
  and 74 switching/fallback/routing tests.
- `npm run check`.

The [application report](results/background-health-app-macos.json) and
[aggregate record](results/background-health-checks-macos.json) retain 100
unchanged app source hashes, 13 additional auxiliary source hashes and 12
artifacts. The auxiliary provider/settings reports and all logs are included.

Controller tests use the real adapters
with a synthetic HostClient; provider tests exercise response ordering and
cancellation at dispatch and during collection. The shared-application scenario
uses actual loopback HTTP, storage and the rendered application, with a fixture
clock advanced only for account-health observations and scheduling. It checks
automatic failure/recovery, offline and hidden suppression, rejected credentials,
explicit recovery and cancellation of a held HTTP reply. Exact canonical/sync
records and content dispatches remain unchanged in both engines.

The [first app attempt](results/attempts/background-health-01/app-browser.json)
passed the new health transitions but failed its cleanup locator: Open Providers
is a contextual shortcut that disappears after recovery. The helper now uses the
permanent Providers navigation button. The failed attempt is retained and does
not count as a passing application run.

The clock and connectivity/visibility events are controlled test inputs; this
does not establish real provider health, real credential expiry, paid usage,
native operating-system lifecycle behavior, or actual screen-reader delivery.
