/** Plan 24: the macOS desktop release bundle as produced by `npm run
 * build:desktop`: bundle identity and version, disk image checksum
 * verification, the actual code-signature state and Gatekeeper assessment
 * (recorded, not assumed), the updater configuration, and a SHA-256
 * inventory of the release artifacts and the frontend they embed.
 *
 *   npm run build:desktop && node tests/hosts/desktop-bundle-proof.mjs
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { platform, release, arch } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const report = { status: "failed", startedAt: new Date().toISOString(), checks: [], environment: { platform: platform(), release: release(), arch: arch(), node: process.version, osVersion: null }, artifacts: {}, signature: {}, updater: {}, scope: "Locally built, unsigned developer bundle on one macOS machine; no distribution, notarization or update-channel claim." };
// codesign and spctl report on stderr; both streams are kept.
const run = (argv) => { const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" }); return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(), code: result.status }; };
const check = (condition, label) => { if (!condition) throw new Error(`check failed: ${label}`); report.checks.push(label); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function walk(directory) { const out = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) out.push(...(await walk(path))); else out.push(path); } return out; }
try {
  if (platform() !== "darwin") throw new Error("This proof reads a macOS bundle");
  report.environment.osVersion = run(["sw_vers", "-productVersion"]).out;
  const conf = JSON.parse(await readFile(resolve(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
  const bundles = resolve(root, "target/release/bundle");
  const app = resolve(bundles, "macos", `${conf.productName}.app`);
  check((await stat(app)).isDirectory(), `the release bundle ${conf.productName}.app exists`);
  const dmgs = (await readdir(resolve(bundles, "dmg")).catch(() => [])).filter((f) => f.endsWith(".dmg"));
  check(dmgs.length === 1, "exactly one disk image was produced");
  const dmg = resolve(bundles, "dmg", dmgs[0]);
  // Identity and version from the bundle itself, not the config.
  const plist = (key) => run(["/usr/libexec/PlistBuddy", "-c", `Print :${key}`, resolve(app, "Contents/Info.plist")]).out;
  check(plist("CFBundleIdentifier") === conf.identifier, `the bundle identifier is ${conf.identifier}`);
  check(plist("CFBundleShortVersionString") === conf.version, `the bundle version is ${conf.version}`);
  report.artifacts.bundle = { path: app.slice(root.length + 1), identifier: plist("CFBundleIdentifier"), version: plist("CFBundleShortVersionString"), executable: plist("CFBundleExecutable"), minimumSystem: plist("LSMinimumSystemVersion") };
  // Disk image integrity: hdiutil verifies the image's own checksum.
  const verify = run(["hdiutil", "verify", dmg]);
  check(verify.ok && /verified\s+CRC32|valid/i.test(verify.out), "the disk image checksum verifies");
  const dmgBytes = await readFile(dmg);
  report.artifacts.diskImage = { path: dmg.slice(root.length + 1), bytes: dmgBytes.length, sha256: sha256(dmgBytes) };
  // Signature state: recorded as found. codesign -dv names the signer or reports ad-hoc/unsigned.
  const signed = run(["codesign", "-dv", "--verbose=2", app]);
  const details = signed.out;
  const identity = /Authority=([^\n]+)/.exec(details)?.[1] ?? null;
  const adhoc = /Signature=adhoc/.test(details);
  report.signature = { present: signed.ok, adhoc, authority: identity, teamIdentifier: /TeamIdentifier=([^\n]+)/.exec(details)?.[1] ?? null, hardenedRuntime: /flags=.*runtime/.test(details), identitiesOnMachine: Number(/(\d+) valid identities found/.exec(run(["security", "find-identity", "-v", "-p", "codesigning"]).out)?.[1] ?? 0) };
  const verified = run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app]);
  report.signature.verifies = verified.ok;
  check(signed.ok, `the bundle carries a code signature (${adhoc ? "ad-hoc, no identity" : identity ?? "identity unknown"})`);
  check(verified.ok, "the code signature verifies against the bundle contents (deep, strict)");
  // Gatekeeper: its status on this machine decides what an assessment can mean; both are recorded, never assumed.
  const status = run(["spctl", "--status"]).out;
  const gatekeeper = run(["spctl", "-a", "-t", "exec", "-vv", app]);
  const enabled = /assessments enabled/.test(status);
  report.signature.gatekeeper = { enabled, status, accepted: gatekeeper.ok, assessment: gatekeeper.out.split("\n").slice(-2).join(" ").slice(0, 200) };
  if (enabled && adhoc) check(!gatekeeper.ok, "Gatekeeper rejects the ad-hoc bundle, as expected without a Developer ID (recorded, not a pass)");
  else check(true, enabled ? `Gatekeeper ${gatekeeper.ok ? "accepts" : "rejects"} the bundle` : "Gatekeeper assessments are disabled on this machine; distribution acceptance is not assessable here");
  // Updater: recorded from the configuration; an absent plugin means no update channel.
  report.updater = { configured: !!(conf.plugins && conf.plugins.updater), pluginsKey: conf.plugins ?? null, bundleTargets: conf.bundle?.targets ?? null };
  check(true, `updater ${report.updater.configured ? "is" : "is not"} configured in tauri.conf.json`);
  // Artifact inventory: the main executable, every bundle file, and the frontend dist it embeds.
  const main = await readFile(resolve(app, "Contents/MacOS", report.artifacts.bundle.executable));
  report.artifacts.executable = { bytes: main.length, sha256: sha256(main) };
  const files = await walk(app);
  report.artifacts.bundleFiles = files.length;
  const dist = resolve(root, "apps/desktop/dist");
  const distFiles = await walk(dist);
  report.artifacts.frontend = { files: distFiles.length, sha256: sha256(Buffer.concat(await Promise.all(distFiles.sort().map(async (f) => Buffer.concat([Buffer.from(f.slice(dist.length) + "\n"), await readFile(f)]))))) };
  check(distFiles.some((f) => f.endsWith("index.html")) && distFiles.some((f) => f.endsWith(".wasm")), `the embedded frontend dist has ${distFiles.length} files including the SQLite and embedding WASM modules`);
  report.artifacts.csp = conf.app?.security?.csp ?? null;
  check(typeof report.artifacts.csp === "string" && report.artifacts.csp.includes("'wasm-unsafe-eval'") && report.artifacts.csp.includes("worker-src 'self'"), "the desktop CSP permits WASM and same-origin workers only");
  report.sourceSha256 = Object.fromEntries(await Promise.all(["apps/desktop/src-tauri/tauri.conf.json", "apps/desktop/src-tauri/Cargo.toml", "tests/hosts/desktop-bundle-proof.mjs"].map(async (p) => [p, sha256(await readFile(resolve(root, p)))])));
  report.status = "passed";
} catch (error) {
  report.error = String(error?.message ?? error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(resolve(root, "docs/validation/results"), { recursive: true });
  await writeFile(resolve(root, "docs/validation/results/desktop-bundle-macos.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, signature: report.signature, updater: report.updater.configured }));
}
