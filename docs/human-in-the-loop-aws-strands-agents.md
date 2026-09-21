# Human-in-the-Loop for AWS Strands Agents

AWS Strands Agents call a `@tool` the moment the model decides to — this shows how to gate one with Impri so it pauses for a human before touching real AWS resources.

---

## Strands agents call tools directly

Strands' model is deliberately thin: you write plain Python functions, decorate them with `@tool`, hand them to an `Agent`, and the model decides when to call them. That simplicity is also the risk. A tool that deletes S3 objects, terminates an EC2 instance, or rotates an IAM credential runs the instant the model's reasoning loop reaches it — there's no framework-level pause unless you build one into the tool itself.

Strands does ship interrupt primitives for pausing mid-run, and AWS's own docs and community examples cover using them for approval flows. That works well if you're already invested in Strands' resume/checkpoint machinery. The approach below is simpler and framework-agnostic: the tool function itself blocks on an external decision, so the gate survives even if you later swap Strands for something else.

---

## Wrapping a Strands tool with Impri

The pattern: the tool proposes the action to Impri, waits for a human decision, and only calls the AWS SDK once that decision is `approved`.

```python
import os, time, boto3, requests
from strands import Agent, tool

IMPRI = "https://api.impri.dev"
HEADERS = {
    "Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}",
    "Content-Type": "application/json",
}
s3 = boto3.client("s3")

@tool
def apply_lifecycle_rule(bucket: str, prefix: str, expire_after_days: int) -> str:
    """Apply an S3 lifecycle rule that expires objects under a prefix after N days."""
    rule_summary = f"Bucket **{bucket}**, prefix `{prefix}`, expire after **{expire_after_days} days**"

    action = requests.post(f"{IMPRI}/v1/actions", headers=HEADERS, json={
        "kind": "aws.s3.lifecycle_rule",
        "title": f"Apply lifecycle rule: {bucket}/{prefix}",
        "preview": {"format": "markdown", "body": rule_summary},
        "undo": f"Remove the lifecycle rule for prefix {prefix} via PutBucketLifecycleConfiguration",
        "idempotent": False,
        "expires_in": 3600,
    }).json()

    while True:
        time.sleep(10)
        state = requests.get(f"{IMPRI}/v1/actions/{action['id']}", headers=HEADERS).json()
        if state["status"] != "pending":
            break

    if state["status"] != "approved":
        return f"Not applied — human {state['status']} the rule."

    s3.put_bucket_lifecycle_configuration(
        Bucket=bucket,
        LifecycleConfiguration={"Rules": [{
            "ID": f"expire-{prefix}",
            "Filter": {"Prefix": prefix},
            "Status": "Enabled",
            "Expiration": {"Days": expire_after_days},
        }]},
    )
    requests.post(f"{IMPRI}/v1/actions/{action['id']}/result",
                   headers=HEADERS, json={"status": "executed"})
    return "Lifecycle rule applied after human approval."

agent = Agent(tools=[apply_lifecycle_rule])
```

---

## Why the wrapper, not a prompt instruction

Telling the agent's system prompt "confirm before touching S3" is not a gate — it's a suggestion the model can reason past, especially once the conversation gets long or a tool result nudges it toward finishing the task. `apply_lifecycle_rule` above has no code path to `put_bucket_lifecycle_configuration` that skips the `approved` check. The gate holds regardless of what the model "decides" to do, because the decision was never the model's to make.

This only works if `apply_lifecycle_rule` is the agent's *only* route to that AWS call. If the agent (or another tool in the same `Agent`) also has raw `boto3` access, it can route around the gate entirely.

---

## Unattended agents: don't hold the thread open

The `time.sleep(10)` loop above is fine for a Strands agent you're actively watching run. For a Strands agent triggered by EventBridge or running as a long-lived Lambda-backed process, polling ties up billed compute time for however long the approval takes. Prefer the [MCP server](mcp.md) if the agent runs inside an MCP client, or have a separate Lambda resume the workflow once Impri's decision lands via a webhook instead of polling.

---

## What Impri does and doesn't do here

Impri stores the proposed lifecycle change, notifies you, and holds the decision — it has no idea what S3 is, doesn't validate the rule, and doesn't call AWS on your behalf. `apply_lifecycle_rule` still owns the AWS call; Impri only owns the yes/no. For the general propose → approve → execute contract this builds on, see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md).

---

## Next step

Start with the [quickstart](quickstart.md) to get an `actions`-scope API key.
