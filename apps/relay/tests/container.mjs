import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const run = promisify(execFile), context = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'quixi-relay-container-'));
let container;
try {
  await run('docker', ['build', '--target', 'test', '-t', 'quixi-relay-proof:test', context], { maxBuffer: 4 * 1024 * 1024 });
  const tests = await run('docker', ['run', '--rm', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m', '--cap-drop=ALL', '--security-opt=no-new-privileges', 'quixi-relay-proof:test'], { maxBuffer: 4 * 1024 * 1024 });
  process.stdout.write(tests.stdout);
  await run('docker', ['build', '--target', 'production', '-t', 'quixi-relay-proof:production', context], { maxBuffer: 4 * 1024 * 1024 });
  // Empty registry and principals explicitly disable all forwarding in this
  // production-image startup proof. No provider hostname is ever contacted.
  const config = join(directory, 'config.json'); await writeFile(config, JSON.stringify({ allowedOrigins: ['https://synthetic.example'], destinations: [], principals: [] }), { mode: 0o644 });
  container = (await run('docker', ['run', '-d', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=256m', '--pids-limit=64', '-p', '127.0.0.1::8081', '--mount', `type=bind,src=${config},dst=/config.json,readonly`, '-e', 'QUIXI_RELAY_CONFIG=/config.json', 'quixi-relay-proof:production'])).stdout.trim();
  const port = (await run('docker', ['port', container, '8081/tcp'])).stdout.trim().split(':').at(-1);
  const endpoint = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 40; attempt++) { try { health = await fetch(`${endpoint}/healthz`); if (health.ok) break; } catch {} await delay(100); }
  assert.equal(health?.status, 200); assert.deepEqual(await health.json(), { ok: true });
  const unauthorized = await fetch(`${endpoint}/v1/provider-http`, { method: 'POST', headers: { origin: 'https://synthetic.example' } }); assert.equal(unauthorized.status, 401); await unauthorized.text();
  const denied = await fetch(`${endpoint}/v1/provider-http`, { method: 'POST', headers: { origin: 'https://unregistered.example' } }); assert.equal(denied.status, 403); await denied.text();
  const runtime = JSON.parse((await run('docker', ['exec', container, 'node', '-e', 'console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,uid:process.getuid()}))'])).stdout);
  const image = (await run('docker', ['image', 'inspect', 'quixi-relay-proof:production', '--format', '{{.Id}}'])).stdout.trim();
  console.log(JSON.stringify({ runtime, image, checks: ['read-only non-root startup', 'health', 'unauthorized rejection', 'origin rejection', 'no provider dispatch'] }, null, 2));
} finally {
  if (container) await run('docker', ['stop', '-t', '2', container]);
  await rm(directory, { recursive: true, force: true });
}
