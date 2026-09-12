# ADR 0028 — Bounded background account-health checks

Date: 2026-09-10. Status: accepted; qualification is recorded separately in
[background health validation](../validation/background-health.md).

## Decision

The session-owned provider settings controller schedules health checks for
connected, available accounts. Regional accounts additionally require the
current credential/configuration eligibility confirmation. The shared app
supplies actual visibility, connectivity and foreground-busy state. One timer
and one automatic operation serve the configured list, already capped at 16
connections. Mounting or leaving the Providers panel does not own this work.

An automatic check uses the existing adapter authentication path: one bounded
page of the registered model-list endpoint, with its existing byte and timeout
limits. It sends no conversation content, count request or generation request.
It does not replace the model discovery obtained by an explicit, paginated
Check connection action. No provider endpoint, host capability or storage schema
is added by this change.

An unobserved account waits 30 seconds. Healthy observations are refreshed after
five minutes. Transient failures back off from 30 seconds to five minutes; a
later Retry-After deadline remains a lower bound. Region-unavailable outcomes
use five minutes. Authentication rejection suspends automatic checks until an
explicit check or credential change. A newer response observation moves the
deadline forward. Attempts are scoped to the current adapter/credential and
discarded with the session. These are product polling limits, not claims about
provider availability or provider-imposed rate limits.

Hidden, offline and busy states cancel automatic work and suppress scheduling.
Foreground settings changes and content requests cancel the probe before taking
over. The adapter accepts an optional abort signal, checks it at dispatch and
during response collection, cancels the host request and releases any response
body even if it arrives late. Deliberate cancellation does not create a provider
failure. Request bookkeeping is cleared after each bounded operation; completed
historical requests do not accumulate for later cancellation.

The same adapter remains the authority for health used by the UI and routing.
Every accepted health observation advances an internal revision. A model probe
may update health only if no newer observation has arrived since it started;
wall-clock resolution does not determine ordering. Refreshed host capabilities
are published even if they revoke eligibility before HTTP dispatch. Retained
adapters reject dispatch after their credential is replaced or their session is
closed.

## Consequences

Background activity does not disable or move focus from foreground controls.
Providers explains automatic metadata checks and the credential-rejection pause.
The policy does not generate answers to test health, silently retry a failed
generation, confirm regional account eligibility, or establish live-provider
qualification. Host and provider failures remain distinct from the device's
offline signal. Tests use synthetic responses and an advanced health clock;
actual provider behavior remains an explicit plan-06 release gate.
