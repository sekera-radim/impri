import nodemailer from 'nodemailer';

export interface NotifyPayload {
  actionId: string;
  title: string;
  kind: string;
  inboxUrl: string;
  verdict?: string;
}

// ntfy adapter: POST to topic URL
export async function notifyNtfy(payload: NotifyPayload): Promise<void> {
  const ntfyUrl = process.env.NTFY_URL;
  const ntfyTopic = process.env.NTFY_TOPIC;
  if (!ntfyUrl || !ntfyTopic) return;

  const url = `${ntfyUrl.replace(/\/$/, '')}/${ntfyTopic}`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Title': payload.title,
        'Priority': 'default',
        'Tags': `signoff,${payload.kind}`,
        'Click': payload.inboxUrl,
        'Content-Type': 'text/plain',
      },
      body: payload.verdict
        ? `Decision needed: ${payload.title}`
        : `New action pending: ${payload.title}`,
    });
  } catch (err) {
    console.error('[notify] ntfy delivery failed', err);
  }
}

// Email adapter: nodemailer SMTP
export async function notifyEmail(payload: NotifyPayload): Promise<void> {
  const smtpHost = process.env.SMTP_HOST;
  if (!smtpHost) {
    // No SMTP configured — just log
    console.log(`[notify] email (no SMTP): "${payload.title}" → ${payload.inboxUrl}`);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
      : undefined,
  });

  const to = process.env.NOTIFY_EMAIL;
  if (!to) return;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM ?? 'signoff@localhost',
      to,
      subject: `[Signoff] ${payload.title}`,
      text: `A new action requires your decision.\n\nTitle: ${payload.title}\nKind: ${payload.kind}\n\nReview: ${payload.inboxUrl}`,
    });
  } catch (err) {
    console.error('[notify] email delivery failed', err);
  }
}

export async function notifyAll(payload: NotifyPayload): Promise<void> {
  await Promise.allSettled([notifyNtfy(payload), notifyEmail(payload)]);
}
