// robots-parser is CJS with an ESM-style `export default` type that NodeNext
// won't treat as callable via import; load it through require with a local type.
import { createRequire } from 'node:module';
import { fetchGuarded } from './net-guard.js';

interface RobotsChecker {
  isAllowed(url: string, ua?: string): boolean | undefined;
}
type RobotsFactory = (url: string, robotsTxt: string) => RobotsChecker;

const require = createRequire(import.meta.url);
const robotsParser = require('robots-parser') as RobotsFactory;

// robots.txt compliance for url_diff sources (SPEC 3.2). We cache per host for
// 24 h and fail-open on fetch errors (a missing/broken robots.txt does not
// block crawling — that is the standard convention).

const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { robots: RobotsChecker; fetchedAt: number }>();

/** Pure check — testable without network. */
export function checkRobots(robotsTxtUrl: string, robotsTxt: string, targetUrl: string, userAgent: string): boolean {
  const robots = robotsParser(robotsTxtUrl, robotsTxt);
  // isAllowed returns undefined when there is no matching rule → treat as allowed.
  return robots.isAllowed(targetUrl, userAgent) !== false;
}

/**
 * Fetch (cached) the host's robots.txt and check whether `targetUrl` is allowed
 * for `userAgent`. Skipped under vitest (no network in unit tests). Fail-open on
 * network/parse errors.
 */
export async function isFetchAllowed(targetUrl: string, userAgent: string, timeoutMs = 10_000): Promise<boolean> {
  if (process.env.VITEST) return true;

  let origin: string;
  let robotsUrl: string;
  try {
    const u = new URL(targetUrl);
    origin = u.origin;
    robotsUrl = `${origin}/robots.txt`;
  } catch {
    return true;
  }

  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) {
    return cached.robots.isAllowed(targetUrl, userAgent) !== false;
  }

  try {
    const res = await fetchGuarded(robotsUrl, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 4xx/5xx or missing robots.txt → allowed (standard convention).
    if (!res.ok) {
      cache.set(origin, { robots: robotsParser(robotsUrl, ''), fetchedAt: Date.now() });
      return true;
    }
    const body = await res.text();
    const robots = robotsParser(robotsUrl, body);
    cache.set(origin, { robots, fetchedAt: Date.now() });
    return robots.isAllowed(targetUrl, userAgent) !== false;
  } catch {
    return true; // fail-open on fetch error
  }
}
