# Human Approval for Google Agent Development Kit (ADK) Agents

Give a Google ADK agent cloud cleanup powers and it will eventually target the wrong bucket — add human approval before deletion using ADK's native MCP support.

---

## The scenario

A cost-control agent built with Google ADK scans a GCP project, finds BigQuery datasets and Cloud Storage buckets with no read activity in 90 days, and proposes deleting them. Finding stale resources is exactly the kind of thing an agent is good at. Deleting them without a second opinion is exactly the kind of thing that turns into an incident report — a dataset that looks unused because the pipeline reading it runs quarterly, not daily.

ADK agents call tools through the standard `google.adk.tools` interface, and since ADK speaks MCP natively, the cleanest way to add a gate is to give the agent an MCP-based approval tool rather than hand-rolling REST calls inside a custom function tool.

## Setup: adding Impri as an MCP toolset

```python
from google.adk.agents import Agent
from google.adk.tools.mcp_tool import MCPToolset, StdioServerParameters

impri_toolset = MCPToolset(
    connection_params=StdioServerParameters(
        command="npx",
        args=["@impri/mcp"],
        env={"IMPRI_API_KEY": "im_your_key_here"},
    )
)

cleanup_agent = Agent(
    name="gcp_cost_cleanup",
    model="gemini-2.5-pro",
    instruction=(
        "Find unused BigQuery datasets and GCS buckets. Before deleting anything, "
        "push an impri_push_action with kind='gcp.resource.delete' describing what "
        "you found and why, then wait on impri_await_decision. Only call the delete "
        "tool if the decision status is 'approved'."
    ),
    tools=[find_unused_resources, delete_gcp_resource, *impri_toolset.get_tools()],
)
```

The agent now has three tool families: one to find candidates, one to actually delete, and Impri's `impri_push_action` / `impri_await_decision` / `impri_report_result` to gate the path between them.

## Why the instruction alone isn't the gate

Notice the instruction *tells* the model to check for approval before deleting — and models mostly follow instructions like that. "Mostly" is the problem. The actual gate isn't the sentence in the prompt; it's whether `delete_gcp_resource` can be reached without an approved decision. If your `delete_gcp_resource` function checks nothing and just calls the GCP API, a model that skips the approval step (bad context, a confusing tool result, an unusual phrasing in the found-resources list) still deletes the bucket. Wrap the delete function itself:

```python
def delete_gcp_resource(resource_id: str, approved_action_id: str) -> dict:
    """Deletes a GCP resource. Requires an Impri action_id with status 'approved'."""
    status = check_impri_action_status(approved_action_id)  # calls GET /v1/actions/:id
    if status["status"] != "approved":
        return {"error": f"action {approved_action_id} is {status['status']}, not approved"}

    resource_type, name = resource_id.split(":", 1)
    _do_delete(resource_type, name)  # actual GCP client call
    report_impri_result(approved_action_id, "executed")
    return {"deleted": resource_id}
```

Now the model *can* call `delete_gcp_resource` directly, but the function refuses to do anything without a matching approved action ID — the chokepoint lives in code, not in the system prompt.

## What the reviewer sees

| Field | Value in this example |
|---|---|
| `kind` | `gcp.resource.delete` |
| `title` | "Delete unused dataset: analytics.raw_events_2024" |
| `preview.body` | Last-access timestamp, size, estimated monthly cost saved |
| `expires_in` | `259200` (default 72h — plenty of time to double-check with the data team) |
| `undo` | "Dataset was exported to gs://backups/pre-delete/ before removal; restore with `bq load`" |

Setting `undo` matters here specifically because dataset deletion is not reversible through the API itself — Impri just displays the plain-English escape hatch on the card so the reviewer knows one exists before approving.

---

## What this doesn't cover

Impri doesn't inspect the GCP resource, doesn't know if the dataset is actually safe to delete, and doesn't talk to the GCP API at all — that's entirely `delete_gcp_resource`'s job. It also isn't IAM: it doesn't restrict *who* can technically call the delete function, only whether a human signed off before that specific call ran with that specific resource ID. Keep IAM scoped tightly regardless of whether Impri is in the loop.

For the underlying MCP tool contract, see [mcp](mcp.md). For the same wrapper pattern applied to other SDKs, see [integrations](integrations.md), and for getting an API key first, the [quickstart](quickstart.md).
