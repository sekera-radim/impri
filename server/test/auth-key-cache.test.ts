/**
 * auth-key-cache.test.ts
 *
 * verifyApiKey() must not pay argon2.verify on every request (it starved the
 * production vCPU), and skipping it must never keep a revoked or replaced key
 * alive.
 *
 * Run: cd server && npm test -- auth-key-cache
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import argon2 from 'argon2';
import { createDb, nowSec } from '../src/db.js';
import { bootstrapAdminKey, verifyApiKey } from '../src/auth.js';

// Every test bootstraps its own random key, so the module-level cache never
// carries an entry from one test into another.
async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const verifySpy = vi.spyOn(argon2, 'verify');
  return { db, key: bootstrap!.key, verifySpy };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('verifyApiKey — verified-key cache', () => {
  it('runs argon2 once for repeated requests with the same key', async () => {
    const { db, key, verifySpy } = await setup();

    const first = await verifyApiKey(db, key);
    const second = await verifyApiKey(db, key);
    const third = await verifyApiKey(db, key);

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it('shares one argon2 verification between concurrent cold requests', async () => {
    const { db, key, verifySpy } = await setup();

    const records = await Promise.all([
      verifyApiKey(db, key),
      verifyApiKey(db, key),
      verifyApiKey(db, key),
      verifyApiKey(db, key),
    ]);

    expect(records.every(r => r !== null && r.id === records[0]!.id)).toBe(true);
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a cached key on the first request after it is revoked', async () => {
    const { db, key, verifySpy } = await setup();
    const record = await verifyApiKey(db, key);

    db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(nowSec(), record!.id);

    expect(await verifyApiKey(db, key)).toBeNull();
    // Revoked rows are filtered out before argon2, so no second verification.
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it('does not let a wrong key ride on a cached key with the same prefix', async () => {
    const { db, key, verifySpy } = await setup();
    await verifyApiKey(db, key);

    const lastChar = key.at(-1) === 'A' ? 'B' : 'A';
    const wrongKey = key.slice(0, -1) + lastChar;

    expect(await verifyApiKey(db, wrongKey)).toBeNull();
    expect(verifySpy).toHaveBeenCalledTimes(2);
    // A failed attempt must not be cached as a success either.
    expect(await verifyApiKey(db, wrongKey)).toBeNull();
    expect(verifySpy).toHaveBeenCalledTimes(3);
  });

  it('drops the cached entry when the stored hash is replaced', async () => {
    const { db, key, verifySpy } = await setup();
    const record = await verifyApiKey(db, key);

    const otherHash = await argon2.hash('im_some-other-key-material-entirely');
    db.prepare('UPDATE api_keys SET key_hash = ? WHERE id = ?').run(otherHash, record!.id);

    expect(await verifyApiKey(db, key)).toBeNull();
    // The old entry was discarded, so the key went through argon2 again.
    expect(verifySpy).toHaveBeenCalledTimes(2);
  });

  it('re-verifies with argon2 once the cache entry expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { db, key, verifySpy } = await setup();

    await verifyApiKey(db, key);
    vi.setSystemTime(Date.now() + 4 * 60_000);
    await verifyApiKey(db, key);
    expect(verifySpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 2 * 60_000);
    expect(await verifyApiKey(db, key)).not.toBeNull();
    expect(verifySpy).toHaveBeenCalledTimes(2);
  });
});
