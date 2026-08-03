# Human Approval for AI Content Pipelines

An AI content pipeline that drafts, schedules, and publishes without a human check is one bad prompt away from a public mistake — here's how to gate the publish step, not the drafting.

---

## The failure mode this solves

Most content pipelines are already multi-stage: an agent researches a topic, drafts a blog post, generates social snippets from it, and pushes everything live on a schedule. The drafting stages are low-risk — nobody sees a bad draft sitting in a database. The risk concentrates entirely at the **publish** step, because that's the one with an audience.

The mistake teams make is putting the review in the wrong place: a Slack message that says "reply 👍 to approve" with no real enforcement behind it, or a cron job that publishes automatically after a fixed delay "in case nobody objects." Neither actually blocks execution. What blocks execution is a status field the publish code checks before it runs — which is what Impri's `/v1/actions` gate gives you.

## Wiring it into a content pipeline (Python)

The publish function is the only place that touches the CMS API, so it's the only place that needs the gate. Everything upstream — research, drafting, snippet generation — runs unguarded.

```python
import time
import httpx

IMPRI_BASE = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {IMPRI_API_KEY}"}

def request_publish_approval(post):
    resp = httpx.post(f"{IMPRI_BASE}/v1/actions", headers=HEADERS, json={
        "kind": "blog.publish",
        "title": f"Publish: {post['title']}",
        "preview": {"format": "markdown", "body": post["body"]},
        "target_url": post["cms_draft_url"],
        "expires_in": 21600,  # 6 hours — a stale draft isn't worth publishing
        "editable": ["preview.body"],
        "idempotent": False,
    })
    return resp.json()["id"]

def wait_and_publish(action_id, post):
    while True:
        r = httpx.get(f"{IMPRI_BASE}/v1/actions/{action_id}", headers=HEADERS).json()
        if r["status"] != "pending":
            break
        time.sleep(15)

    if r["status"] != "approved":
        return  # rejected or expired — pipeline stops here, no publish call is made

    final_body = r["decision"]["final_preview"]["body"]  # carries any human edits
    cms_publish(post["id"], final_body)

    httpx.post(f"{IMPRI_BASE}/v1/actions/{action_id}/result", headers=HEADERS,
               json={"status": "executed"})
```

The `editable: ["preview.body"]` field matters here specifically because content review is often an editing pass, not a binary yes/no — a reviewer fixing a headline shouldn't have to reject and regenerate the whole draft.

## Where the gate actually needs to sit

The wrapper only works as a real gate if `cms_publish()` is unreachable except through the code path above. If the agent also holds a raw CMS API key it can call directly for "urgent" posts, the gate is decorative. Structure it so the publish credential lives only inside `wait_and_publish`, not in the agent's general toolset — see [the SDK integrations guide](integrations.md) for wrapping patterns.

## Multi-channel drafts: one action per channel, or one for all?

A single blog post often fans out into a tweet thread, a LinkedIn post, and a newsletter blurb. Two approaches work:

| Approach | When to use |
|---|---|
| One action per channel, reviewed independently | Channels have different reviewers, or you want to approve the tweet without waiting on the newsletter |
| One action bundling all variants in `preview.body`, single approve/reject | Same reviewer, same editorial voice — one glance covers everything |

For teams starting out, bundle first — it's fewer round trips through the inbox. Split by channel once a channel gets its own owner.

## Reviewing from a phone between meetings

Content reviewers are rarely at a desk when a draft is ready. Route the notification to [Slack](slack-approval.md) or [Telegram](telegram-approval.md) so approve/reject is a tap, not a context switch back to a dashboard. The `target_url` field above should point at the actual CMS draft, so a reviewer who wants more context than the markdown preview can jump straight there.

## What this doesn't cover

Impri doesn't review content quality — it surfaces the draft to whichever human you've routed it to and trusts their judgment. It also isn't a scheduling engine; if your pipeline needs "publish at 9am on the day with the most engagement," that logic stays in your pipeline and only the final publish call goes through the gate. And expiry is real: a draft that sits unreviewed past `expires_in` moves to `expired` and won't publish, by design — stale drafts about a news cycle that's already passed shouldn't go out just because someone finally checked the inbox.

Next: [quickstart](quickstart.md) to get an API key, or [the Python SDK reference](sdk-python.md) if you'd rather not hand-roll the `httpx` calls above.
