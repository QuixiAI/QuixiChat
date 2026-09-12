import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

// Conservative allow policy: special-purpose ranges are unavailable even when
// individual addresses within them have public exceptions. IPv6 is restricted
// to global unicast and excludes its special-purpose allocations.
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) return globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
  return false;
}
export const publicNetworkPolicy = Object.freeze({
  validateOrigin(url) {
    if (url.protocol !== 'https:' || (url.port && url.port !== '443') || isIP(url.hostname)) {
      throw new Error('Destinations require HTTPS DNS names on port 443');
    }
  },
  async resolve(url) {
    const answers = await lookup(url.hostname, { all: true, verbatim: true });
    if (!answers.length || answers.length > 16 || answers.some(a => !isPublicAddress(a.address))) {
      throw new Error('Destination resolves to an unavailable address range');
    }
    return answers.find(a => a.family === 4) ?? answers[0];
  },
});
