# Human-in-the-Loop for Computer-Use AI Agents

Computer-use agents click and type on a real screen — here's where to put a human approval gate when the agent's output is a coordinate, not a message.

---

## Reviewing every click doesn't scale

A computer-use agent (the kind built on tool loops like Anthropic's computer use, or a browser-automation agent driving Playwright) doesn't emit one action per task — it emits dozens: move mouse, screenshot, click, type, screenshot, scroll. If you tried to gate every one of those through a human inbox, the agent would be unusable and the human would be rubber-stamping "click at (412, 88)" without any real judgment behind it.

The useful gate isn't at the level of individual mouse events. It's at the level of the specific clicks that cross an irreversible boundary: submitting a payment form, sending a message, confirming a delete, checking out a cart. Everything before that — navigating, reading, filling in fields — can run freely, because none of it commits to anything outside the agent's own sandbox until that one click.

## Gating the click, not the loop

The pattern is to keep the agent's screenshot-act loop exactly as it is, and add one check inside the tool executor for the small set of actions you've flagged as sensitive. The model still decides *when* to click "Confirm Payment" — the executor decides whether that click is allowed to actually fire yet.

```python
import time
import requests

IMPRI_KEY = "im_your_key_here"
SENSITIVE_LABELS = {"confirm payment", "send", "delete", "place order"}

def execute_click(action: dict, screenshot_b64: str) -> dict:
    label = action.get("target_label", "").lower()
    if label not in SENSITIVE_LABELS:
        return perform_click(action["x"], action["y"])  # runs immediately, no gate

    resp = requests.post(
        "https://api.impri.dev/v1/actions",
        headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        json={
            "kind": "computer_use.click",
            "title": f"Click '{action['target_label']}' at ({action['x']}, {action['y']})",
            "preview": {
                "format": "markdown",
                "body": f"Agent wants to click **{action['target_label']}**.\n\n![screenshot](data:image/png;base64,{screenshot_b64})",
            },
            "expires_in": 600,
        },
    )
    action_id = resp.json()["id"]

    status = "pending"
    while status == "pending":
        time.sleep(3)
        check = requests.get(
            f"https://api.impri.dev/v1/actions/{action_id}",
            headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        ).json()
        status = check["status"]

    if status != "approved":
        return {"skipped": True, "reason": status}

    return perform_click(action["x"], action["y"])
```

The reviewer approves or rejects looking at the actual screenshot the agent is acting on — not a text description of what it plans to do, which is the closest a computer-use agent gets to a "diff" of its intent.

## Which clicks to gate

| Action the agent wants to take | Gate it? |
|---|---|
| Navigate to a URL, scroll, read page text | No |
| Fill in a form field (not yet submitted) | No |
| Click "Add to cart" | No |
| Click "Place order" / "Confirm payment" | Yes |
| Click "Send" on an email or message compose window | Yes |
| Click "Delete" or "Permanently remove" | Yes |
| Accept a cookie banner, dismiss a modal | No |

The list is short on purpose. Every label you add to `SENSITIVE_LABELS` is a real interruption to the human, so keep it to actions that have a side effect outside the browser session itself.

## Why the gate has to live in the executor

A computer-use model doesn't call discrete named tools the way a function-calling agent does — it emits `(x, y)` coordinates and a description, and something on your side translates that into an actual `pyautogui.click()` or Playwright `.click()` call. That translation layer is the only place a gate can reliably sit, because the model's own token stream ("I'll pause here and check first") is not something you can trust to actually stop execution. If `perform_click` is reachable from anywhere else in your code — a retry path, a fallback handler — the gate is decorative. Route every real click through `execute_click`, including retries.

## Expiry for live sessions

A computer-use session is interactive and short-lived compared to an overnight batch job, so `expires_in: 600` (10 minutes) or less usually fits better than the 72-hour default — if nobody approves the payment click in ten minutes, the browser state has likely moved on anyway and the stale action should expire rather than fire late.

---

New to gating agent actions at all, not just computer-use ones? The [core pattern](how-to-add-human-approval-to-an-ai-agent.md) walks through the three-call flow this example builds on, and the [Python SDK](sdk-python.md) wraps the `requests` calls above into two function calls if you'd rather not hand-roll the polling loop. Start with the [quickstart](quickstart.md) to get an API key first.
