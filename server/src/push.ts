import webpush from 'web-push';
import type { Db } from './db.js';

// Web push (VAPID). Opt-in via env like billing: without VAPID keys the push
// channel is simply off (email/ntfy still work). Generate keys once with
// `npx web-push generate-vapid-keys` and set them in the environment.

export function pushEnabled(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function vapidPublicKey(): string {
  return process.env.VAPID_PUBLIC_KEY ?? '';
}

let configured = false;
function ensureConfigured(): boolean {
  if (!pushEnabled()) return false;
  if (!configured) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT ?? 'mailto:admin@impri.dev',
      process.env.VAPID_PUBLIC_KEY as string,
      process.env.VAPID_PRIVATE_KEY as string,
    );
    configured = true;
  }
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

/**
 * Send a web-push notification to every browser subscription registered for the
 * project. Dead subscriptions (404/410) are pruned. Never throws.
 */
export async function notifyPush(db: Db, projectId: string, payload: PushPayload): Promise<void> {
  if (!ensureConfigured()) return;

  const subs = db.prepare(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE project_id = ?',
  ).all(projectId) as Array<{ id: string; endpoint: string; p256dh: string; auth: string }>;
  if (subs.length === 0) return;

  const body = JSON.stringify({ title: payload.title, body: payload.body, url: payload.url });

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
      );
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404/410 = subscription gone → prune it.
      if (status === 404 || status === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      } else {
        console.error('[push] send failed:', err instanceof Error ? err.message : err);
      }
    }
  }));
}
