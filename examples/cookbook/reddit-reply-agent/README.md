# Recipe 2 — Reddit Reply Agent

An agent drafts a Reddit comment, gates the post on human approval, and
submits only the final (possibly edited) text to the Reddit API.

## Why this matters

Posting as your brand or personal account without review is risky — wrong tone,
factual errors, or policy violations can damage your reputation. Impri lets
you automate the *finding* and *drafting* while keeping a human on the
*posting* trigger.

## How it works

```
agent finds a thread + drafts a reply
    → POST /v1/actions  (kind: reddit.comment, target_url = thread URL)
    → human sees draft + link to the thread, edits/approves/rejects
    → agent polls GET /v1/actions/:id
    → if approved: POST to Reddit API using decision.final_preview.body
    → POST /v1/actions/:id/result
```

`target_url` is the Reddit thread URL — the reviewer clicks it to read the
full context before approving, making review fast and informed.

## Requirements

- Node 18+ (no npm install)
- Impri API key with `actions` scope
- Running Impri instance

## Quick start

```bash
IMPRI_API_KEY=im_your_key node agent.mjs
```

For real Reddit posting, add your OAuth token:

```bash
IMPRI_API_KEY=im_your_key REDDIT_ACCESS_TOKEN=your_token node agent.mjs
```

## Connecting to a watcher

In production you would pair this with an Impri RSS or reddit_search watcher
(see recipe #5) so the agent is triggered automatically when new matching
threads appear:

1. Watcher fires → item lands in inbox as a triage action
2. Human triages: "yes, draft a reply to this one"
3. Agent picks up the approved triage, drafts the reply
4. Impri gates the actual post with a second approval

That two-step loop (triage → draft → approve) is the full pattern.

## Reddit OAuth setup (quick reference)

```bash
# 1. Create a "script" app at https://www.reddit.com/prefs/apps
# 2. Exchange credentials for a token:
curl -X POST https://www.reddit.com/api/v1/access_token \
  -u "CLIENT_ID:CLIENT_SECRET" \
  -d "grant_type=password&username=USER&password=PASS"
# 3. Use the returned access_token as REDDIT_ACCESS_TOKEN
```
