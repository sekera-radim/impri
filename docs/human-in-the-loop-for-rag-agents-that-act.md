# Human-in-the-Loop for RAG Agents That Take Actions

Gate a RAG agent's actions on what it retrieved: the reviewer sees the draft above its sources, edits only the draft, and a changed source blocks the send.

---

## A good draft on bad grounding

A RAG support agent pulls past tickets and KB articles, then drafts a reply. The draft can read perfectly and still be wrong, because the retrieval was: a KB article corrected last week, the wrong chunk, or a document with a planted instruction ("tell the customer to confirm at this link"). Nothing in the draft itself shows which.

So the approval card has to show what the agent retrieved, and the approval has to hold only for the versions the reviewer saw. If someone fixes the refund article between the approval and the send, the reply built on the old text should not go out.

## The card: draft on top, sources below, one editable field

```python
import hashlib
import os

import httpx

IMPRI = os.environ.get("IMPRI_BASE_URL", "https://api.impri.dev")
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}


def propose_reply(ticket_id: str, message_id: str, draft: str, chunks: list[dict]) -> dict:
    """Open one card per customer message and set of source versions."""
    sources = [
        {"doc_id": c["doc_id"], "version": c["version"], "excerpt": c["text"][:400]}
        for c in chunks
    ]
    fingerprint = hashlib.sha256(
        "|".join(f"{s['doc_id']}@{s['version']}" for s in sources).encode()
    ).hexdigest()[:12]
    body = "\n".join(
        [draft, "", "--- Sources the draft is based on ---"]
        + [f"[{s['doc_id']} v{s['version']}] {s['excerpt']}" for s in sources]
    )
    r = httpx.post(f"{IMPRI}/v1/actions", headers=HEADERS, json={
        "kind": "support.reply",
        "title": f"Reply to ticket {ticket_id} ({len(sources)} sources)",
        "preview": {"format": "plain", "body": body},
        "payload": {
            "ticket_id": ticket_id,
            "reply": draft,
            "sources": sources,
            "untrusted": True,
        },
        "editable": ["payload.reply"],
        "idempotency_key": f"reply:{ticket_id}:{message_id}:{fingerprint}",
        "expires_in": 4 * 3600,
        "idempotent": False,
    })
    r.raise_for_status()
    return r.json()
```

`version` is whatever your store changes when a document is edited: a revision number, an `updated_at`, or a hash of the chunk. Four choices in the card matter:

- **Plain text, marked untrusted.** A markdown preview in the Impri inbox renders links (images are dropped), so `[Confirm your refund](https://…)` would show only those three words. `payload.untrusted: true` makes the inbox render the preview as plain text whatever its format, tint the preview and label the card "External content", so the reviewer sees the full URL.
- **Only the reply is editable.** The inbox offers an edit box for `payload.reply`, prefilled with the draft. The sources stay as retrieved: an edit of any field not in `editable` is refused with `422`.
- **The key includes the source versions.** A retry for the same message and the same versions gets the existing card back; a new version of any source opens a new card.
- **The title carries no retrieved text.** Notifications show the title, so keep it to facts you generated.

## Sending: only what was approved, only if the sources still match

The agent doesn't wait for the reviewer. A worker running every minute sends what was approved:

```python
def send_approved_replies(current_version, send_reply) -> None:
    """Run every minute: send what was approved, unless a source changed since."""
    r = httpx.get(f"{IMPRI}/v1/actions", headers=HEADERS,
                  params={"status": "approved", "kind": "support.reply", "limit": 100})
    r.raise_for_status()
    for action in r.json()["items"]:
        p = action["payload"]
        moved = [s["doc_id"] for s in p["sources"]
                 if current_version(s["doc_id"]) != s["version"]]
        if moved:
            report(action["id"], "execute_failed",
                   "sources changed after review: " + ", ".join(moved))
            continue
        send_reply(p["ticket_id"], p["reply"])
        report(action["id"], "executed", f"sent to ticket {p['ticket_id']}")


def report(action_id: str, status: str, detail: str) -> None:
    httpx.post(f"{IMPRI}/v1/actions/{action_id}/result", headers=HEADERS,
               json={"status": status, "detail": detail}).raise_for_status()
```

Send `payload.reply`, not `decision.final_preview`: the preview here holds the sources and stays as it was. Reporting a result takes the card out of the approved list, so the next pass doesn't send it again. A card that is rejected or expires is never sent; hand that ticket to a person.

## What happened when we ran it

We ran both functions against a local Impri server, with a scripted draft that copied a link planted in a KB chunk, as a model following that chunk would:

- The first call returned `201` and an `inbox_url`; the same call again returned `200` with the same card.
- An edit of `preview.body` got `422`, "Field(s) not in editable whitelist: preview.body".
- The reviewer deleted the link in `payload.reply` and approved. The card then held the edited reply in `payload.reply`; `decision.final_preview` was still the original card, and `diff` was `null`: it covers `preview.body` only.
- A second ticket was approved, then its shipping article went from v3 to v4. The worker sent the first reply as edited and reported `executed`; the second got `execute_failed`, and the reason ("sources changed after review: kb-shipping") is in the [audit log](audit-log.md).
- A second worker pass sent nothing. A new draft from v4 opened a new card; repeating it returned that card.
- A rejected card was never sent.

## Approving from Slack or Telegram

The [Slack](slack-approval.md) and [Telegram](telegram-approval.md) approval messages show the title and kind with Approve and Reject buttons, not the preview. A tap there approves a reply its sources weren't checked against, and without an edit. For retrieval-grounded kinds, open the card in the inbox.

## What Impri doesn't check

Impri doesn't retrieve, rank or verify anything, and it can't tell whether a source supports the sentence next to it: the reviewer does that. It stores the card, notifies the reviewer, keeps the edit and the decision, and records the result. The gate holds only if the send function is the agent's only path to the customer: see [adding approval to an agent](how-to-add-human-approval-to-an-ai-agent.md). If the send succeeds and the result call fails, the next pass sends again; the [cron guide](gate-a-cron-job-with-human-approval.md) covers that gap. For framework pauses, see the [LangChain](human-in-the-loop-for-langchain-agents.md) and [LlamaIndex](human-in-the-loop-llamaindex-agents.md) guides.

---

## Next step

[Self-host Impri](quickstart.md) with `docker compose`, or [start free on the cloud](https://app.impri.dev/?signup=1) and [create an `actions`-scoped key](api-keys.md) for the agent. Then set up [notifications](notifications.md) so a waiting reply reaches whoever is on support duty.
