import { createServer } from "vite";
import { fileURLToPath } from "node:url";
let dispatched = 0; let disconnected = 0;
const fixture = (request, response, next) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1:4196");
  if (!url.pathname.startsWith("/fixture/") && url.pathname !== "/v1/provider-http") return next();
  if (url.pathname === "/fixture/stats") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ dispatched, disconnected })); return; }
  dispatched++;
  if (url.pathname === "/fixture/redirect") { response.writeHead(307, { Location: "/fixture/echo" }); response.end(); return; }
  if (url.pathname === "/fixture/slow") { const timer = setTimeout(() => response.end("late"), 10_000); response.on("close", () => { clearTimeout(timer); disconnected++; }); return; }
  if (url.pathname === "/fixture/stream" || url.pathname === "/fixture/idle") {
    response.writeHead(200, { "Content-Type": "text/event-stream" }); response.flushHeaders();
    let count = 0;
    const timer = setInterval(() => { if (url.pathname.endsWith("idle") && count > 0) return; if (count++ >= 500) { clearInterval(timer); response.end(); } else response.write(new Uint8Array(8192).fill(65)); }, 10);
    response.on("close", () => { clearInterval(timer); disconnected++; }); return;
  }
  const chunks = []; let size = 0;
  request.on("data", chunk => { size += chunk.length; if (size > 8_388_608) request.destroy(); else chunks.push(chunk); });
  request.on("end", () => {
    response.writeHead(url.pathname === "/fixture/error" ? 429 : 200, { "Content-Type": "application/json", "Retry-After": "3", "Set-Cookie": "fixture=ignored" });
    response.end(JSON.stringify({ url: request.url, bytes: size, body: Buffer.concat(chunks).toString(), authorized: request.headers.authorization === "Bearer synthetic-secret", relayAuthorized: request.headers.authorization === "Bearer synthetic-relay", providerAuthorized: request.headers["x-quixi-provider-authorization"] === "synthetic-secret", destination: request.headers["x-quixi-destination"] ?? null, method: request.headers["x-quixi-method"] ?? request.method, path: request.headers["x-quixi-path"] ?? url.pathname }));
  });
};
const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { host: "127.0.0.1", port: 4196, strictPort: true }, plugins: [{ name: "synthetic-host-fixture", configureServer(server) { server.middlewares.use(fixture); } }] });
await server.listen();
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, async () => { await server.close(); process.exit(0); });
