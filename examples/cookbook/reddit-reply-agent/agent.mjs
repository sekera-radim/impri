#!/usr/bin/env node
// reddit-reply-agent.mjs — Impri cookbook recipe #2
// No dependencies. Node 18+.
//
// Pattern: agent finds a Reddit thread where it has something to contribute,
// drafts a reply, gates the post on human approval, then submits via the
// Reddit API (stub here) with the final (possibly edited) text.
//
// Run:
//   IMPRI_API_KEY=im_xxx node agent.mjs
//   IMPRI_API_KEY=im_xxx REDDIT_ACCESS_TOKEN=xxx node agent.mjs
//
// Required scope: actions

const API_KEY = process.env.IMPRI_API_KEY;
const BASE = (process.env.IMPRI_BASE_URL ?? 'http://localhost:8484').replace(/\/+$/, '');

if (!API_KEY) {
  console.error('Set IMPRI_API_KEY (it starts with im_).');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Minimal API helper
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
// The thread the agent wants to reply to.
// In a real system this would come from a watcher, an RSS feed, or a search.
// ---------------------------------------------------------------------------
const thread = {
  id: 't3_abc123',
  url: 'https://www.reddit.com/r/selfhosted/comments/abc123/looking_for_a_simple_approval_layer/',
  title: 'Looking for a simple approval layer for my AI agent',
  subreddit: 'r/selfhosted',
};

// Draft reply — in production this would come from an LLM.
const draftReply =
  "You might want to look at [Impri](https://impri.dev) — it's a lightweight, " +
  "self-hostable approval inbox for AI agents. You `POST` the proposed action " +
  "(draft comment, deploy command, payment) and a human taps Approve/Reject in " +
  "a mobile-friendly inbox. The agent only executes after approval. " +
  "MIT-licensed, Docker Compose quickstart, no extra services needed.";

// ---------------------------------------------------------------------------
// Stub: replace with actual Reddit API call (OAuth + POST /api/comment).
// ---------------------------------------------------------------------------
async function postRedditComment(threadId, commentText) {
  console.log(`   [stub] POST /api/comment on ${threadId}`);
  console.log('   [stub] text (first 100 chars):', commentText.slice(0, 100));
  // In production:
  //   const res = await fetch('https://oauth.reddit.com/api/comment', {
  //     method: 'POST',
  //     headers: {
  //       Authorization: `Bearer ${process.env.REDDIT_ACCESS_TOKEN}`,
  //       'Content-Type': 'application/x-www-form-urlencoded',
  //     },
  //     body: new URLSearchParams({ api_type: 'json', thing_id: threadId, text: commentText }),
  //   });
  //   const data = await res.json();
  //   return data.json.data.things[0].data.name; // e.g. "t1_xyz"
  return 't1_stub_comment_id';
}

// ---------------------------------------------------------------------------
// Main agent loop
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nImpri reddit-reply-agent → ${BASE}`);
  console.log(`  Thread: ${thread.title}`);
  console.log(`  URL: ${thread.url}\n`);

  // 1. Gate the reply on human approval.
  //    target_url shows the reviewer the thread context directly.
  //    editable: ["preview.body"] — reviewer can polish the reply text.
  const action = await api('/actions', 'POST', {
    kind: 'reddit.comment',
    title: `Reply on ${thread.subreddit}: "${thread.title.slice(0, 60)}"`,
    preview: {
      format: 'markdown',
      body: draftReply,
    },
    target_url: thread.url,
    payload: { thread_id: thread.id, subreddit: thread.subreddit },
    idempotency_key: `reddit-reply-${thread.id}`,
    expires_in: 86400, // 24 h — Reddit threads go stale
    editable: ['preview.body'],
  });

  console.log(`  Created action ${action.id} (status: ${action.status})`);
  console.log(`  Open your inbox: ${action.inbox_url ?? BASE.replace(':8484', ':8080')}\n`);

  // 2. Poll for the human decision.
  let current = action;
  while (current.status === 'pending') {
    await sleep(3000);
    current = await api(`/actions/${action.id}`);
    process.stdout.write(`  Waiting for decision... (${current.status})\r`);
  }
  console.log(`\n  Decision: ${current.status.toUpperCase()}`);

  if (current.status !== 'approved') {
    console.log('  Not approved — reply NOT posted to Reddit.');
    return;
  }

  // 3. Post the comment.
  //    Always use final_preview — reviewer may have edited the text.
  const finalText = current.decision?.final_preview?.body ?? draftReply;
  const wasEdited = Boolean(current.decision?.diff);
  if (wasEdited) {
    console.log('  Reviewer edited the reply — posting their version.');
  }

  try {
    const commentId = await postRedditComment(thread.id, finalText);
    await api(`/actions/${action.id}/result`, 'POST', {
      status: 'executed',
      detail: `Comment posted: ${commentId}`,
    });
    console.log(`  OK — comment posted (${commentId}) and reported to Impri.`);
  } catch (err) {
    await api(`/actions/${action.id}/result`, 'POST', {
      status: 'execute_failed',
      detail: String(err),
    });
    console.error('  Approved but Reddit post failed → execute_failed.');
  }
}

main().catch((e) => {
  console.error('\nAgent error:', e.message);
  process.exit(1);
});
