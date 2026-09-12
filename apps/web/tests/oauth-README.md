# Browser OAuth qualification

Run `npm run test:host:oauth:web`. `QUIXI_TEST_BROWSERS=chromium` or `webkit` selects one engine; the default runs both.

The proof builds the production callback page and a small static fixture using the production `createWebHost`. It serves the main fixture with the production COOP/COEP headers, and the callback with the exported production callback headers. A click opens a real authorization window on another origin. A second click returns through the built callback page and its transaction-specific BroadcastChannel.

The authorization/token/resource server uses only explicitly admitted loopback HTTP origins on ports 4216 and 4217. It checks actual PKCE, client, redirect, grant, Origin, credential omission, referrer omission, and access-token bearer use. Retained observations contain booleans and bounded metadata. This does not qualify real-provider registration, TLS deployment, PWA installation, persistent credentials, or external accounts.

The 22 groups per selected engine cover positive connection, callback validation and recovery, denial, duplicate/late callbacks, cancellation, disposal, reload, held-token cancellation and manual-key races, token response bounds, unavailable capabilities, popup/channel faults, overload, and history navigation. Negative-only popup, BroadcastChannel, and isolation faults are named explicitly. History observations identify whether the browser actually restored from its back/forward cache; a fresh document does not qualify cached-document restoration.

Each test uses a new temporary persistent browser context, removed after the context closes. Screenshots, video, and traces are disabled because OAuth navigation URLs contain synthetic transaction values. The compact report includes redacted wire facts, engine versions, source hashes before and after execution, callback/main fixture artifact hashes, and each group's result. It is written to `test-results/web-oauth-browser.json`; attempts are retained in `test-results/web-oauth-attempts/`.
