# Human Approval Before an AI Agent Automates Your Browser

A browser-automation agent that can click, type, and submit needs a human checkpoint before the irreversible click — here's how to wire that gate into a Playwright-driven agent.

---

## Why browser agents are a special case

Most "agent needs approval" guides assume the risky step is an API call: send an email, hit an endpoint, post a comment. A browser-automation agent (Playwright, Puppeteer, a computer-use loop driving a real Chrome instance) is different in one important way — the dangerous action isn't a request your code makes, it's a DOM interaction your code triggers: `page.click("#submit-payment")`, `page.fill("#wire-amount", "50000")`. There's no API response to inspect after the fact. Once the click fires, the page has already done whatever the click does.

That means the gate has to sit *before* the interaction that matters, not around it. The agent proposes the exact action ("submit this checkout form with these values"), a human looks at a rendered preview of what's about to happen, and only an explicit approval unlocks the line of code that calls `.click()` or `.fill()`.

## Wiring it into a Playwright agent

The pattern is the same three calls as any other Impri integration — push, poll, execute — but the "preview" is a description of the DOM action, and "execute" is the actual Playwright call:

```python
import os
import time
import requests

IMPRI = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def request_approval(kind: str, title: str, body: str, editable=None) -> dict:
    resp = requests.post(
        f"{IMPRI}/v1/actions",
        headers=HEADERS,
        json={
            "kind": kind,
            "title": title,
            "preview": {"format": "markdown", "body": body},
            "expires_in": 900,  # 15 minutes — a stale checkout page isn't worth submitting
            "editable": editable or [],
        },
    )
    return resp.json()

def wait_for_decision(action_id: str, poll_every=5) -> dict:
    while True:
        resp = requests.get(f"{IMPRI}/v1/actions/{action_id}", headers=HEADERS).json()
        if resp["status"] != "pending":
            return resp
        time.sleep(poll_every)

# --- in the agent's checkout flow ---
action = request_approval(
    kind="browser.checkout_submit",
    title="Submit checkout: office chair x1, $312.40, ship to warehouse address",
    body="**Cart:** Steelcase Series 2 chair\n**Total:** $312.40\n**Ship to:** 445 Warehouse Rd\n\nClicking 'Place order' cannot be undone from this script.",
)

decision = wait_for_decision(action["id"])

if decision["status"] == "approved":
    page.click("#place-order")
    requests.post(
        f"{IMPRI}/v1/actions/{action['id']}/result",
        headers=HEADERS,
        json={"status": "executed"},
    )
else:
    print(f"Checkout not submitted — decision was {decision['status']}")
```

The `page.click("#place-order")` line — the only line that actually spends money — is unreachable unless `decision["status"] == "approved"`. That's the whole mechanism.

## What the reviewer sees

The approval card shows the `title` and `preview.body` you constructed, not a screenshot of the live page. Write the preview to describe *exactly* what will happen if approved — amounts, destinations, recipients — since that's the only information the human has to decide with:

| Browser action | Good `title` | Bad `title` |
|---|---|---|
| Submitting a payment form | "Submit checkout: $312.40 to Acme Furniture, card ending 4242" | "Submit form" |
| Posting a public comment | "Post reply on r/webdev thread 'best CI tool'" | "Do the browser thing" |
| Changing account settings | "Update billing email to ops@acme.com" | "Update settings" |

If you need the human to be able to fix a typo in the value before it's typed into the page — a shipping address, a comment body — list that field in `editable` and read it back from `decision.final_preview` rather than your original draft, the same as any other Impri integration.

## Where this boundary actually sits

Be precise about what this does and doesn't cover. Impri gates the *decision*, not the browser session. If your agent process holds a logged-in session and can call `page.click()` anywhere in its code, a bug or a prompt-injected instruction from a page it's scraping could still trigger the click without ever calling `request_approval`. The gate is only real if the checkout/submit/post code path is physically unreachable without a stored `approved` decision — which usually means putting the approval check inside the one function that's allowed to touch those selectors, and not giving the rest of the agent's code a shortcut around it.

Impri does not render the page, does not verify the DOM matches your description, and does not click anything itself — it stores the proposed action and the decision, nothing more.

## Next step

Start with the [quickstart](quickstart.md) to get an API key, then read [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the full request/poll/execute pattern this is built on. If your agent runs on Python already, the [Python SDK](sdk-python.md) wraps these same three REST calls.
