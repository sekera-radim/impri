# Human-in-the-Loop for AI HR Onboarding Agents

Before an onboarding agent creates accounts or grants access for a new hire, human-in-the-loop review catches the wrong start date, wrong team, or wrong system.

---

## Where onboarding agents overreach

| Agent action | Autonomous is fine | Needs a human first |
|---|---|---|
| Draft a welcome email | Yes | — |
| Look up which teams/tools a role needs | Yes | — |
| Create the SSO account | — | Yes |
| Invite to Slack channels | — | Yes |
| Grant repo or admin access | — | Yes |
| Send the welcome email | — | Yes |

An onboarding agent is usually right — it reads the HRIS record, matches the role to a template, and drafts the right set of actions. The problem is what happens on the days it's wrong: a start date pulled from a stale record, a contractor mapped to the full-time template, a role matched to the wrong department's access list. None of those show up as an error. The agent just confidently provisions the wrong thing, and by the time anyone notices, a contractor has prod access or a new hire got added to a channel two teams over.

HR data also has a compliance angle most agent actions don't: account creation and access grants for a real person are the kind of change an auditor will ask about later. A human approval step means that trail exists by construction, not by someone remembering to write it down.

## Gating the provisioning actions

The drafting stays agentic. Only the three actions in the right-hand column above go through Impri. Using the TypeScript SDK's `requiresApproval` wrapper keeps the approval logic out of the provisioning functions themselves:

```typescript
import { ImpriClient, ImpriRejected } from '@impri/sdk'

const client = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! })

async function createSsoAccount(employee: { name: string; email: string; role: string }) {
  await sso.createUser({ email: employee.email, displayName: employee.name, role: employee.role })
}

const gatedCreateSsoAccount = client.requiresApproval(createSsoAccount, {
  kind: 'hr.account_provision',
  title: (employee) => `Create SSO account: ${employee.name} (${employee.role})`,
  preview: (employee) => ({
    format: 'markdown' as const,
    body: `**Name:** ${employee.name}\n**Email:** ${employee.email}\n**Role:** ${employee.role}\n\nStart date confirmed in HRIS. Approving creates the SSO account and assigns the ${employee.role} access template.`,
  }),
  expiresIn: 172800, // 48h — most onboarding runs a day or two ahead of start date
})

try {
  await gatedCreateSsoAccount({ name: 'Jordan Lee', email: 'jordan.lee@company.com', role: 'backend-engineer' })
} catch (err) {
  if (err instanceof ImpriRejected) {
    console.log('HR rejected — likely a data mismatch, check the HRIS record before retrying.')
  } else {
    throw err
  }
}
```

The Slack invite and welcome email get their own `requiresApproval`-wrapped functions with their own `kind` (`hr.channel_invite`, `hr.welcome_email`) rather than being bundled into one giant approval — a reviewer who's fine with the SSO account but unsure about a channel invite (say, it's a channel with a client on it) can approve one and reject the other independently.

## What the HR reviewer sees

Each card shows the employee's name, role, and the specific system being touched — not a generic "onboarding task pending" notification that requires opening a dashboard to understand. Because these actions don't set `editable`, the reviewer can't silently rewrite the role or email inline; if something's wrong, rejecting and fixing the source HRIS record is the correct path, not editing around it. That also means `decision.finalPreview` will always match the original `preview` for these actions — there's no human-edited draft to reconcile before provisioning.

## Handling rejection and expiry

A rejected onboarding action almost always means bad source data, not a bad automation. Route the rejection back to whoever owns the HRIS record rather than silently retrying — retrying an SSO account creation against the same stale data just produces the same rejection. Treat `expired` the same way: a 48-hour-old unreviewed provisioning request usually means the request queue itself needs a nudge, covered in more depth in the [core integration guide](how-to-add-human-approval-to-an-ai-agent.md).

## Next step

If your onboarding agent runs as an MCP tool inside an internal ops assistant rather than a standalone script, see the [MCP integration](mcp.md) for the equivalent three-call flow without writing HTTP or SDK code directly. For notifying HR over Slack instead of the web inbox, see [Slack approval](slack-approval.md).
