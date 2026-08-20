# How to Review AI-Generated Content Before It Goes Out

Review AI-generated content before it goes out by gating the send call itself — a human reads the actual draft, edits it if needed, and only then does it publish.

---

## "I'll read it before I hit send" doesn't survive contact with a queue

Most content-review processes start as a habit, not a system: the person running the agent reads each draft before it goes anywhere. That works for the first ten. It stops working the day the agent is scheduled to draft a weekly newsletter, or gets hooked up to a content calendar that queues posts three days out, or starts running unattended overnight. Nobody is sitting there reading each one anymore, and "I'll remember to check" quietly becomes "it went out and I found out from a reply."

The fix isn't a stricter habit. It's making the send call itself unable to run until a specific human has looked at the specific text and said yes. That's a gate, not a policy.

---

## Gate the send, not the draft

The agent still writes the draft however it wants. What changes is where the draft goes next: instead of calling your email/CMS/social API directly, it pushes the draft as a pending action, blocks on a decision, and only calls the real send function if that decision comes back approved. In PHP, for a newsletter agent drafting a weekly campaign email:

```php
<?php

$base = 'https://api.impri.dev';
$headers = [
    'Authorization: Bearer ' . getenv('IMPRI_API_KEY'),
    'Content-Type: application/json',
];

function push_campaign_draft(string $subject, string $body, string $previewUrl): string
{
    global $base, $headers;
    $payload = json_encode([
        'kind' => 'email.send',
        'title' => "Newsletter: {$subject}",
        'preview' => ['format' => 'markdown', 'body' => $body],
        'target_url' => $previewUrl,
        'editable' => ['preview.body'],
        'idempotent' => false,
        'expires_in' => 172800, // 2 days — a weekly send can wait a day for review without going stale
    ]);

    $ch = curl_init("$base/v1/actions");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $payload,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $result = json_decode(curl_exec($ch), true);
    curl_close($ch);
    return $result['id'];
}

function await_and_send(string $actionId, callable $sendCampaign): void
{
    global $base, $headers;
    do {
        sleep(15);
        $ch = curl_init("$base/v1/actions/$actionId");
        curl_setopt_array($ch, [CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true]);
        $result = json_decode(curl_exec($ch), true);
        curl_close($ch);
    } while ($result['status'] === 'pending');

    if ($result['status'] !== 'approved') {
        error_log("Campaign not sent: {$result['status']}");
        return;
    }

    // final_preview carries any edits the reviewer made — never send the original draft
    $sendCampaign($result['decision']['final_preview']['body']);

    $ch = curl_init("$base/v1/actions/$actionId/result");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode(['status' => 'executed']),
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
    ]);
    curl_exec($ch);
    curl_close($ch);
}
```

`sendCampaign` — the real call to your ESP — lives entirely inside the `if approved` branch. There is no code path where a draft reaches subscribers without a human having read the version that's about to go out.

---

## What a reviewer actually needs to check

"Review the content" means something different depending on what's being sent. A useful review isn't "does this look roughly right" — it's a short, specific checklist the reviewer can run in under a minute:

| Check | Why it matters |
|---|---|
| Factual claims match reality | An agent summarizing a product update can misstate a number or a date |
| Tone matches the brand | Drafts trend generic; a human catches when it reads like nobody |
| Links resolve to the right place | A wrong or missing UTM link breaks attribution silently |
| No leftover placeholder text | `{{first_name}}` or `[INSERT STAT HERE]` slipping through is the most common miss |
| Legally required elements present | Unsubscribe link, physical address, required disclaimers |

Put the fields that matter most for the checklist directly in `preview.body` — a reviewer approving from a phone notification shouldn't have to click through to a CMS just to confirm the unsubscribe link is intact.

---

## Letting the reviewer fix small things without blocking the whole send

Setting `editable: ["preview.body"]` means the reviewer isn't limited to a binary approve/reject — they can fix a wrong link or a stray placeholder directly in the inbox before approving. That's the difference between "reject and ask the agent to redraft" (another full generation cycle) and "fix the one line that's wrong" (thirty seconds). The API reflects this back as `decision.diff`, a unified diff of exactly what changed, so anyone auditing the send later can see the draft the agent produced and the version that actually went out.

---

## Rejected and expired drafts

A `rejected` or `expired` status means `sendCampaign` never runs — the polling loop exits before reaching that line. Set `expires_in` to match how time-sensitive the content actually is: a breaking-news social post needs a short window measured in minutes, while a monthly newsletter can sit for a day without going stale. An expired draft that's still relevant should be re-pushed as a new action against the current send date, not force-approved past its window.

---

## What Impri does and doesn't check

Impri stores the draft, notifies the reviewer, and holds the decision — it does not check facts, does not enforce brand voice, and never calls your ESP or CMS itself. All of that judgment stays with the human reading the card. It's also only a real gate if `sendCampaign` has no other path to firing — if the agent also holds a raw API key for your ESP, it can route around the review entirely, so that credential belongs only inside the wrapper that runs after approval.

For the underlying three-call pattern this builds on, see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md). For approving from Slack instead of the web inbox, see [Slack approval](slack-approval.md). Once reviews are flowing through Impri, [the audit log](audit-log.md) gives you a record of every campaign sent, by whom it was approved, and what changed before it went out.

Next step: [quickstart](quickstart.md) to get an API key and try this against a single draft first.
