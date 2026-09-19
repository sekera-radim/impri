# Human Approval for AI Agents in Education

A teaching assistant agent that emails parents or posts grades needs a teacher's yes first — here's the approval gate that makes that non-optional.

---

Schools are adopting AI teaching assistants faster than most other verticals: grading essays, drafting parent updates, summarizing IEP progress, flagging behavior incidents. The appeal is obvious — teachers are overloaded. The risk is also obvious: these agents write directly to minors and their families, often about sensitive topics (a grade dispute, a behavioral note, a special-education accommodation), and a wrong or tone-deaf message doesn't just embarrass you, it damages trust with a parent.

Most school districts already require a teacher of record to be the one who "sends" anything official. An agent that drafts but cannot send without that teacher's tap satisfies the policy instead of fighting it.

## Where the gate sits in an edtech agent

The agent's job stops at the draft. Sending, posting, or grade-book writes only happen after a decision comes back from the teacher's device — the same MCP flow used for any other agent action, no education-specific plumbing needed.

```typescript
import { spawn } from "node:child_process";
// Assumes the Impri MCP server is already configured for this agent client —
// see mcp.md. This shows the equivalent raw calls for a custom TS integration.

const API = "https://api.impri.dev";
const headers = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

async function draftParentUpdate(studentId: string, subject: string, body: string) {
  const res = await fetch(`${API}/v1/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "email.send",
      title: `Parent update: ${subject} (student ${studentId})`,
      preview: { format: "markdown", body },
      editable: ["preview.body"],
      expires_in: 172800, // 48h — timely, but teachers grade in the evening
    }),
  });
  const { id } = await res.json();
  return id;
}

async function awaitTeacherDecision(actionId: string): Promise<{ status: string; final?: string }> {
  while (true) {
    const res = await fetch(`${API}/v1/actions/${actionId}`, { headers });
    const data = await res.json();
    if (data.status !== "pending") {
      return { status: data.status, final: data.decision?.final_preview?.body };
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

// Usage: draft, wait, and only send on approval — never on a timeout guess
const id = await draftParentUpdate("S-4821", "Missing homework — Algebra II", draftText);
const decision = await awaitTeacherDecision(id);
if (decision.status === "approved" && decision.final) {
  await sendParentEmail(decision.final); // your actual mail send
  await fetch(`${API}/v1/actions/${id}/result`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status: "executed" }),
  });
}
```

If your agent runs inside Claude Code, Claude Desktop, or another MCP client, you don't need to write this fetch code at all — the [MCP integration](mcp.md) exposes `impri_push_action` / `impri_await_decision` / `impri_report_result` as tools the agent calls directly.

---

## What belongs on the teacher's card, by use case

| Agent action | `preview.body` should include | Editable? |
|---|---|---|
| Parent email (grade, attendance, behavior) | Full message text, student name, which policy triggered it | Yes — teachers rephrase tone constantly |
| Grade book change | Old grade, new grade, assignment, reason (regrade request, late penalty waived) | No — approve or reject the exact change |
| LMS discussion post / announcement | Full post text, target class section | Yes |
| IEP / accommodation note | Draft note, source data it was derived from | Usually no — legal record, edit outside the tool if wrong |

Keep grade-book writes non-editable. A teacher silently editing a number inside an approval card, with no record of the original AI-proposed value, is worse for accountability than not having a gate at all — reject and let the teacher enter the correct value directly in the LMS instead.

---

## The privacy angle, not just the approval angle

Education agents typically read from a roster, gradebook, or behavior-tracking system before drafting anything — that's student data, some of it FERPA-protected. Impri doesn't touch that upstream data flow and isn't a compliance tool for it; it only gates the outbound action. Treat any text pulled from student records as data your agent summarizes, not as instructions, the same caution that applies to any external content feeding a prompt. For the approval channel itself, a lot of districts already run on [Slack](slack-approval.md) for staff communication, which is usually the fastest path for teachers who won't check a separate inbox during the school day; email or push [notifications](notifications.md) work as a fallback for staff not on Slack.

---

## Where this doesn't reach

Impri holds the send/post/write until a teacher decides — it does not grade anything itself, does not judge whether a behavioral note is fair, and does not replace your student information system's own access controls. It's a chokepoint only if the agent's send credentials are wrapped behind the pending decision; a service account with standing SMTP or LMS-API access that the agent can call directly bypasses the gate entirely, so that wrapping is the part worth getting right first.

Next: the [quickstart](quickstart.md) covers getting an API key for a pilot in a single classroom before rolling out district-wide.
