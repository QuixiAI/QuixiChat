# HUMAN_DO: what only you can do to unblock QuixiChat

This is the list of everything the roadmap is waiting on a person for. Each
item says why the loop cannot do it, exactly what to do, what to hand back,
and how it gets verified. Work the items in order; the first three unblock
the most. Nothing here is optional busywork: every item maps to an open
task in `docs/plans/` that says "user gate".

Ground rules that apply to all of them:

- Never paste credentials, exports or captures into chat or commit
  messages. Put files where each item says and tell the loop the path.
- Only redistributable material goes into the repository. Anything with
  your real history stays outside `git` (the items say where).
- Expect the loop to read what you hand over, run the named proofs, and
  update the plan files. You do not need to edit the docs yourself.

## 1. Provider credentials for live qualification (plans 06, 10, 05)

**Why you:** every provider proof so far runs against controlled HTTP
fixtures. The code never makes a real request without your authorization,
and real requests cost money on your account.

**Do this**

1. Create API keys you are willing to spend a few dollars on:
   - Anthropic: https://console.anthropic.com/ → API keys.
   - OpenAI: https://platform.openai.com/api-keys.
   Put a hard spending limit on both accounts first (Anthropic: Plans &
   billing → limits; OpenAI: Billing → usage limits). USD 10 each is plenty.
2. Start the app: `npm run dev` from the repository root, open the printed
   `http://127.0.0.1:1420` URL in Chromium.
3. Open **Providers** in the left rail. For each provider: choose it, paste
   the API key into the "API key" field, press **Check** and confirm the
   health line reports the account as usable and lists models. Keys are
   stored in the browser's own storage for this origin (on the desktop
   build, the macOS keychain); they never enter the archive.
4. Run one conversation per provider from **New conversation**: send a
   message, watch it stream, press **Stop** mid-stream once, then
   **Regenerate**. Try one attachment (a small PNG) with each.
5. Tell the loop: "live credentials are configured in the dev profile for
   Anthropic and OpenAI; you may spend up to USD 10 per provider on
   qualification". State the models you want covered (for example
   `claude-sonnet-5` and `gpt-5-mini`).

**Hand back:** the sentence in step 5. Do not hand over the keys.

**Verified by:** the loop runs the reviewed adapter qualification against
the live endpoints (streaming, stop, images, PDFs, token counting, health
refusals) and records `docs/validation/live-providers.md` with request
counts and cost. Plan 06's last task and plan 05's live-provider line close.

## 2. Real-model summary fidelity scoring (plan 10)

**Why you:** ten authored quality cases exist
(`research/context-summary/quality-fixtures.json`, field `modelRuns` is
still `0`), but whether a real model's summary keeps the required claims is
a human judgement, and it needs item 1's credentials.

**Do this** (after item 1)

1. Ask the loop to run the ten cases through the summary workflow with each
   live model; it will produce `research/context-summary/results/model-runs/`
   with one file per case and model containing the generated summary and
   the case's "required claims" checklist.
2. For each file, read the summary and tick each required claim as
   `kept`, `lost` or `contradicted`. Add one line of notes if a summary
   invented a fact. Twenty minutes for the full set.
3. Save your scoring as `research/context-summary/results/model-runs/scores.json`
   (the loop generates the empty template with your name and the date).

**Hand back:** the completed `scores.json`.

**Verified by:** the loop computes claim retention per model, records it in
`docs/validation/context-summaries.md`, and closes plan 10's compaction task.

## 3. Official ChatGPT and Claude export captures (plan 04)

**Why you:** the importers are qualified only on synthetic fixtures that
imitate the documented shapes. Real exports come from your accounts, and
the repository can only keep captures you are allowed to redistribute.

**Do this**

1. ChatGPT: chatgpt.com → Settings → Data controls → **Export data**. Wait
   for the email, download the ZIP.
2. Claude: claude.ai → Settings → Privacy → **Export data**. Download the
   ZIP.
3. Put both ZIPs, unmodified, under `~/QuixiCaptures/` (outside the repo).
   Tell the loop the two paths. It will import them through the production
   panel in both browser engines and report what parsed, what was skipped
   and why, without copying any of your history into the repository.
