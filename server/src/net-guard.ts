import { lookup } from 'node:dns/promises';
import dns from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';

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

// Shared dispatcher whose DNS lookup validates AND pins the address at connect
// time. Because the private-IP check happens inside the same lookup that hands
// the socket its address, there is no window for a DNS rebind to swap in a
// private IP between validation and connect (the residual TOCTOU that
// assertPublicUrl alone can't close). TLS still validates the original hostname.
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    for (const a of list) {
      if (isPrivateIp(a.address)) {
        return callback(new Error(`Blocked private address ${a.address} for ${hostname}`), '', 0);
      }
    }
    // Node >=20 connects with autoSelectFamily (Happy Eyeballs): net.connect then
    // calls lookup with { all: true } and expects the ADDRESS LIST back. Returning
    // a single (address, family) pair there kills the connection with a bare
    // "fetch failed" — the bug behind failing Slack OAuth exchange and watcher runs.
    if ((options as { all?: boolean } | undefined)?.all) {
      (callback as unknown as (e: NodeJS.ErrnoException | null, addrs: dns.LookupAddress[]) => void)(null, list);
      return;
    }
    const chosen = list[0];
    callback(null, chosen.address, chosen.family);
  });
};

const guardedDispatcher = new Agent({ connect: { lookup: guardedLookup } });

/**
 * fetch() that refuses private/link-local targets and pins the connection to a
 * validated IP (full DNS-rebinding mitigation). Use for every outbound request
 * to a client-supplied URL (webhooks, watcher sources). Opt out per instance
 * with IMPRI_ALLOW_PRIVATE_TARGETS=1.
 */
export async function fetchGuarded(rawUrl: string, init?: RequestInit): Promise<Response> {
  if (process.env.IMPRI_ALLOW_PRIVATE_TARGETS === '1') return fetch(rawUrl, init);

  const u = new URL(rawUrl);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  // Literal IPs skip DNS entirely (net.connect wouldn't call our lookup), so
  // validate them here.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateIp(host)) {
    throw new Error(`Blocked private address: ${host}`);
  }
  return fetch(rawUrl, { ...init, dispatcher: guardedDispatcher } as RequestInit & { dispatcher: Agent });
}
