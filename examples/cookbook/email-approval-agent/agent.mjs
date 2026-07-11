#!/usr/bin/env node
// email-approval-agent.mjs — Impri cookbook recipe #1
// No dependencies. Node 18+.
//
// Pattern: agent drafts an outbound email, gates the send on human approval,
// uses the FINAL preview (so the reviewer's edits are honored), reports result.
//
// Run:
//   IMPRI_API_KEY=im_xxx node agent.mjs
//   IMPRI_API_KEY=im_xxx IMPRI_BASE_URL=https://api.impri.dev node agent.mjs
//
// Required scope: actions

const API_KEY = process.env.IMPRI_API_KEY;
const BASE = (process.env.IMPRI_BASE_URL ?? 'http://localhost:8484').replace(/\/+$/, '');

if (!API_KEY) {
  console.error('Set IMPRI_API_KEY (it starts with im_).');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Minimal API helper (no deps)
// ---------------------------------------------------------------------------
async function api(path, method = 'GET', body) {
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} /v1${path} → ${res.status}: ${json.message ?? json.error ?? JSON.stringify(json)}`);
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Simulate an agent that composes an email.
// In a real system this draft would come from an LLM or a template engine.
// ---------------------------------------------------------------------------
const recipient = 'alice@example.com';
const subject = 'Follow-up: Q3 proposal review';
const draftBody =
  '**To:** alice@example.com\n' +
  `**Subject:** ${subject}\n\n` +
  'Hi Alice,\n\n' +
  'I wanted to follow up on the Q3 proposal we discussed last week. ' +
  'Could you share your thoughts by Thursday so we can align before the board meeting?\n\n' +
  'Looking forward to your reply.\n\n' +
  'Best,\nThe Agent';

// ---------------------------------------------------------------------------
// Stub: replace with your real email sender (nodemailer, Resend, SES, …)
// ---------------------------------------------------------------------------
async function sendEmail(to, subjectLine, bodyMarkdown) {
  console.log(`   [stub] sendEmail(to=${to}, subject="${subjectLine}")`);
  console.log('   [stub] body (first 80 chars):', bodyMarkdown.slice(0, 80));
  // In production: await resend.emails.send({ from: '...', to, subject: subjectLine, text: bodyMarkdown });
  return 'msg_stub_12345';
}

// ---------------------------------------------------------------------------
// Main agent loop
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nImpri email-approval-agent → ${BASE}`);
  console.log(`  Draft: "${subject}" to ${recipient}\n`);

  // 1. Submit the draft email for human approval.
  //    editable: ["preview.body"] lets the reviewer edit the draft before approving.
  //    idempotency_key prevents duplicate submissions on agent restart.
  const action = await api('/actions', 'POST', {
    kind: 'email.send',
    title: `Send email to ${recipient}: "${subject}"`,
    preview: {
      format: 'markdown',
      body: draftBody,
    },
    target_url: `mailto:${recipient}`,
    payload: { to: recipient, subject },
    idempotency_key: `email-q3-proposal-${recipient}`,
    expires_in: 3600, // 1 hour — after this the action expires automatically
    editable: ['preview.body'], // reviewer may edit the draft text
  });

  console.log(`  Created action ${action.id} (status: ${action.status})`);
  console.log(`  Open your inbox and Approve/Reject: ${action.inbox_url ?? BASE.replace(':8484', ':8080')}\n`);

  // 2. Poll until the human decides (or the action expires).
  let current = action;
  while (current.status === 'pending') {
    await sleep(3000);
    current = await api(`/actions/${action.id}`);
    process.stdout.write(`  Waiting for human decision... (${current.status})\r`);
  }
  console.log(`\n  Decision: ${current.status.toUpperCase()}`);

  // 3. Act only on approval.
  if (current.status !== 'approved') {
    console.log('  Not approved — agent did nothing. The email was NOT sent.');
    return;
  }

  // Always use final_preview, not the original draft.
  // The reviewer may have edited the body; decision.final_preview carries that.
  const finalBody = current.decision?.final_preview?.body ?? draftBody;
  const wasEdited = Boolean(current.decision?.diff);
  if (wasEdited) {
    console.log('  Reviewer edited the draft — sending their version.');
  }

  try {
    const msgId = await sendEmail(recipient, subject, finalBody);
    await api(`/actions/${action.id}/result`, 'POST', {
      status: 'executed',
      detail: `Email sent; message ID: ${msgId}`,
    });
    console.log('  OK — email sent and reported back to Impri.');
  } catch (err) {
    await api(`/actions/${action.id}/result`, 'POST', {
      status: 'execute_failed',
      detail: String(err),
    });
    console.error('  Approved but send failed → reported as execute_failed.');
  }
}

main().catch((e) => {
  console.error('\nAgent error:', e.message);
  process.exit(1);
});
