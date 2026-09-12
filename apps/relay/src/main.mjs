import { open } from 'node:fs/promises';
import { createRelay } from './server.mjs';

const configPath = process.env.QUIXI_RELAY_CONFIG;
if (!configPath) throw new Error('Set QUIXI_RELAY_CONFIG to an operator-owned JSON configuration file');
const file = await open(configPath, 'r');
let content;
try {
  if ((await file.stat()).size > 1024 * 1024) throw new Error('Relay configuration exceeds 1 MiB');
  const buffer = Buffer.alloc(1024 * 1024 + 1);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  if (bytesRead > 1024 * 1024) throw new Error('Relay configuration exceeds 1 MiB');
  content = buffer.subarray(0, bytesRead);
} finally { await file.close(); }
const config = JSON.parse(content.toString('utf8'));
const relay = createRelay(config, { logger: record => { if (process.stdout.writableLength < 65536) process.stdout.write(JSON.stringify(record) + '\n'); } });
const port = Number(process.env.PORT ?? 8081);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
relay.server.listen(port, process.env.HOST ?? '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { relay.close().then(() => process.exit(0)); });
