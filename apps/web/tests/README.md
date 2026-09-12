# Browser host contract evidence

Run from the repository root:

```sh
npx tsc --noEmit -p apps/web/tests/tsconfig.json
npx playwright test --config apps/web/tests/playwright.config.ts
```

The suite starts a repository-owned Vite/local HTTP fixture on `127.0.0.1:4196`, loads the real browser host adapter and runs Chromium and Playwright WebKit. It uses synthetic credentials/files exclusively. The fixture is not a deployable relay or part of the production entry point.

Fifteen scenarios run in each browser: session/binding and header rejection; hash-verified staging and cleanup; real stream backpressure and observed upstream disconnect; HTTP errors/redirect rejection/pre-header cancellation/idle timeout; actual file selection and streamed import; adopted dropped-file streaming, release and metadata refusal; registered query names encoded onto the path with unregistered, oversized, control-character and upper-case names refused before dispatch; clipboard writes from a user action with the text bound enforced and Chromium reading the text back; fixed relay request mapping with separate credentials; actual fallback file download; active-request overload/disposal; aggregate provider staging overload/recovery; a 32 MiB disk-backed download surviving immediate release/reload until explicit cleanup; injected picker streaming/cancellation preserving the original destination; and retained-download admission across sessions. Regular persistent browser contexts and independently random OPFS staging namespaces avoid the observed WebKit ephemeral-profile storage failure and cross-profile origin sharing. The download test deliberately disables the optional native picker to test the fallback path.

The complete suite passed **30/30 tests** on 2026-09-10. A compact [disk-file evidence report](./results/disk-files-browser.json) retains the run summary and source hashes. JSON results are written to ignored `apps/web/tests/test-results/web-host-results.json`, with failure traces under `test-results/web-host/`. This verifies the local fixture paths only: installed Safari, native save dialogs, system notification delivery, real-provider CORS/OAuth, and a deployed relay remain separate gates. See the [adapter limitations](../src/host/README.md#remaining-implementation-gates).
