/**
 * Email notification channels — address confirmation, limits and daily cap.
 *
 * Covers:
 * - create → confirmation email (fixed text) → GET shows a button only →
 *   POST confirms → notifications flow (with the footer)
 * - invalid / expired / reused tokens, confirmation page headers
 * - per-channel cooldown, per-address and per-project 24 h limits
 * - no SMTP: create/PATCH refused, sends throw
 * - PATCH with a new address resets confirmation
 * - unconfirmed channels skipped by notifyChannels and the digest tick
 * - IMPRI_EMAIL_DAILY_CAP: capped sends are retried, never count as failures
 * - create/PATCH queue the confirmation email and respond before SMTP does;
 *   a late failure does not wipe a newer link; the SMTP transport has timeouts
 * - send failures release the limit slot; the owner retries, not the tick
 * - migration of a pre-verification DB + background tick
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, nowSec } from '../src/db.js';
import { bootstrapAdminKey, createProjectWithAdminKey } from '../src/auth.js';
import { createApp, redactUrlSecrets } from '../src/index.js';
import { runChannelDigestTick } from '../src/notify.js';
import { runEmailVerificationTick, sendChannelVerification } from '../src/email-verification.js';
import { hashEmailAddress } from '../src/email-sends.js';
import type { Logger } from '../src/metrics.js';

process.env.DISABLE_WATCHER_SCHEDULER = '1';
process.env.BASE_URL = 'https://api.example.test';

const sendMail = vi.hoisted(() => vi.fn());
const transportOptions = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      transportOptions.push(options);
      return { sendMail };
    },
  },
}));

interface SentMail { to: string; subject: string; text: string }

function mails(): SentMail[] {
  return sendMail.mock.calls.map(c => c[0] as SentMail);
}

function verifyMails(): SentMail[] {
  return mails().filter(m => m.subject === 'Confirm your email for Impri notifications');
}

function notifyMails(): SentMail[] {
  return mails().filter(m => m.subject.startsWith('[Impri] '));
}

// Create/PATCH send the confirmation email after responding. The mocked
// sendMail settles on a microtask, so one macrotask turn lets it finish.
function flushQueuedSends(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function tokenFrom(mail: SentMail): string {
  const m = /\/v1\/notification-channels\/verify\?token=([A-Za-z0-9_-]{43})/.exec(mail.text);
  if (!m) throw new Error('no confirmation link in mail');
  return m[1];
}

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

function auth(key: string) {
  return { Authorization: `Bearer ${key}` };
}

async function createEmailChannel(ctx: Pick<Ctx, 'app'>, key: string, address: string, extra: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/notification-channels',
    headers: auth(key),
    payload: { name: 'Ops mail', type: 'email', config: { address }, ...extra },
  });
  await flushQueuedSends();
  return res;
}

async function postForm(ctx: Pick<Ctx, 'app'>, token: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/notification-channels/verify',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `token=${encodeURIComponent(token)}`,
  });
}

async function createAction(ctx: Pick<Ctx, 'app'>, key: string, title: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: auth(key),
    payload: { kind: 'test.kind', title, preview: { format: 'plain', body: title } },
  });
  expect(res.statusCode).toBe(201);
  // notifyChannels is fire-and-forget after the response.
  await new Promise(r => setTimeout(r, 50));
}

function channelRow(db: Ctx['db'], id: string) {
  return db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(id) as {
    verified_at: number | null;
    verify_token_hash: string | null;
    verify_sent_at: number | null;
    fail_count: number;
    enabled: number;
    digest_queue: string;
    last_fired_at: number | null;
  };
}

beforeEach(() => {
  process.env.SMTP_HOST = 'smtp.test.invalid';
  delete process.env.IMPRI_EMAIL_DAILY_CAP;
  sendMail.mockReset();
  sendMail.mockResolvedValue({ messageId: 'test' });
  transportOptions.length = 0;
});

afterEach(() => {
  delete process.env.IMPRI_EMAIL_DAILY_CAP;
});

// ---------------------------------------------------------------------------

describe('confirmation flow', () => {
  it('create → mail → GET does not confirm → POST confirms → notifications are delivered', async () => {
    const ctx = await setup();
    const res = await createEmailChannel(ctx, ctx.adminKey, 'owner@example.com', { name: 'Secret <b>name</b>' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.verified).toBe(false);
    expect(body.verification_queued).toBe(true);
    expect(body.verification_sent_at).toBeTypeOf('number');
    expect(body.verify_token_hash).toBeUndefined();

    // Exactly one email: the confirmation, fixed text, no project content.
    expect(mails()).toHaveLength(1);
    const mail = verifyMails()[0];
    expect(mail.to).toBe('owner@example.com');
    expect(mail.text).not.toContain('Secret');
    expect(mail.text).not.toContain('Default Project');
    expect(mail.text).toContain("If you didn't set this up, ignore this email");
    const token = tokenFrom(mail);

    // Nothing is delivered before confirmation.
    await createAction(ctx, ctx.adminKey, 'Before confirm');
    expect(notifyMails()).toHaveLength(0);

    // GET (what a mail scanner does) only renders the button.
    const page = await ctx.app.inject({ method: 'GET', url: `/v1/notification-channels/verify?token=${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("form-action 'self'");
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.body).toContain('<form method="post" action="/v1/notification-channels/verify">');
    expect(channelRow(ctx.db, body.id).verified_at).toBeNull();

    // POST confirms.
    const confirm = await postForm(ctx, token);
    expect(confirm.statusCode).toBe(200);
    expect(confirm.body).toContain('Email confirmed');
    const row = channelRow(ctx.db, body.id);
    expect(row.verified_at).not.toBeNull();
    expect(row.verify_token_hash).toBeNull();

    const audit = ctx.db.prepare(
      "SELECT actor, data FROM audit_log WHERE event = 'channel.verified'",
    ).all() as { actor: string; data: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe('email-link');
    expect(audit[0].data).not.toContain('owner@');

    const get = await ctx.app.inject({
      method: 'GET', url: `/v1/notification-channels/${body.id}`, headers: auth(ctx.adminKey),
    });
    expect(get.json().verified).toBe(true);

    // Single use.
    const again = await postForm(ctx, token);
    expect(again.statusCode).toBe(404);

    // Now notifications flow, with the footer explaining how to stop them.
    await createAction(ctx, ctx.adminKey, 'After confirm');
    expect(notifyMails()).toHaveLength(1);
    expect(notifyMails()[0].to).toBe('owner@example.com');
    expect(notifyMails()[0].text).toContain('To stop these emails, disable or delete the channel');
  });

  it('accepts a JSON body on POST /verify', async () => {
    const ctx = await setup();
    const res = await createEmailChannel(ctx, ctx.adminKey, 'json@example.com');
    const token = tokenFrom(verifyMails()[0]);
    const confirm = await ctx.app.inject({
      method: 'POST', url: '/v1/notification-channels/verify', payload: { token },
    });
    expect(confirm.statusCode).toBe(200);
    expect(channelRow(ctx.db, res.json().id).verified_at).not.toBeNull();
  });

  it('rejects malformed and unknown tokens without echoing them', async () => {
    const ctx = await setup();
    const bad = await ctx.app.inject({
      method: 'GET', url: '/v1/notification-channels/verify?token=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
    });
    expect(bad.statusCode).toBe(404);
    expect(bad.body).not.toContain('<script>');

    const unknown = await postForm(ctx, 'A'.repeat(43));
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body).toContain('not valid');
  });

  it('expired tokens are refused on GET and POST', async () => {
    const ctx = await setup();
    const res = await createEmailChannel(ctx, ctx.adminKey, 'late@example.com');
    const id = res.json().id as string;
    const token = tokenFrom(verifyMails()[0]);
    ctx.db.prepare('UPDATE notification_channels SET verify_sent_at = ? WHERE id = ?')
      .run(nowSec() - 8 * 86_400, id);

    const page = await ctx.app.inject({ method: 'GET', url: `/v1/notification-channels/verify?token=${token}` });
    expect(page.statusCode).toBe(410);
    const confirm = await postForm(ctx, token);
    expect(confirm.statusCode).toBe(410);
    expect(channelRow(ctx.db, id).verified_at).toBeNull();
  });

  it('PATCH with a new address resets confirmation and sends a new email; same address (any case) does not', async () => {
    const ctx = await setup();
    const res = await createEmailChannel(ctx, ctx.adminKey, 'first@example.com');
    const id = res.json().id as string;
    await postForm(ctx, tokenFrom(verifyMails()[0]));
    expect(channelRow(ctx.db, id).verified_at).not.toBeNull();

    const same = await ctx.app.inject({
      method: 'PATCH', url: `/v1/notification-channels/${id}`, headers: auth(ctx.adminKey),
      payload: { config: { address: 'FIRST@example.com' } },
    });
    expect(same.statusCode).toBe(200);
    expect(same.json().verified).toBe(true);
    expect(same.json().verification_queued).toBeUndefined();
    expect(verifyMails()).toHaveLength(1);

    const changed = await ctx.app.inject({
      method: 'PATCH', url: `/v1/notification-channels/${id}`, headers: auth(ctx.adminKey),
      payload: { config: { address: 'second@example.com' } },
    });
    await flushQueuedSends();
    expect(changed.statusCode).toBe(200);
    expect(changed.json().verified).toBe(false);
    expect(changed.json().verification_queued).toBe(true);
    expect(verifyMails()).toHaveLength(2);
    expect(verifyMails()[1].to).toBe('second@example.com');
  });
});

// ---------------------------------------------------------------------------

describe('no SMTP configured', () => {
  it('refuses to create an email channel', async () => {
    delete process.env.SMTP_HOST;
    const ctx = await setup();
    const res = await createEmailChannel(ctx, ctx.adminKey, 'x@example.com');
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/not configured/i);
  });

  it('refuses to change the address of an existing email channel', async () => {
    const ctx = await setup();
    const res = await createEmailChannel(ctx, ctx.adminKey, 'x@example.com');
    delete process.env.SMTP_HOST;
    const patch = await ctx.app.inject({
      method: 'PATCH', url: `/v1/notification-channels/${res.json().id}`, headers: auth(ctx.adminKey),
      payload: { config: { address: 'y@example.com' } },
    });
    expect(patch.statusCode).toBe(400);
  });

  it('verification tick is a no-op', async () => {
    const ctx = await setup();
    await createEmailChannel(ctx, ctx.adminKey, 'x@example.com');
    sendMail.mockClear();
    ctx.db.prepare('UPDATE notification_channels SET verify_sent_at = NULL').run();
    delete process.env.SMTP_HOST;
    await runEmailVerificationTick(ctx.db);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('resend-verification and limits', () => {
  it('cooldown: a resend within 10 min is 429; later a new link replaces the old one', async () => {
    const ctx = await setup();
    const res = await createEmailChannel(ctx, ctx.adminKey, 'slow@example.com');
    const id = res.json().id as string;
    const firstToken = tokenFrom(verifyMails()[0]);

    const tooSoon = await ctx.app.inject({
      method: 'POST', url: `/v1/notification-channels/${id}/resend-verification`, headers: auth(ctx.adminKey),
    });
    expect(tooSoon.statusCode).toBe(429);
    expect(verifyMails()).toHaveLength(1);

    ctx.db.prepare('UPDATE notification_channels SET verify_sent_at = ? WHERE id = ?').run(nowSec() - 11 * 60, id);
    const ok = await ctx.app.inject({
      method: 'POST', url: `/v1/notification-channels/${id}/resend-verification`, headers: auth(ctx.adminKey),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ok).toBe(true);
    expect(verifyMails()).toHaveLength(2);

    expect((await postForm(ctx, firstToken)).statusCode).toBe(404);
    expect((await postForm(ctx, tokenFrom(verifyMails()[1]))).statusCode).toBe(200);
  });

  it('per address: max 3 confirmation emails per 24 h across projects', async () => {
    const ctx = await setup();
    const keys: string[] = [ctx.adminKey];
    for (let i = 0; i < 3; i++) keys.push((await createProjectWithAdminKey(ctx.db, `P${i}`)).key);

    for (let i = 0; i < 3; i++) {
      const res = await createEmailChannel(ctx, keys[i], 'victim@example.com');
      expect(res.json().verification_queued).toBe(true);
    }
    // Normalisation: case and whitespace do not open a new bucket.
    const fourth = await createEmailChannel(ctx, keys[3], 'Victim@Example.com');
    expect(fourth.statusCode).toBe(201); // the channel exists…
    expect(fourth.json().verification_queued).toBe(false); // …but nothing was sent
    expect(fourth.json().verification_error).toMatch(/this address/);
    expect(verifyMails()).toHaveLength(3);

    // The tick does not get around the limit either.
    await runEmailVerificationTick(ctx.db);
    expect(verifyMails()).toHaveLength(3);
  });

  it('per project: max 5 confirmation emails per 24 h', async () => {
    const ctx = await setup();
    for (let i = 0; i < 5; i++) {
      const res = await createEmailChannel(ctx, ctx.adminKey, `user${i}@example.com`);
      expect(res.json().verification_queued).toBe(true);
    }
    const sixth = await createEmailChannel(ctx, ctx.adminKey, 'user5@example.com');
    expect(sixth.json().verification_queued).toBe(false);
    expect(sixth.json().verification_error).toMatch(/project/);

    ctx.db.prepare('UPDATE notification_channels SET verify_sent_at = ? WHERE id = ?')
      .run(nowSec() - 3600, sixth.json().id);
    const resend = await ctx.app.inject({
      method: 'POST', url: `/v1/notification-channels/${sixth.json().id}/resend-verification`, headers: auth(ctx.adminKey),
    });
    expect(resend.statusCode).toBe(429);
  });

  it('rejects resend for non-email (400), confirmed (409) and actions-scope keys (403)', async () => {
    const ctx = await setup();
    const slack = await ctx.app.inject({
      method: 'POST', url: '/v1/notification-channels', headers: auth(ctx.adminKey),
      payload: { name: 'S', type: 'slack', config: { url: 'https://hooks.slack.com/services/T00/B00/abcdefghijklmno' } },
    });
    const r1 = await ctx.app.inject({
      method: 'POST', url: `/v1/notification-channels/${slack.json().id}/resend-verification`, headers: auth(ctx.adminKey),
    });
    expect(r1.statusCode).toBe(400);

    const email = await createEmailChannel(ctx, ctx.adminKey, 'done@example.com');
    await postForm(ctx, tokenFrom(verifyMails()[0]));
    const r2 = await ctx.app.inject({
      method: 'POST', url: `/v1/notification-channels/${email.json().id}/resend-verification`, headers: auth(ctx.adminKey),
    });
    expect(r2.statusCode).toBe(409);

    const agent = await ctx.app.inject({
      method: 'POST', url: '/v1/keys', headers: auth(ctx.adminKey), payload: { name: 'Agent', scopes: ['actions'] },
    });
    const r3 = await ctx.app.inject({
      method: 'POST', url: `/v1/notification-channels/${email.json().id}/resend-verification`,
      headers: auth(agent.json().key as string),
    });
    expect(r3.statusCode).toBe(403);
  });

  it('a failed send gives the slot back; the owner retries, not the tick', async () => {
    const ctx = await setup();
    sendMail.mockRejectedValueOnce(Object.assign(new Error('550 rejected <fail@example.com>'), { code: 'EENVELOPE', responseCode: 550 }));
    const res = await createEmailChannel(ctx, ctx.adminKey, 'fail@example.com');
    const id = res.json().id as string;
    expect(res.statusCode).toBe(201);
    // The SMTP failure happens after the response, so the create only knows
    // the email was queued; the channel shows it unsent afterwards.
    expect(res.json().verification_queued).toBe(true);
    expect(channelRow(ctx.db, id).verify_sent_at).toBeNull();
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM email_sends').get()).toEqual({ c: 0 });

    await runEmailVerificationTick(ctx.db);
    expect(verifyMails()).toHaveLength(1); // only the failed attempt
    expect(channelRow(ctx.db, id).verify_sent_at).toBeNull();

    const resend = await ctx.app.inject({
      method: 'POST', url: `/v1/notification-channels/${id}/resend-verification`, headers: auth(ctx.adminKey),
    });
    expect(resend.statusCode).toBe(200);
    expect(verifyMails()).toHaveLength(2); // the failed attempt + the owner's retry
    expect(channelRow(ctx.db, id).verify_sent_at).not.toBeNull();
  });

  it('channels blocked by the address limit are never mailed later by the tick', async () => {
    const ctx = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push((await createEmailChannel(ctx, ctx.adminKey, 'stranger@example.com')).json().id as string);
    }
    expect(verifyMails()).toHaveLength(3);

    // A day later the per-address window is empty again…
    ctx.db.prepare('UPDATE email_sends SET sent_at = sent_at - ?').run(2 * 86_400);
    await runEmailVerificationTick(ctx.db);
    await runEmailVerificationTick(ctx.db);
    // …but the blocked channels stay unsent: nothing drips to the stranger.
    expect(verifyMails()).toHaveLength(3);
    expect(ids.slice(3).map(id => channelRow(ctx.db, id).verify_sent_at)).toEqual([null, null, null]);
  });

  it('logs a failed send without the address or the token', async () => {
    const ctx = await setup();
    const res = await createEmailChannel(ctx, ctx.adminKey, 'quiet@example.com');
    const id = res.json().id as string;
    ctx.db.prepare('UPDATE notification_channels SET verify_sent_at = NULL, verify_attempted_at = NULL WHERE id = ?').run(id);
    sendMail.mockRejectedValueOnce(Object.assign(new Error('550 <quiet@example.com> unknown'), { code: 'EENVELOPE' }));

    const logged: unknown[] = [];
    const log: Logger = { info: o => logged.push(o), warn: o => logged.push(o), error: o => logged.push(o) };
    const result = await sendChannelVerification(ctx.db, id, 'system', log);
    expect(result).toEqual({ sent: false, reason: 'send_failed' });
    const text = JSON.stringify(logged);
    expect(text).toContain('channel.verification_send_failed');
    expect(text).toContain('EENVELOPE');
    expect(text).not.toContain('quiet@');
    expect(text).not.toContain('token');
  });
});

// ---------------------------------------------------------------------------

describe('queued confirmation email', () => {
  function deferredSend() {
    let settle!: { resolve: (v: unknown) => void; reject: (e: unknown) => void };
    const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    sendMail.mockReturnValueOnce(promise);
    return settle;
  }

  it('create responds before the SMTP server does; the audit entry follows the actual send', async () => {
    const ctx = await setup();
    const smtp = deferredSend();
    const res = await createEmailChannel(ctx, ctx.adminKey, 'slow@example.com');
    expect(res.statusCode).toBe(201);
    expect(res.json().verification_queued).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const sentAudit = "SELECT COUNT(*) AS c FROM audit_log WHERE event = 'channel.verification_sent'";
    expect(ctx.db.prepare(sentAudit).get()).toEqual({ c: 0 });

    smtp.resolve({ messageId: 'late' });
    await flushQueuedSends();
    expect(ctx.db.prepare(sentAudit).get()).toEqual({ c: 1 });
    expect((await postForm(ctx, tokenFrom(verifyMails()[0]))).statusCode).toBe(200);
  });

  it('a send that fails after a PATCH reserved a newer one leaves the newer link working', async () => {
    const ctx = await setup();
    const first = deferredSend();
    const res = await createEmailChannel(ctx, ctx.adminKey, 'old@example.com');
    const id = res.json().id as string;

    const patched = await ctx.app.inject({
      method: 'PATCH', url: `/v1/notification-channels/${id}`, headers: auth(ctx.adminKey),
      payload: { config: { address: 'new@example.com' } },
    });
    await flushQueuedSends();
    expect(patched.json().verification_queued).toBe(true);
    const newToken = tokenFrom(verifyMails()[1]);

    first.reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    await flushQueuedSends();
    expect(channelRow(ctx.db, id).verify_sent_at).not.toBeNull();
    expect((await postForm(ctx, newToken)).statusCode).toBe(200);
  });

  it('the SMTP transport has bounded timeouts', async () => {
    const ctx = await setup();
    await createEmailChannel(ctx, ctx.adminKey, 'timeouts@example.com');
    const options = transportOptions.at(-1);
    expect(options?.connectionTimeout).toBeLessThanOrEqual(10_000);
    expect(options?.greetingTimeout).toBeLessThanOrEqual(10_000);
    expect(options?.socketTimeout).toBeLessThanOrEqual(30_000);
  });
});

// ---------------------------------------------------------------------------

describe('delivery skips unconfirmed email channels', () => {
  it('digest tick does not flush an unconfirmed channel', async () => {
    const ctx = await setup();
    const res = await createEmailChannel(ctx, ctx.adminKey, 'pending@example.com');
    const id = res.json().id as string;
    ctx.db.prepare(
      "UPDATE notification_channels SET digest_queue = ?, last_fired_at = ? WHERE id = ?",
    ).run(JSON.stringify([{ actionId: 'act_x', title: 'Queued', kind: 'k' }]), nowSec() - 3600, id);
    sendMail.mockClear();

    await runChannelDigestTick(ctx.db);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('IMPRI_EMAIL_DAILY_CAP', () => {
  async function confirmedChannel() {
    const ctx = await setup();
    const res = await createEmailChannel(ctx, ctx.adminKey, 'busy@example.com', { digest_window_sec: 10 });
    const id = res.json().id as string;
    await postForm(ctx, tokenFrom(verifyMails()[0]));
    return { ...ctx, id };
  }

  it('stops sending at the cap without counting it as a failure, then catches up', async () => {
    process.env.IMPRI_EMAIL_DAILY_CAP = '1';
    const ctx = await confirmedChannel();

    await createAction(ctx, ctx.adminKey, 'One');
    expect(notifyMails()).toHaveLength(1);

    // Let the digest window lapse so the next action would send immediately.
    ctx.db.prepare('UPDATE notification_channels SET last_fired_at = ? WHERE id = ?').run(nowSec() - 3600, ctx.id);
    await createAction(ctx, ctx.adminKey, 'Two');
    expect(notifyMails()).toHaveLength(1);
    let row = channelRow(ctx.db, ctx.id);
    expect(row.fail_count).toBe(0);
    expect(row.enabled).toBe(1);
    expect(JSON.parse(row.digest_queue)).toHaveLength(1); // kept for later

    // Still capped on the tick.
    await runChannelDigestTick(ctx.db);
    expect(notifyMails()).toHaveLength(1);

    // Window frees up → the tick delivers the queued action.
    process.env.IMPRI_EMAIL_DAILY_CAP = '2';
    await runChannelDigestTick(ctx.db);
    expect(notifyMails()).toHaveLength(2);
    expect(notifyMails()[1].subject).toContain('Two');
    row = channelRow(ctx.db, ctx.id);
    expect(JSON.parse(row.digest_queue)).toHaveLength(0);
  });

  it('test sends count toward the cap', async () => {
    process.env.IMPRI_EMAIL_DAILY_CAP = '1';
    const ctx = await confirmedChannel();
    const t1 = await ctx.app.inject({
      method: 'POST', url: `/v1/notification-channels/${ctx.id}/test`, headers: auth(ctx.adminKey),
    });
    expect(t1.json()).toEqual({ ok: true });
    const t2 = await ctx.app.inject({
      method: 'POST', url: `/v1/notification-channels/${ctx.id}/test`, headers: auth(ctx.adminKey),
    });
    expect(t2.json().ok).toBe(false);
    expect(t2.json().error).toMatch(/limit/i);
  });

  it('a failed notification send does not use up the cap', async () => {
    process.env.IMPRI_EMAIL_DAILY_CAP = '1';
    const ctx = await confirmedChannel();
    sendMail.mockRejectedValueOnce(new Error('connection lost'));
    await createAction(ctx, ctx.adminKey, 'Fails');
    expect(channelRow(ctx.db, ctx.id).fail_count).toBe(1);
    const sends = ctx.db.prepare("SELECT COUNT(*) AS c FROM email_sends WHERE kind = 'notify'").get();
    expect(sends).toEqual({ c: 0 });
  });
});

// ---------------------------------------------------------------------------

describe('email_sends housekeeping', () => {
  it('stores only address hashes and prunes rows older than 2 days', async () => {
    const ctx = await setup();
    await createEmailChannel(ctx, ctx.adminKey, 'Hash@Example.com');
    const rows = ctx.db.prepare('SELECT address_hash FROM email_sends').all() as { address_hash: string }[];
    expect(rows).toEqual([{ address_hash: hashEmailAddress('hash@example.com') }]);

    ctx.db.prepare('UPDATE email_sends SET sent_at = ?').run(nowSec() - 3 * 86_400);
    await runChannelDigestTick(ctx.db);
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM email_sends').get()).toEqual({ c: 0 });
  });
});

// ---------------------------------------------------------------------------

describe('migration of a pre-verification database', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'impri-verify-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('existing email channels start unconfirmed and get one confirmation email from the tick', async () => {
    const path = join(dir, 'old.db');
    // Build a current DB, then strip the verification columns to get the
    // shape a production DB had before this change.
    const fresh = createDb(path);
    const { projectId } = (await bootstrapAdminKey(fresh))!;
    fresh.close();
    const raw = new Database(path);
    raw.exec(`
      DROP INDEX idx_notification_channels_verify_token;
      DROP INDEX idx_notification_channels_verify_pending;
      ALTER TABLE notification_channels DROP COLUMN verified_at;
      ALTER TABLE notification_channels DROP COLUMN verify_token_hash;
      ALTER TABLE notification_channels DROP COLUMN verify_sent_at;
      ALTER TABLE notification_channels DROP COLUMN verify_attempted_at;
      DROP TABLE email_sends;
    `);
    raw.prepare(`
      INSERT INTO notification_channels (id, project_id, name, type, enabled, config, created_at, updated_at)
      VALUES ('nchan_old', ?, 'Old mail', 'email', 1, '{"address":"legacy@example.com"}', 1, 1)
    `).run(projectId);
    raw.close();

    const db = createDb(path);
    const row = db.prepare('SELECT verified_at, verify_sent_at FROM notification_channels WHERE id = ?')
      .get('nchan_old') as { verified_at: number | null; verify_sent_at: number | null };
    expect(row).toEqual({ verified_at: null, verify_sent_at: null });

    await runEmailVerificationTick(db);
    expect(verifyMails().map(m => m.to)).toEqual(['legacy@example.com']);
    await runEmailVerificationTick(db);
    expect(verifyMails()).toHaveLength(1);

    const audit = db.prepare("SELECT actor FROM audit_log WHERE event = 'channel.verification_sent'").all();
    expect(audit).toEqual([{ actor: 'system' }]);
    db.close();
  });
});

describe('request logging', () => {
  it('redacts the confirmation token from logged URLs', () => {
    const token = 'A'.repeat(43);
    expect(redactUrlSecrets(`/v1/notification-channels/verify?token=${token}`))
      .toBe('/v1/notification-channels/verify?token=[redacted]');
    expect(redactUrlSecrets(`/x?a=1&token=${token}&b=2`)).toBe('/x?a=1&token=[redacted]&b=2');
    expect(redactUrlSecrets('/v1/actions?status=pending')).toBe('/v1/actions?status=pending');
  });
});
