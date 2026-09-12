import { createHash } from 'node:crypto';
import { publicNetworkPolicy } from './policy.mjs';
const stableJson = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(stableJson(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(stableJson(value[key]))])) : value);
const identifier = /^[A-Za-z0-9_-]{1,80}$/;
const header = /^[a-z][a-z0-9-]{0,79}$/;
export const forbiddenHeader = name => /^(authorization|cookie|set-cookie|host|connection|keep-alive|te|trailer|transfer-encoding|upgrade|content-length|accept-encoding|expect|proxy-.*|sec-.*|x-quixi-.*)$/i.test(name);
const exactKeys = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !names.includes(k))) throw new Error('Unknown configuration field');
};
const integer = (value, fallback, max) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error('Invalid configuration bound');
  return result;
};
export function parseConfig(input, policy = publicNetworkPolicy) {
  exactKeys(input, ['allowedOrigins', 'destinations', 'principals', 'limits', 'regionalProcessing']);
  const regional = input.regionalProcessing;
  if (regional !== undefined) {
    exactKeys(regional, ['operator', 'region']);
    if (typeof regional.operator !== 'string' || !regional.operator || regional.operator !== regional.operator.trim() || /[\u0000-\u001f\u007f]/.test(regional.operator) || regional.operator.length > 256 || !['us','eu'].includes(regional.region)) throw new Error('Invalid regional processing declaration');
  }
  if (!Array.isArray(input.allowedOrigins) || !input.allowedOrigins.length || input.allowedOrigins.length > 64) throw new Error('Explicit allowedOrigins required');
  const origins = new Set(input.allowedOrigins.map(origin => {
    const u = new URL(origin);
    if (u.origin !== origin || u.username || u.password || !['https:', 'http:'].includes(u.protocol) || (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error('Invalid allowed origin');
    return origin;
  }));
  if (!Array.isArray(input.destinations) || input.destinations.length > 128) throw new Error('Invalid destinations');
  const destinations = new Map();
  for (const destination of input.destinations) {
    exactKeys(destination, ['id', 'origin', 'routes', 'credential', 'processingRegion']);
    const url = new URL(destination.origin);
    if (!identifier.test(destination.id) || destinations.has(destination.id) || url.origin !== destination.origin || url.username || url.password) throw new Error('Invalid destination');
    policy.validateOrigin(url);
    exactKeys(destination.credential, ['header', 'prefix', 'required']);
    const name = destination.credential.header?.toLowerCase();
    if (!header.test(name ?? '') || (forbiddenHeader(name) && name !== 'authorization') || typeof destination.credential.prefix !== 'string' || /[^\x20-\x7e]/.test(destination.credential.prefix) || destination.credential.prefix.length > 32 || typeof destination.credential.required !== 'boolean') throw new Error('Invalid credential scheme');
    if (!Array.isArray(destination.routes) || !destination.routes.length || destination.routes.length > 64) throw new Error('Invalid routes');
    const routes = new Map();
    for (const route of destination.routes) {
      exactKeys(route, route.query === undefined ? ['path', 'methods', 'headers'] : ['path', 'methods', 'headers', 'query']);
      if (route.query !== undefined && (!Array.isArray(route.query) || route.query.length > 8 || route.query.some(q => typeof q !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(q)))) throw new Error('Invalid route query names');
      // Deliberately exclude escaped/dot segments, query strings and fragments.
      if (typeof route.path !== 'string' || route.path.length > 256 || !/^\/[A-Za-z0-9_/-]*$/.test(route.path) || route.path.includes('//') || routes.has(route.path)) throw new Error('Invalid exact route');
      if (!Array.isArray(route.methods) || !route.methods.length || route.methods.some(m => !['GET', 'POST', 'PUT', 'DELETE'].includes(m))) throw new Error('Invalid route methods');
      if (!Array.isArray(route.headers) || route.headers.length > 16 || route.headers.some(h => !header.test(h) || forbiddenHeader(h) || h === name || h === 'origin' || h === 'referer')) throw new Error('Invalid route headers');
      routes.set(route.path, { methods: new Set(route.methods), headers: new Set(route.headers), query: new Set(route.query ?? []) });
    }
    const credential = { ...destination.credential, header: name };
    let regionalDeclaration = null;
    if (destination.processingRegion !== undefined) {
      if (!['us','eu'].includes(destination.processingRegion) || !regional || destination.processingRegion !== regional.region || url.origin !== `https://${regional.region}.api.openai.com`) throw new Error('Regional destination must match the declared region and exact reviewed OpenAI upstream');
      if (name !== 'authorization' || credential.prefix !== 'Bearer ' || credential.required !== true) throw new Error('Regional destinations require Authorization Bearer credentials');
      const models = routes.get('/v1/models'), completions = routes.get('/v1/chat/completions');
      if (routes.size !== 2 || !models || !completions || models.methods.size !== 1 || !models.methods.has('GET') || models.headers.size !== 0 || models.query.size !== 0 || completions.methods.size !== 1 || !completions.methods.has('POST') || completions.headers.size !== 1 || !completions.headers.has('content-type') || completions.query.size !== 0) throw new Error('Regional destinations require only the reviewed models GET and chat completions POST routes');
      const identity = { version: 1, operator: regional.operator, region: regional.region, destination: { id: destination.id, origin: url.origin, credential, routes: [...routes.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, route]) => ({ path, methods: [...route.methods].sort(), headers: [...route.headers].sort(), query: [...route.query].sort() })) } };
      regionalDeclaration = Object.freeze({ version: 1, configurationId: createHash('sha256').update(stableJson(identity)).digest('hex'), operator: regional.operator, region: regional.region, destinationId: destination.id, upstreamOrigin: url.origin });
    }
    destinations.set(destination.id, { id: destination.id, url, routes, credential, regionalDeclaration });
  }
  if (!Array.isArray(input.principals) || input.principals.length > 256) throw new Error('Invalid principals');
  const ids = new Set(), hashes = new Set();
  const principals = input.principals.map(p => {
    exactKeys(p, ['id', 'tokenSha256', 'destinations', 'maxConcurrent', 'requestsPerMinute', 'burst']);
    if (!identifier.test(p.id) || ids.has(p.id) || !/^[a-f0-9]{64}$/.test(p.tokenSha256) || hashes.has(p.tokenSha256)) throw new Error('Invalid principal');
    if (!Array.isArray(p.destinations) || p.destinations.some(id => !destinations.has(id))) throw new Error('Invalid principal destinations');
    ids.add(p.id); hashes.add(p.tokenSha256);
    return { id: p.id, hash: Buffer.from(p.tokenSha256, 'hex'), destinations: new Set(p.destinations), maxConcurrent: integer(p.maxConcurrent, 2, 64), requestsPerMinute: integer(p.requestsPerMinute, 30, 10000), burst: integer(p.burst, 10, 1000) };
  });
  const l = input.limits ?? {};
  exactKeys(l, ['maxConcurrent', 'requestsPerMinute', 'burst', 'maxUploadBytes', 'maxResponseBytes', 'totalMs', 'idleMs', 'maxConnections']);
  const limits = {
    maxConcurrent: integer(l.maxConcurrent, 8, 128), requestsPerMinute: integer(l.requestsPerMinute, 120, 100000), burst: integer(l.burst, 32, 10000),
    maxUploadBytes: integer(l.maxUploadBytes, 8 * 1024 * 1024, 1024 * 1024 * 1024), maxResponseBytes: integer(l.maxResponseBytes, 64 * 1024 * 1024, 1024 * 1024 * 1024),
    totalMs: integer(l.totalMs, 120000, 600000), idleMs: integer(l.idleMs, 30000, 120000), maxConnections: integer(l.maxConnections, 64, 1024),
  };
  return { origins, destinations, principals, limits };
}

/** Public non-secret declaration for authenticated client provisioning. The complete
 * config is validated; tokens and principal hashes never enter the identity. */
export function regionalConfiguration(input, destinationId, policy = publicNetworkPolicy) {
  const destination = parseConfig(input, policy).destinations.get(destinationId);
  if (!destination?.regionalDeclaration) throw new Error('A declared regional destination is required');
  return { ...destination.regionalDeclaration };
}