4. For the repository fixture that plan 04 requires, create a small
   redistributable capture: in each service, make a **new** conversation of
   three or four turns using only invented content (for example, ask for a
   haiku about a fictional planet), export again, and this time tell the
   loop it may keep that conversation's records as a fixture under
   `packages/importers/tests/fixtures/`. Say explicitly: "the conversation
   titled X in this export may be redistributed."

**Hand back:** the two full-export paths (private) and the one sanctioned
conversation title per service (public).

**Verified by:** production import proofs over the full exports (private
results, counts only) and the new fixtures added to the importer suite with
the observed format versions documented. Plan 04 closes.

## 4. Real chatgpt.com run of the browser extension (plan 11)

**Why you:** the extension is proven end to end only against a synthetic
ChatGPT origin. A real run needs a logged-in chatgpt.com session, which is
yours.

**Do this**

1. `npm run build:extension` → open `chrome://extensions` in Chrome or
   Chromium, enable Developer mode, **Load unpacked**, choose
   `apps/extension/dist`.
2. Start the app (`npm run dev`) and open it in the same browser. Open
   **Import history** → the extension section shows the origin and a
   six-digit pairing code.
3. Open chatgpt.com, logged in. Click the extension icon, enter the Quixi
   origin (`http://127.0.0.1:1420`) and the pairing code, choose "only new
   conversations", and start the transfer.
4. In Quixi, an offer appears with the provenance. Accept it. Wait for the
   import to complete, then search for a phrase from one of the imported
   conversations.
5. Repeat step 3 once more: the second transfer must import nothing new.

**Hand back:** a note with the number of conversations offered, imported and
skipped on the first and second runs, and whether the search found the
phrase. If anything failed, the exact message shown.

**Verified by:** the loop records the run in
`docs/validation/extension-import.md` and closes plan 11's acceptance line.
(Desktop pairing for the Tauri app is engineering work the loop does
itself; it is not on you.)

## 5. Apple Developer ID for a distributable desktop build (plan 24)

**Why you:** the macOS bundle is ad-hoc signed because this machine has no
signing identity; Gatekeeper on any other Mac will refuse it. Enrolling in
the Apple Developer Program and creating certificates requires your Apple
ID and payment.

**Do this**

1. Enroll at https://developer.apple.com/programs/ (USD 99/year).
2. In Xcode → Settings → Accounts, add the Apple ID and press **Manage
   Certificates** → **+** → **Developer ID Application**. Confirm with
   `security find-identity -v -p codesigning`; it must list one
   "Developer ID Application: …" identity.
3. Create an app-specific password at https://appleid.apple.com/ for
   notarization and store it once:
   `xcrun notarytool store-credentials quixi-notary --apple-id <id> --team-id <TEAM> --password <app-specific-password>`.
4. Tell the loop the exact identity string and that the keychain profile
   `quixi-notary` exists. Say whether you want an auto-updater (it needs a
   public HTTPS location for update manifests; if unsure, say no for now).

**Hand back:** the identity string and the profile name (no passwords).

**Verified by:** `APPLE_SIGNING_IDENTITY="Developer ID Application: …" npm run build:desktop`,
notarization with the stored profile, then
`node tests/hosts/desktop-bundle-proof.mjs` recording a Gatekeeper accept.
Plan 24's signing line closes; the updater stays a recorded decision.

## 6. Installed Safari storage verification (plans 01 and 24)

**Why you:** Safari refuses automation until its Develop menu setting is
switched on, which changes a global browser setting on your Mac.

**Do this**

1. Safari → Settings → Advanced → tick **Show features for web developers**.
2. Safari → Develop menu → **Allow Remote Automation**.
3. Run `/usr/bin/safaridriver --enable` once in Terminal and enter your
   password.
4. Tell the loop "Safari remote automation is enabled".
5. When it is done, untick **Allow Remote Automation** again if you prefer.

**Hand back:** the sentence in step 4.

**Verified by:** the storage proof and the shared-app proof run in installed
Safari (`QUIXI_TEST_BROWSERS=safari`), and the host matrix row moves from
"unverified" to a measured result.

## 7. Other hardware runs (plans 19, 21, 24)

**Why you:** this machine is one Apple M5 Max with no GPU adapter in headless
Chromium. The WebGPU matrix, Windows and Linux hosts need other machines.

