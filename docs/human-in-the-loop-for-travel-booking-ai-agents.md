# Human-in-the-Loop for Travel Booking AI Agents

A travel-booking AI agent that can search flights and hotels but not pay for them on its own — this guide wires an Impri approval gate in Python before any booking charges a card.

---

## Why travel bookings are a bad place for full autonomy

A travel agent that only searches and compares is low-risk: wrong results cost a re-query. A travel agent that also books is a different category of risk — a booked flight charges a real card, and cancellation policies vary by fare class, so "just cancel it" is not always true or free. Add ambiguity in the source request ("book the earlier one" when the itinerary has three legs) and the failure mode is a nonrefundable ticket for the wrong day.

This is exactly the shape of action Impri is built for: the agent can search and shortlist freely, but the specific booking call needs a human to look at the itinerary and price once before it's confirmed.

## Pushing the booking as a pending action

Once the agent has narrowed the search to one flight (or hotel room) it wants to book, it pushes the booking as an action instead of calling the airline/OTA API directly:

```python
import os
import requests

IMPRI_API_KEY = os.environ["IMPRI_API_KEY"]
BASE = "https://api.impri.dev"

def propose_booking(itinerary, price_usd, fare_class):
    body = {
        "kind": "travel.book_flight",
        "title": f"Book {itinerary['origin']}→{itinerary['destination']} "
                  f"{itinerary['date']} — ${price_usd} ({fare_class})",
        "preview": {
            "format": "markdown",
            "body": (
                f"**{itinerary['carrier']} {itinerary['flight_no']}**\n\n"
                f"- Depart: {itinerary['depart_time']}\n"
                f"- Arrive: {itinerary['arrive_time']}\n"
                f"- Fare class: {fare_class}\n"
                f"- Price: ${price_usd}\n"
            ),
        },
        "idempotent": False,
        "undo": f"Cancel within the {fare_class} fare's refund window, or contact "
                f"{itinerary['carrier']} support with the confirmation code.",
        "expires_in": 1800,  # fares can reprice within the hour
        "editable": [],
    }
    res = requests.post(
        f"{BASE}/v1/actions",
        headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
        json=body,
    )
    res.raise_for_status()
    return res.json()["id"]
```

Note `editable` is left empty here — a reviewer can approve or reject a flight booking, but there is no sensible partial edit to a fare and price the way there is for an email draft.

## Waiting for a decision, then booking

```python
import time

def await_decision(action_id, timeout_s=900, poll_every=15):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        res = requests.get(
            f"{BASE}/v1/actions/{action_id}",
            headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
        )
        status = res.json()["status"]
        if status != "pending":
            return res.json()
        time.sleep(poll_every)
    return {"status": "expired"}

decision = await_decision(action_id)

if decision["status"] == "approved":
    confirmation = airline_api.book(itinerary)  # your real booking call
    requests.post(
        f"{BASE}/v1/actions/{action_id}/result",
        headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
        json={"status": "executed", "payload": {"confirmation_code": confirmation.code}},
    )
else:
    # rejected or expired — do not book, surface it back to the traveler
    notify_user(f"Booking not confirmed: {decision['status']}")
```

The 30-minute `expires_in` above matters more here than in most Impri use cases: airline fares reprice, and a booking approved against a price quoted an hour ago may no longer be bookable at that price. Treat `expired` as "re-quote and ask again," not just "give up."

## Multi-leg trips: one action per leg, not one for the whole trip

For a multi-city itinerary, push a separate action per leg rather than one action covering the whole trip. A reviewer can then approve the outbound flight while rejecting a bad connection on the return, and the `undo` field can describe each leg's specific cancellation terms instead of an averaged, less accurate summary.

## Prompt injection from booking sources

If the agent reads flight or hotel data scraped from a third-party site or an email forward ("book whatever's cheapest"), treat that content as data, not instruction — a page claiming a fake "government fee due now" should not make it into `preview.body` as if it were a legitimate line item. Impri displays exactly what the agent sends; it does not verify prices or itineraries against the airline.

Next: see the [MCP integration](mcp.md) if your travel agent runs inside Claude Code or another MCP client, or start with the [quickstart](quickstart.md) to get an API key.
