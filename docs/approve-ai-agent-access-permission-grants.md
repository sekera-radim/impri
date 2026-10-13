# Approve AI Agent IAM and Access Permission Grants

Require human approval before an AI agent grants IAM roles, group membership or file access. The agent proposes the grant and applies it only once approved.

---

## Why permission grants deserve their own gate

Most agent actions are bad in a visible way: a wrong email, a broken deploy. A permission grant is bad in a quiet way. An over-broad role binding does nothing the day it is created, and then sits there as standing access until someone audits it, or until someone else uses it.

Typical grants an agent ends up asked to make:

- adding a user to a cloud IAM role or a GitHub/GitLab team
- sharing a Drive folder or a database with a new account
- raising a scope on an API key or service account
- issuing a time-boxed "break-glass" credential during an incident

An agent handling an access-request ticket will happily do all of these if the ticket text sounds reasonable. The ticket text is exactly what a prompt injection or a social-engineering message controls. A human with context ("is Dana really on the payments team?") is the cheap, effective check.

---

## What the reviewer needs to see

Approval is only as good as the card. For a grant, put the dangerous details into the preview, not a vague title:

| Field | Why it matters |
|-------|----------------|
| Principal | Who receives access, spelled out in full |
| Role / scope | The exact role, not "admin-ish" |
| Resource | Project, bucket, repo or folder the grant applies to |
| Duration | Permanent or expiring, and when |
| Requested by | The ticket or message that triggered it |

Mark the action `idempotent: false` and describe the revoke path in `undo`, so the reviewer sees the way back before approving.

---

## Example: gate an IAM role binding (Python)

```python
import os, time, requests

API = "https://api.impri.dev"
H = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def grant_role_with_approval(principal, role, resource, ticket):
    preview = (
        f"**Principal:** {principal}\n"
        f"**Role:** {role}\n"
        f"**Resource:** {resource}\n"
        f"**Duration:** 7 days\n"
        f"**Requested in:** {ticket}"
    )
    action = requests.post(f"{API}/v1/actions", headers=H, json={
        "kind": "iam.grant",
        "title": f"Grant {role} on {resource} to {principal}",
        "preview": {"format": "markdown", "body": preview},
        "expires_in": 3600,  # a stale access request is not worth granting
        "idempotent": False,
        "undo": f"Remove {role} binding for {principal} on {resource}",
    }).json()

    while True:
        r = requests.get(f"{API}/v1/actions/{action['id']}", headers=H).json()
        if r["status"] != "pending":
            break
        time.sleep(10)

    if r["status"] != "approved":
        return r["status"]  # rejected or expired: no grant is made

    apply_iam_binding(principal, role, resource)  # your function, your credentials
    requests.post(f"{API}/v1/actions/{action['id']}/result",
                  headers=H, json={"status": "executed"})
    return "executed"
```

Nothing in Impri touches your identity provider. `apply_iam_binding` is your code, and it runs only on the `approved` branch.

---

## Keep the gate real

Impri is the approval gate, and only that. It stores the proposed grant, notifies a human and holds the decision. It does not understand IAM, does not check whether the role is excessive, and never applies anything.

Two things decide whether this is a real control:

1. **The wrapper must be the only path.** If the agent also holds an admin credential and can call the cloud API directly, it can route around the gate. Give the agent a tool that proposes grants, and keep the credential that applies them inside the approved branch, ideally in a separate process or service account.
2. **Humans can be rushed.** Put the exact role and resource on the card and keep expiry short, so approval is a deliberate read and not a reflex tap.

Impri is not a policy engine or an access-review product. If you need automatic denial of certain roles, enforce that in your own code or IAM policy and use Impri for the cases that need a person.

---

## Audit trail for access changes

Every decision is recorded: what was proposed, who approved or rejected it, and when. That gives you a clean answer to "who authorised this account to touch production?" See the [audit log](audit-log.md) for what is stored and how to export it.

---

## Next step

Create a key in the [quickstart](quickstart.md), then wrap your grant function as above. If your agent runs in an MCP client, the same flow is available through [the MCP server](mcp.md) with `impri_push_action`, `impri_await_decision` and `impri_report_result`.
