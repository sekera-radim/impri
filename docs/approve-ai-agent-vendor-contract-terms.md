# Approve AI Agent Vendor Contract Terms Before They're Signed

Have legal approve the exact redlined wording an AI contract agent proposes, not just a summary, before any counter-proposal reaches the vendor.

---

## The redline problem

A contract-review agent is useful precisely because it can read a 40-page vendor agreement and propose specific changes: a liability cap, a termination clause, a data-retention term. But "propose changes" and "send changes to the vendor" have to be two different steps with a human between them. Legal doesn't want a summary of what the agent thinks it changed — they want to read the literal text that's about to go out, and they want the ability to fix a clause themselves without kicking the whole draft back to the agent.

This is a good fit for Impri's `editable` field specifically, because contract terms are exactly the kind of content a reviewer edits in place rather than approves-or-rejects wholesale.

---

## Flow: agent drafts terms, legal edits and approves, agent sends

The example below uses the Impri MCP server, so the agent (running in Claude Code, Claude Desktop, or any MCP client) never writes raw HTTP calls — it just calls three tools in sequence.

**MCP config:**

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_your_key_here",
        "IMPRI_BASE_URL": "https://api.impri.dev"
      }
    }
  }
}
```

**Agent-side logic (TypeScript, using the Impri TypeScript SDK for the send-back step):**

```typescript
import { ImpriClient, ImpriRejected, ImpriExpired } from "@impri/sdk";

const impri = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! });

interface RedlineDraft {
  clause: string;
  originalText: string;
  proposedText: string;
  rationale: string;
}

async function proposeContractTerms(vendor: string, drafts: RedlineDraft[]) {
  const body = drafts
    .map((d) => `### ${d.clause}\n\n**Original:** ${d.originalText}\n\n**Proposed:** ${d.proposedText}\n\n_Why: ${d.rationale}_`)
    .join("\n\n---\n\n");

  const action = await impri.createAction({
    kind: "contract.terms.propose",
    title: `Redline for ${vendor} MSA — ${drafts.length} clause(s)`,
    preview: { format: "markdown", body },
    expires_in: 172800, // 48h — legal review window
    editable: ["preview.body"],
  });

  return action.id;
}

async function sendApprovedTermsToVendor(actionId: string) {
  let action;
  try {
    action = await impri.awaitDecision(actionId, { timeoutS: 172800 });
  } catch (e) {
    if (e instanceof ImpriRejected || e instanceof ImpriExpired) {
      console.log(`Terms not sent — legal did not approve this redline`);
      return;
    }
    throw e;
  }

  const finalTerms = action.decision!.final_preview!.body; // carries legal's edits, if any
  // await vendorPortal.sendCounterProposal(finalTerms); — your actual send call

  await impri.reportResult(actionId, "executed", {
    detail: `Sent at ${new Date().toISOString()}`,
  });
}
```

If legal only tweaks one clause's wording, `decision.diff` isolates that change instead of legal having to re-read the entire redline to figure out what moved. (The REST API also accepts `idempotent` and `undo` hints on the action body — e.g. `idempotent: false` and a plain-English undo note for a signed amendment — but the TypeScript SDK's `createAction` doesn't expose those params yet; send them via a direct `POST /v1/actions` call if you need them today.)

---

## Reading the diff as a paper trail

`decision.diff` is present whenever the approved content differs from what the agent proposed. For contract terms specifically, this is worth keeping as its own artifact — a compliance reviewer six months later asking "did we actually agree to this exact liability cap, or did the AI draft something slightly different" is answered by the diff, not by re-reading the whole contract history. Combined with the underlying record Impri keeps of who approved what and when (see [audit log](audit-log.md)), this closes the loop: proposal, human edit, human approval, all timestamped.

---

## Where Impri's responsibility ends

Impri does not understand contract law, does not check whether a redline is enforceable, and does not diff against the vendor's actual signed counter-copy — it only holds the human decision on the text the agent proposed to send. The agent (or a person) is still responsible for verifying the final signed document matches what was approved here. And as with any Impri integration, the guarantee only holds if the vendor-portal send call is wrapped so it's unreachable without `decision.status === "approved"` — see [the MCP integration guide](how-to-add-human-approval-to-an-ai-agent.md) for that pattern, and [the TypeScript SDK reference](sdk-typescript.md) for the full client API.

Next step: [quickstart](quickstart.md) to get an API key if you're setting this up for the first time.
