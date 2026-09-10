# Human Approval for AI Trading Agents

An AI trading agent that can size and place orders on its own is one bad signal away from a real loss — this shows how to gate order execution behind a human yes.

---

## The problem is the order, not the analysis

Letting an agent scan news, compute indicators, or backtest a strategy is low-risk — nothing happens until an order goes to a broker. The risk shows up exactly at that boundary: a mispriced signal, a stale data feed, or a hallucinated position size turns into a real fill in seconds, and unlike a bad blog post, a bad trade cannot be quietly deleted afterward.

The fix isn't slowing the agent's reasoning down — it's putting a stop between "the agent decided" and "the broker executed." That stop needs to be a real dependency the code cannot skip, not a comment telling the model to "confirm with the user first."

---

## Gate the broker call, not the strategy loop

The pattern is the same three calls as any other Impri integration: push the proposed order as an action, wait for a decision, then call the broker's API only if approved. The strategy code that decides *what* to trade never talks to the broker directly — a thin wrapper does, and that wrapper refuses to run without an `approved` status.

```python
import os
import time
import requests

IMPRI_KEY = os.environ["IMPRI_API_KEY"]
BASE = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {IMPRI_KEY}"}

def propose_order(symbol, side, qty, est_price):
    body = {
        "kind": "trade.order",
        "title": f"{side.upper()} {qty} {symbol} @ ~${est_price}",
        "preview": {
            "format": "markdown",
            "body": f"**{side.upper()} {qty} shares of {symbol}**\n\n"
                    f"Estimated price: ${est_price}\n"
                    f"Estimated notional: ${qty * est_price:.2f}\n\n"
                    f"Signal: 20/50 EMA crossover, RSI 34",
        },
        "idempotent": False,
        "undo": f"Submit an offsetting {'sell' if side == 'buy' else 'buy'} "
                f"order for {qty} {symbol} to flatten the position",
        "expires_in": 300,  # a stale signal is a wrong signal, keep this short
        "editable": ["preview.body"],
    }
    r = requests.post(f"{BASE}/v1/actions", headers=HEADERS, json=body)
    return r.json()["id"]

def await_decision(action_id, poll_every=5, timeout=300):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = requests.get(f"{BASE}/v1/actions/{action_id}", headers=HEADERS)
        data = r.json()
        if data["status"] != "pending":
            return data
        time.sleep(poll_every)
    return {"status": "expired"}

def place_order_if_approved(symbol, side, qty, est_price, broker_client):
    action_id = propose_order(symbol, side, qty, est_price)
    decision = await_decision(action_id)

    if decision["status"] != "approved":
        print(f"Order not sent: {decision['status']}")
        return

    # broker_client is your own SDK/wrapper — never called before this line
    order = broker_client.submit_order(symbol=symbol, side=side, qty=qty)

    requests.post(
        f"{BASE}/v1/actions/{action_id}/result",
        headers=HEADERS,
        json={"status": "executed", "payload": {"broker_order_id": order.id}},
    )
```

Note the short `expires_in`: 300 seconds, the API minimum. A trade signal that's five minutes stale is a different trade — treat `expired` the same as `rejected` and require the strategy to re-propose with fresh prices rather than resurrecting an old approval.

---

## What the approval card should show

| Field | Why it matters here |
|---|---|
| Symbol, side, quantity, estimated price | The reviewer's actual decision surface |
| Estimated notional | Catches size errors before they're a keystroke away from real money |
| Signal / reasoning summary | Lets a human sanity-check the "why," not just the "what" |
| `idempotent: false` badge | Warns against retrying a timed-out request, which would double the position |
| `undo` text | Tells the reviewer the position isn't permanent if they're wrong |

Keep `preview.body` short and numeric. A reviewer approving from their phone between meetings needs the notional value and the side, not a paragraph of technical-indicator prose.

---

## What Impri does not do here

Impri does not evaluate the trade, check it against a risk model, or know what a "reasonable" position size is for your account — it stores the proposal, notifies you, and holds the decision until you act on it. Your strategy code still owns risk limits, position sizing, and market-data validity; Impri only owns the question of whether a human said yes before the broker call fired. And it's a real gate only if the strategy process holds no broker credential capable of placing orders outside this path — see [wrapping a tool with a human approval step](wrapping-a-tool-with-a-human-approval-step.md) for how to structure that boundary. For the general shape of the fintech vertical beyond trading specifically (payments, transfers, refunds), see [human approval for fintech AI agents](human-approval-for-fintech-ai-agents.md).

**Next step:** [quickstart](quickstart.md) to get an API key, then adapt the wrapper above with the [Python SDK](sdk-python.md) instead of raw `requests` calls.
