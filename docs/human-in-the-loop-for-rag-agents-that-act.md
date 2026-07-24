# Human-in-the-Loop for RAG Agents That Take Actions

A RAG agent that retrieves context and then acts on it can be wrong in a way pure generation isn't — this covers gating actions on what was actually retrieved, not just what was written.

---

## Retrieval failure is a different risk than generation failure

Most human-in-the-loop guides focus on the model's output: did it write a good email, a sane refund amount, a reasonable comment. A RAG agent adds a step before that — it pulls context from a vector store, a ticket history, or a set of crawled documents, and then drafts an action grounded in whatever it retrieved.

That grounding step can fail on its own. The retriever can pull a stale KB article that was since corrected. It can surface a document containing an indirect prompt injection — text planted specifically to be picked up by a retriever and treated as an instruction. Or it can just retrieve the wrong chunk and the agent confidently acts on it anyway. None of that shows up as a generation problem. The draft can read perfectly and still be wrong, because it was built on bad grounding.

So the approval gate for a RAG agent needs to show more than the proposed action — it needs to show *what the agent retrieved to justify it*.

---

## What the approval card should carry

A support-triage RAG agent is a good concrete case: it retrieves past tickets and KB articles, then proposes a reply or a ticket status change. The `preview.body` you send to Impri should include the retrieved snippets alongside the proposed text, not just the final answer, so the human reviewer can check the grounding in the same glance:

```python
import requests
import os

IMPRI_KEY = os.environ["IMPRI_API_KEY"]

def push_rag_action(ticket_id, retrieved_chunks, draft_reply):
    citations = "\n".join(
        f"> **Source ({c['doc_id']}, updated {c['updated_at']}):** {c['text'][:200]}"
        for c in retrieved_chunks
    )
    body = f"""**Proposed reply to ticket #{ticket_id}:**

{draft_reply}

---
**Retrieved context this reply is grounded on:**

{citations}
"""
    resp = requests.post(
        "https://api.impri.dev/v1/actions",
        headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        json={
            "kind": "ticket.reply",
            "title": f"RAG reply for ticket #{ticket_id}",
            "preview": {"format": "markdown", "body": body},
            "expires_in": 21600,
            "editable": ["preview.body"],
            "idempotent": False,
        },
    )
    return resp.json()["id"]
```

Putting citations in the same card costs nothing extra — it's one more section in the markdown body — but it turns the review from "does this reply sound right" into "does this reply match what was actually retrieved," which is the question that actually catches bad grounding.

---

## Naming the action kind by what it commits to

`kind` is a free-form string Impri doesn't validate, so use it to make the retrieval-driven nature of the action legible to whoever's reviewing the inbox:

| Scenario | Suggested `kind` |
|---|---|
| Reply drafted from ticket + KB retrieval | `ticket.reply` |
| KB article auto-updated from a retrieved source | `kb.update` |
| Answer posted to a public forum thread from doc retrieval | `forum.reply` |
| Internal Slack summary built from retrieved docs | `slack.summary` |

A reviewer scanning an inbox of twenty pending actions benefits from being able to tell at a glance which ones are retrieval-grounded and therefore worth checking sources on, versus ones that are simple direct requests.

---

## Treat retrieved content as untrusted input

If any part of the retrieval corpus comes from outside your control — scraped pages, user-submitted documents, a public wiki — treat that text as data, not instructions, in the agent's system prompt. Impri doesn't parse or interpret the action content it stores; it presents whatever you send it as a card for a human to read. That means Impri can *surface* a suspicious instruction buried in a retrieved chunk (because you included the citation in the preview), but it can't detect or flag it for you. The human reading the card is the actual defense — which is exactly why the citations need to be in the card in the first place, not just the model's output.

---

## What this doesn't solve

Impri doesn't rank, verify, or re-retrieve anything. It's not a RAG evaluation tool and it won't tell you whether a citation actually supports the claim next to it — a human still has to make that call. What it gives you is the chokepoint: the agent can propose a reply built on retrieval, but it cannot send, publish, or apply that reply without a stored `approved` decision, and the wrapper around your send/publish function should be the only path to that side effect (see [adding approval to an agent](how-to-add-human-approval-to-an-ai-agent.md) for the wrapper pattern).

For framework-specific RAG integrations, see the [LangChain](human-in-the-loop-for-langchain-agents.md) and [LlamaIndex](human-in-the-loop-llamaindex-agents.md) guides. New to Impri? Start with the [quickstart](quickstart.md).
