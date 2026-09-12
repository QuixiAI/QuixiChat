# Services

No services are implemented or required to run the current scaffold. Add `relay/`
when provider transport needs it, and `cloud/` when encrypted backup/sync work
begins. Service deployments have independent build and release entry points.

Ordinary web hosting never persists the user's canonical archive by default.
Cloud remains optional; do not add a server-side history database to make Docker
hosting work. Cloud key management and recovery are unresolved product work.
