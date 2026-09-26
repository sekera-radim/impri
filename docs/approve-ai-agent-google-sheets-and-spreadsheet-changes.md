# Approve AI Agent Google Sheets and Spreadsheet Changes

Approve AI agent Google Sheets and spreadsheet changes before they land: show the cell diff, let a human reject it, and write only what was approved.

Spreadsheets are where quiet damage happens. An agent that "cleans up the pricing tab" can overwrite a hundred cells, break a formula that feeds a finance report, and leave no obvious trace. This page shows how to make the agent propose the change as a reviewable diff, and write it only after a human says yes.

---

## Why spreadsheet writes deserve a gate

A sheet is shared state. Other people, formulas, dashboards and exports depend on it, and the edit history is a poor substitute for a decision record. Three failure modes come up again and again:

- **Wrong range.** The agent resolves "the Q3 column" to the wrong column and overwrites real data.
- **Formula clobbering.** A computed cell gets replaced with a hard-coded value.
- **Volume.** A model that is 98% right on 2,000 rows is still wrong on 40 of them, and nobody reads 2,000 rows.

The fix is not a better prompt. It is to make the agent unable to write until a human has seen the exact change. Reading the sheet stays ungated; only the write goes through approval.

---

## Show a diff, not a summary

The reviewer cannot judge "updated 214 prices". Send the actual before and after as a markdown table in the preview, capped to what a person can scan, with the total count in the title.

| Field | What to put there |
|-------|-------------------|
| `kind` | `sheet.update_cells` (any string you choose) |
| `title` | Sheet name, tab, and number of cells, e.g. `Pricing / Q3: 214 cells` |
| `preview.body` | Markdown table: cell, old value, new value |
| `target_url` | Link to the sheet so the reviewer can open it |
| `expires_in` | Short (an hour or two) — a stale diff may no longer match the sheet |

The last row matters. If the sheet changes while the proposal sits in the inbox, the old values in your diff are wrong. Keep the expiry short and re-read the current values just before writing.

---

## Python example

This uses plain `requests` against the REST API. `read_current` and `apply_to_sheet` stand in for your own Sheets client code (gspread, the Sheets API, whatever you use) — Impri does not touch the sheet.

```python
import os, time, requests

API = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def propose_sheet_change(sheet_url, tab, changes):
    """changes: list of (cell, old, new)"""
    rows = "\n".join(f"| {c} | {old} | {new} |" for c, old, new in changes[:50])
    more = f"\n\n…and {len(changes) - 50} more cells." if len(changes) > 50 else ""
    body = "| Cell | Old | New |\n|---|---|---|\n" + rows + more

    r = requests.post(f"{API}/v1/actions", headers=HEADERS, json={
        "kind": "sheet.update_cells",
        "title": f"{tab}: {len(changes)} cells",
        "preview": {"format": "markdown", "body": body},
        "target_url": sheet_url,
        "expires_in": 3600,
        "idempotent": True,
        "undo": "Restore the previous values from the sheet's version history.",
    })
    r.raise_for_status()
    return r.json()["id"]

def wait(action_id):
    while True:
        a = requests.get(f"{API}/v1/actions/{action_id}", headers=HEADERS).json()
        if a["status"] != "pending":
            return a
        time.sleep(10)

action_id = propose_sheet_change(SHEET_URL, "Pricing", changes)
decision = wait(action_id)

if decision["status"] == "approved":
    try:
        # Re-read current values first; abort if they no longer match `old`.
        apply_to_sheet(SHEET_URL, "Pricing", changes)
        state = "executed"
    except Exception:
        state = "execute_failed"
    requests.post(f"{API}/v1/actions/{action_id}/result",
                  headers=HEADERS, json={"status": state})
```

Rejected and expired actions fall straight through: the write call is never reached. Note that `decision.final_preview` is a markdown table here, so we apply the original structured `changes` rather than parsing it back. If you want reviewers to edit values, set `editable` and parse `final_preview`, or keep the proposal small enough that "reject and re-ask" is fine.

---

## Where the gate can leak

Impri is a real gate only when your `apply_to_sheet` function is the agent's **only** route to the sheet. If the agent also holds a service-account key with edit rights and a generic "call the Sheets API" tool, it can write directly and never touch the approval flow. Give the agent read-only credentials for exploration, and keep write credentials inside the gated function that runs after approval.

Also be honest about scope: Impri stores the proposal, notifies you and holds the decision. It does not understand spreadsheets, validate that the diff matches what actually gets written, or check formulas. Your code has to make sure the applied changes equal the approved ones.

---

## Getting the request in front of you

Reviewers rarely sit in the inbox. Route the card where people already are — [Slack](slack-approval.md), [Telegram](telegram-approval.md), or plain [notifications](notifications.md) — so a 200-cell diff gets looked at within minutes instead of at the end of the day. Every decision lands in the [audit log](audit-log.md), which gives you the record the sheet's version history does not: who approved which change, and when.

---

## Next step

Get a key from the [quickstart](quickstart.md), then wrap your single write function as shown above. If your agent runs in an MCP client, the same flow works with `impri_push_action`, `impri_await_decision` and `impri_report_result` — see the [MCP guide](mcp.md).