**Do this** on each machine you can lend (a Windows PC with a discrete GPU,
a Linux desktop with a recent WebKitGTK, an Intel or AMD Mac if you have one):

1. Install Node 22 and clone the repository. Run `npm ci`.
2. Copy `packages/quixi-embed/build/arctic-xs.qxmodel` from this Mac to the
   same path (it is not in git).
3. Run, in this order, and keep the JSON they write:
   ```sh
   npm run check
   npm run test:app:semantic:browser
   npm run test:embed:self-test
   npm run test:gpu:full --workspace @quixi/quixi-embed
   ```
   On Linux desktop additionally:
   ```sh
   npm run build --workspace @quixi/desktop
   python3 tests/hosts/linux/run.py --output tests/hosts/results/tauri-linux-<distro>-<arch>.json
   ```
   On Windows: `npm run build:desktop` and open the produced installer, then
   run `npm run test:app:storage-health:browser` with
   `QUIXI_TEST_BROWSERS=chromium`.
4. Zip the `results/` folders those commands wrote plus the exact CPU, GPU,
   OS and browser versions, and give the zip to the loop.

**Hand back:** one zip per machine.

**Verified by:** the loop adds each machine as a row in the host matrix and
the GPU family matrix with the retained reports; plans 19 and 21 close
their hardware lines and plan 24 gains real host rows.

## 8. Assistive-technology sessions (plan 13)

**Why you:** automated audits pass, but the plan requires the core
workflows to be completed with an actual screen reader, which is a human
session.

**Do this** (about 45 minutes, on this Mac with VoiceOver: press Cmd+F5)

1. `npm run dev`, open the app in Safari or Chromium with VoiceOver on.
2. Using only the keyboard and VoiceOver, complete each of these and write
   down where you got stuck or what was announced wrongly:
   - import the synthetic ChatGPT fixture through **Import history**
     (`packages/importers/tests/fixtures/chatgpt-observed.synthetic.json`);
   - open a conversation, move to a sibling branch, and back;
   - switch provider on a conversation and accept the compatibility review;
   - export the archive through **Export history** and save the file;
   - search for a phrase and open the hit.
3. If you have access to a Windows machine with NVDA, repeat the same list
   there with Chrome.

**Hand back:** your notes, in any form, naming the step, what you expected
to hear or reach, and what happened.

**Verified by:** the loop turns each note into a fix or a recorded
limitation in `docs/validation/accessibility-open-findings.md` and closes
plan 13's last criterion when the list completes without a blocker.

## 9. Production web hosting (plan 24)

**Why you:** the Docker image is proven on loopback; serving `quixi.ai`
needs a domain, a TLS certificate and a host you pay for.

**Do this**

1. Pick a host that runs a container (Fly.io, Render, a VPS with Docker).
2. Build and push the image from this repository:
   ```sh
   docker build -f deploy/docker/Dockerfile -t <registry>/quixi-web:<date> .
   docker push <registry>/quixi-web:<date>
   ```
3. Run it behind HTTPS on your domain. The reverse proxy must pass through
   the response headers the container sends (COOP/COEP) and must not log the
   query string of `/oauth/callback.html`; `deploy/docker/README.md` lists
   both requirements.
4. Tell the loop the public URL.

**Hand back:** the URL.

**Verified by:** `node tests/hosts/web-hosting-proof.mjs` gains a remote
mode and records headers, isolation and the storage backend on the real
origin; the release page's host row updates.

## 10. Decide two things

These need a decision, not work:

1. **Attachments at 10–50 GB (plan 24).** This Mac's browser quota is about
   10 GB (Chromium) and 20 GB (WebKit), so the workload cannot run here.
   Either lend a machine with a larger quota (Chromium grants more with a
   larger free disk) or accept the smaller measured limit as the released
   one. Say which.
2. **Hosted CI.** You turned the GitHub workflow off. Leave it off, or say
   when you want it back and the loop will make it green first.

## What is not on you

Everything else open is engineering the loop keeps doing on its own: the
export's remaining per-step cost, desktop pairing for the extension, plan
07's relevance study on the synthetic corpus, and the eighth 1M-message run
that is producing the final scale record.
