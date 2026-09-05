# Human-in-the-Loop for Microsoft Semantic Kernel Agents

Add a human approval gate to Semantic Kernel function calling so a plugin can't send, post, or spend money until a person taps approve on the actual generated payload.

---

## Where the gap is in Semantic Kernel

Semantic Kernel's `FunctionInvocationFilter` gives you a hook that runs before and after any plugin function the kernel decides to call. That's the right layer to intercept — but "intercept" usually means either an in-process `Console.ReadLine()` prompt (useless once the agent runs unattended on a server) or nothing at all. Neither gets you a real approval record, a mobile-friendly approve/reject, or the ability to let a reviewer edit the draft before it goes out.

Impri fills that specific gap: it's a gate that stores the proposed function call, notifies a human on their phone or desktop, and holds the decision — nothing more. Semantic Kernel still owns planning and function orchestration; Impri only owns the yes/no.

---

## Wiring the filter

Register an `IFunctionInvocationFilter` that intercepts sensitive plugin functions — here, an `EmailPlugin.SendEmail` function — and routes the call through Impri instead of letting it execute directly.

```csharp
public class ImpriApprovalFilter : IFunctionInvocationFilter
{
    private readonly HttpClient _http;
    private static readonly HashSet<string> GatedFunctions = new() { "SendEmail", "PostToSlack" };

    public ImpriApprovalFilter(HttpClient http) => _http = http;

    public async Task OnFunctionInvocationAsync(
        FunctionInvocationContext context, Func<FunctionInvocationContext, Task> next)
    {
        if (!GatedFunctions.Contains(context.Function.Name))
        {
            await next(context);
            return;
        }

        var body = string.Join("\n", context.Arguments.Select(a => $"{a.Key}: {a.Value}"));

        var createResp = await _http.PostAsJsonAsync("https://api.impri.dev/v1/actions", new
        {
            kind = "email.send",
            title = $"Semantic Kernel: {context.Function.Name}",
            preview = new { format = "markdown", body },
            expires_in = 3600,
            editable = new[] { "preview.body" }
        });
        var action = await createResp.Content.ReadFromJsonAsync<ImpriAction>();

        ImpriDecision decision;
        while (true)
        {
            await Task.Delay(TimeSpan.FromSeconds(10));
            var poll = await _http.GetFromJsonAsync<ImpriDecision>(
                $"https://api.impri.dev/v1/actions/{action.Id}");
            if (poll.Status != "pending") { decision = poll; break; }
        }

        if (decision.Status != "approved")
        {
            context.Result = new FunctionResult(context.Function, $"Not sent: {decision.Status}");
            return; // next() is never called — SendEmail never runs
        }

        // Swap in the human-edited body before the real function runs
        context.Arguments["body"] = decision.Decision.FinalPreview.Body;
        await next(context);

        await _http.PostAsJsonAsync(
            $"https://api.impri.dev/v1/actions/{action.Id}/result", new { status = "executed" });
    }
}
```

Register it on the kernel:

```csharp
var kernel = Kernel.CreateBuilder()
    .AddOpenAIChatCompletion(modelId, apiKey)
    .Build();

kernel.FunctionInvocationFilters.Add(new ImpriApprovalFilter(httpClient));
kernel.ImportPluginFromType<EmailPlugin>();
```

The critical line is `if (decision.Status != "approved") { ...; return; }` — the filter's `next(context)` delegate is what actually invokes `EmailPlugin.SendEmail`, and it's simply never called on rejection or expiry. There's no code path where a non-approved call reaches the plugin.

---

## Why the filter, not the planner

You could try gating at the planner level instead — inspecting the plan before the kernel executes any step. That works for stopping a whole plan, but it loses granularity: a plan might legitimately read a calendar, summarize a document, *and* send an email, and you only want to gate the last one. The `FunctionInvocationFilter` runs per-function-call, so read-only plugins run freely and only the ones you list in `GatedFunctions` pause for a human.

This is also why Impri only works as a real gate if `EmailPlugin` (or whatever wraps the actual side effect) has no other way to fire — if the kernel or a separate service account can call the mail API directly outside this filter, the agent has a bypass. See [the Semantic Kernel integration notes](integrations.md) for wrapping the underlying client so the filter is the only path.

---

## What you get, and what you don't

| Capability | Provided by |
|---|---|
| Deciding *whether* the plan should include sending an email | Semantic Kernel planner — Impri has no opinion here |
| Holding execution until a human decides | Impri |
| Letting the reviewer edit the email body before it sends | Impri (`editable` + `final_preview`) |
| Audit record of who approved what, when | Impri |
| Retrying or branching the plan on rejection | Your filter's `else` branch — Impri just reports the status |

Impri doesn't understand Semantic Kernel plans, functions, or plugins — it sees a title, a markdown preview, and a decision. All the C#-specific wiring above is yours to write; Impri's job stops at `{ status: "approved" | "rejected" | "expired" }`.

---

## Next step

Start with the [quickstart](quickstart.md) to get an API key, then read [the MCP integration](mcp.md) if you'd rather have Semantic Kernel call `impri_push_action` as a plugin function directly instead of hand-rolling the HTTP calls above.
