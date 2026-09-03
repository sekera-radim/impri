# Human-in-the-Loop in Microsoft Agent Framework

Microsoft Agent Framework can pause a tool call for confirmation — here's how to wire that pause to a real human approval inbox instead of a console prompt.

---

## What Agent Framework gives you, and what it doesn't

Microsoft Agent Framework's approval pattern lets a function tool declare that it requires confirmation before running; the framework pauses the agent loop, surfaces the pending call, and resumes once your code returns a decision. That's the right shape — propose, pause, decide, execute — but the framework leaves the "decide" part to you. In a local console app that's a `Console.ReadLine()`. In anything that runs unattended (a scheduled job, a Teams bot, a background worker with no one watching stdin), you need somewhere durable to put that pending decision and something that notifies an actual person.

That's the gap Impri fills. It doesn't replace Agent Framework's approval hook — it becomes the thing the hook calls into.

---

## Wrapping a sensitive tool call

Say the agent manages IT support tickets: it can read tickets, draft resolutions, and — the sensitive part — close a ticket and post the resolution to a Teams channel. Closing a ticket is hard to undo cleanly (reopening loses the original SLA clock), so it's the one tool worth gating.

```csharp
using System.Net.Http.Json;

public class TicketApprovalTool
{
    private readonly HttpClient _http;
    private const string ImpriBase = "https://api.impri.dev";

    public TicketApprovalTool(HttpClient http) => _http = http;

    public async Task<string> CloseTicketWithApproval(string ticketId, string resolutionSummary)
    {
        // 1. Push the proposed action instead of closing the ticket directly
        var createResponse = await _http.PostAsJsonAsync($"{ImpriBase}/v1/actions", new
        {
            kind = "ticket.close",
            title = $"Close ticket {ticketId}",
            preview = new { format = "markdown", body = resolutionSummary },
            target_url = $"https://support.example.com/tickets/{ticketId}",
            expires_in = 14400, // 4 hours — support SLAs don't wait long
            editable = new[] { "preview.body" }
        });
        var action = await createResponse.Content.ReadFromJsonAsync<ActionResponse>();

        // 2. Poll until a human decides
        ActionStatus status;
        do
        {
            await Task.Delay(TimeSpan.FromSeconds(10));
            var poll = await _http.GetFromJsonAsync<ActionStatus>(
                $"{ImpriBase}/v1/actions/{action!.Id}");
            status = poll!;
        } while (status.Status == "pending");

        // 3. Only close the ticket if approved, and use the human-edited text
        if (status.Status != "approved")
            return $"Ticket {ticketId} not closed — reviewer {status.Status} the action.";

        var finalSummary = status.Decision!.FinalPreview.Body;
        await CloseTicketInSystem(ticketId, finalSummary); // your actual ticketing call

        await _http.PostAsJsonAsync($"{ImpriBase}/v1/actions/{action.Id}/result",
            new { status = "executed" });

        return $"Ticket {ticketId} closed with reviewer-approved summary.";
    }
}
```

Register `CloseTicketWithApproval` as the tool the agent calls instead of a direct `CloseTicket` function. The model never gets a code path that closes a ticket without going through this method first.

---

## Why this matters more with planning agents

Agent Framework agents often run multi-step plans: read the ticket, search a knowledge base, draft a resolution, then close it. A plan like that can execute three or four tool calls in a row without a human in view. If only the final, destructive step is gated, everything upstream of it — the reads, the drafting — can run freely, and the human only sees the one decision that actually matters: the summary about to be posted and the ticket about to close. That's the right place to spend a reviewer's attention, not on every intermediate read.

If your agent runs on a schedule (see [gate a cron job with human approval](gate-a-cron-job-with-human-approval.md) for that pattern specifically), there's no console attached at all — the approval inbox is the only place a decision can land.

---

## Handling rejection and expiry

`expires_in` above is set to four hours because a stale ticket resolution isn't worth posting a day later. If the action expires or gets rejected, `status.Status` will be `"expired"` or `"rejected"`, and the method above returns without calling the ticketing system — there's no separate branch to remember, because the close call only happens inside the `approved` check.

---

## What Impri isn't doing here

Impri doesn't know what a support ticket is, doesn't validate the resolution text, and doesn't talk to your ticketing system. It stores the proposed action, shows it to a human, and hands back a decision. Agent Framework still owns the agent loop and the actual tool execution; Impri owns exactly one question — did a person say yes — and nothing else. If you need branching logic across multiple approvals or a multi-step review workflow, that belongs in your own orchestration, not in the gate itself.

For the general integration pattern this builds on, see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md). For wrapping other SDKs the same way, see [integrations](integrations.md). New to Impri? Start with the [quickstart](quickstart.md).
