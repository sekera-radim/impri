# Human Approval for AI Agent GitHub Issue and Comment Automation

Add human approval for AI agent GitHub issue and comment automation: the agent drafts, you review and edit in one inbox, and only approved text gets posted.

---

## The problem with bots that talk in public

A GitHub comment is public, attributed to your account or bot, and hard to unring. Maintainers who let an agent triage issues quickly hit the same failure modes: a confidently wrong "this is fixed in v2" reply, a tone that is off for a first-time contributor, a duplicate-closing comment on an issue that was not a duplicate, or an agent that read a malicious issue body and repeated instructions from it.

Editing after the fact is visible in the timeline and notifications have already gone out. The cheaper place to catch a bad comment is before it exists on GitHub.

---

## The pattern: the agent drafts, the human posts

The agent never holds a token that can write comments. It holds an Impri key and a single function, `propose_comment`, that pushes the draft as an action and only calls the GitHub API after a human approves. The example below is Python with plain HTTP calls.

```python
import os, time, requests

IMPRI = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}
GH = {"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
      "Accept": "application/vnd.github+json"}

def propose_comment(repo: str, number: int, draft: str) -> None:
    created = requests.post(f"{IMPRI}/v1/actions", headers=HEADERS, json={
        "kind": "github.comment",
        "title": f"Reply on {repo}#{number}",
        "preview": {"format": "markdown", "body": draft},
        "target_url": f"https://github.com/{repo}/issues/{number}",
        "expires_in": 21600,          # 6h: a stale triage reply is not worth posting
        "editable": ["preview.body"],
        "idempotent": False,
        "undo": f"Delete the comment on {repo}#{number} from the GitHub UI",
    }).json()

    while True:
        action = requests.get(f"{IMPRI}/v1/actions/{created['id']}",
                              headers=HEADERS).json()
        if action["status"] != "pending":
            break
        time.sleep(15)

    if action["status"] != "approved":
        return  # rejected or expired: post nothing

    body = action["decision"]["final_preview"]["body"]  # includes human edits
    r = requests.post(f"https://api.github.com/repos/{repo}/issues/{number}/comments",
                      headers=GH, json={"body": body})
    requests.post(f"{IMPRI}/v1/actions/{created['id']}/result", headers=HEADERS,
                  json={"status": "executed" if r.ok else "execute_failed"})
```

Three details matter here:

- **Execute `final_preview`, not your draft.** If the reviewer softened a sentence, that edited text is what goes to GitHub. `decision.diff` shows what they changed.
- **`idempotent: false`** puts a warning badge on the card, because retrying a comment posts it twice.
- **A short `expires_in`.** Issue threads move. A reply approved two days later may answer a question that has already been resolved, so let it expire instead.

---

## Which GitHub actions deserve a gate

Not every call needs a human. A rough split:

| Action | Gate it? | Why |
|--------|----------|-----|
| Read issues, search, fetch diffs | No | No side effect |
| Apply an internal-only label | Usually no | Easy to revert, low visibility |
| Comment on an issue or PR | Yes | Public, notifies people |
| Close an issue or PR | Yes | Contributors see it as a decision about them |
| Open an issue in another repo | Yes | Lands in someone else's queue |
| Edit or delete existing comments | Yes | Rewrites public history |

Use a distinct `kind` per row (for example `github.comment`, `github.close`) so you can filter the [inbox](inbox.md) and later write [rules](rules.md) around them.

---

## Being honest about the boundary

Impri is the approval gate only. It stores the proposed comment, notifies the reviewer, and holds the decision. It does not write the reply, judge whether it is correct, or post anything to GitHub.

It is also only a real gate if the approved path is the agent's only path. If the agent process also holds a `GITHUB_TOKEN` with `issues: write` in a place its tools can reach, it can comment directly and skip you. Put the token inside the executor that runs after approval, or give the agent a token with read-only scope and keep the write token elsewhere. See [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the reasoning.

Treat issue bodies as untrusted input. A draft built from a malicious issue may contain injected text; the reviewer sees the exact final comment, which is the point of having a human read it.

---

## Getting notified where you already work

You do not need to keep the inbox open. Reviews can reach you through [Slack](slack-approval.md) or your phone via [notifications](notifications.md), and approving is a single tap. For an audit trail of who approved which public comment and when, see the [audit log](audit-log.md).

---

## Next step

Get a key from the [quickstart](quickstart.md), point your triage agent's comment function at the pattern above, and start with `github.comment` only. Once reviewers trust the drafts, widen the gate to closes and cross-repo issues rather than the other way around.
