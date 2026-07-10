import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// SSRF guard. Outbound URLs supplied by API clients (webhook callback_url,
// watcher source URLs) must not be able to reach private/link-local ranges —
// otherwise a prompt-compromised agent or a malicious watcher config turns the
// server into a proxy onto internal networks or the cloud metadata endpoint
// (169.254.169.254). See PLAYBOOK A7 / B1.
//
// Self-host operators who legitimately watch an intranet URL can opt out with
// IMPRI_ALLOW_PRIVATE_TARGETS=1.

const OPT_OUT_ENV = 'IMPRI_ALLOW_PRIVATE_TARGETS';

export function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true; // this-host, RFC1918, loopback
    if (a === 169 && b === 254) return true;           // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
    if (a === 192 && b === 168) return true;           // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;      // loopback / unspecified
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7)); // v4-mapped
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;   // unique-local
    if (lower.startsWith('fe80')) return true;              // link-local
    return false;
  }
  return false;
}

/**
 * Throws if `rawUrl` is not http/https or resolves to a private address.
 * Resolving before fetch narrows (but does not fully close) the DNS-rebinding
 * window — full mitigation would require pinning the resolved IP through the
 * socket. Tracked as residual risk in PLAYBOOK.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  if (process.env[OPT_OUT_ENV] === '1') return;

  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }

  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`Blocked private address: ${host}`);
    return;
  }

  const resolved = await lookup(host, { all: true });
  for (const r of resolved) {
    if (isPrivateIp(r.address)) {
      throw new Error(`Blocked: ${host} resolves to private address ${r.address}`);
    }
  }
}
