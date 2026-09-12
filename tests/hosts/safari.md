# Installed Safari validation status

Safari storage support remains **unverified**. On 2026-09-08 the installed
Safari 26.5.2 (21624.2.5.11.8) and `/usr/bin/safaridriver` were inspected on
macOS 26.5.2. The driver started on an ephemeral local port and its `/status`
endpoint returned `ready: true`. An actual new-session request for
`browserName: safari` returned HTTP 500, `session not created`, because Safari's
remote automation setting is disabled. The driver then shut down cleanly.

The exact responses are in
[the automation evidence](results/safari-macos-26.5.2-automation.json).
No global Safari settings were changed, no session was established, and no
storage proof was executed. This is an automation access limitation, not an
OPFS, SQLite, or Safari compatibility failure. Apple's
[WebDriver documentation](https://developer.apple.com/documentation/safari-developer-tools/macos-enabling-webdriver)
confirms that Safari automation requires explicit enablement.

The passing [Tauri WKWebView evidence](results/tauri-macos-26.5.2.json) is a
different host. It does not discharge the Safari durability requirement in
[plan 01](../../docs/plans/01_prove_universal_storage.md).
