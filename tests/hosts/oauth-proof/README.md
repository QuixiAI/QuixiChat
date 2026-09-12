# Installed macOS OAuth proof

Run `npm run test:host:oauth:native` on macOS 14 or later with an interactive desktop. The runner builds an isolated Tauri app, registers a fresh UUID callback scheme, and delivers synthetic callbacks through `/usr/bin/open`. It never registers the production `ai.quixi.chat` scheme.

The 20 behavior phases use the production desktop bridge, native OAuth manager, internal OS callback plugin, TLS token client, and Keychain actor. They cover cold/warm callbacks, successful PKCE exchange and opaque credential use, rejected callbacks followed by valid completion, denial, expiry, duplicate delivery, cancellation, disposal, renderer reload, pending limits, invalid token responses, auxiliary-token discard, and the production COMMITTING cutoff. A final phase deletes each registered synthetic Keychain binding.

The authorization opener is a native fixture hook. It writes a synthetic authorization URL containing state and a PKCE challenge to private temporary control files for the runner. Those files contain no verifier, authorization code, or token and are removed afterward. This does **not** qualify external-browser authorization or any real identity/provider configuration.

Token exchange uses real HTTPS with an ephemeral CA and the fixed hostname `oauth.synthetic.invalid`. Authenticated provider use is a separate loopback HTTP fixture that compares the native bearer credential to the issued access token and records only the result. No real provider endpoint is contacted.

Each phase uses the same explicitly isolated UUID WebKit store and Keychain service. The runner checks that its unique app data directory was absent before installation, waits for its processes to exit, unregisters/removes only its app bundle, and removes only that app's WebKit directory. Platform data-store deletion API failures from exploratory runs are retained; the passing proof makes no claim that API succeeded.

Reports retain bounded callbacks metadata, actual TLS/provider observations, native event-loop exit markers, source and built-artifact hashes, and cleanup results. The leak check covers retained native/renderer results and logs; renderer assertions cover `localStorage`, `sessionStorage`, and the known raw callback event channel. It does not claim an exhaustive renderer-memory or browser-storage forensic scan.

Current and attempted reports are under `evidence/`; successful evidence is also copied to `docs/validation/results/native-oauth-macos.json`.
