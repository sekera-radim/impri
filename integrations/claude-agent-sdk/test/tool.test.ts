import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImpriClient } from "../src/client.js";
import { ImpriRejected } from "../src/errors.js";
import type { ToolUseBlock } from "../src/tool.js";
import { makeToolResult, withImpriApproval } from "../src/tool.js";

// ─── Fetch mock helpers ───────────────────────────────────────────────────────

function mockOk(body: unknown, status = 200): Response {
  return {
    ok: true,
    status,
    statusText: "OK",
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mockErr(status: number, body: Record<string, unknown> = {}): Response {
  return {
    ok: false,
    status,
    statusText: "Error",
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const sendEmailTool = {
  name: "send_email",
  description: "Send an email",
  input_schema: {
    type: "object" as const,
    properties: {
      to: { type: "string" },
      body: { type: "string" },
    },
    required: ["to", "body"],
  },
};

function makeBlock(input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: "tool_use", id: "tool_use_abc", name: "send_email", input };
}

function makeMockSequence(verdict: "approve" | "reject"): void {
  const created = { id: "act_t1", status: "pending", inbox_url: "", expires_at: 9999999999, created_at: 0 };
  const actionAfterDecision = {
    id: "act_t1",
    kind: "email.send",
    title: "Send email to alice@example.com",
    status: verdict === "approve" ? "approved" : "rejected",
    preview: { format: "plain", body: "Hello Alice!" },
    editable: ["preview.body"],
    payload: { tool_use_id: "tool_use_abc", tool_name: "send_email", input: {} },
    expires_at: 9999999999,
    created_at: 0,
    updated_at: 0,
    decision: {
      verdict,
      decided_at: 0,
      final_preview: { format: "plain", body: "Hello Alice!" },
    },
  };
  const ack = { id: "act_t1", status: verdict === "approve" ? "executed" : "execute_failed", updated_at: 0 };

  mockFetch
    .mockResolvedValueOnce(mockOk(created, 201))
    .mockResolvedValueOnce(mockOk(actionAfterDecision));

  if (verdict === "approve") {
    mockFetch.mockResolvedValueOnce(mockOk(ack));
  }
}

// ─── withImpriApproval ────────────────────────────────────────────────────────

describe("withImpriApproval", () => {
  it("returns toolDef unchanged", () => {
    const client = new ImpriClient({ apiKey: "im_test" });
    const gated = withImpriApproval({
      toolDef: sendEmailTool,
      execute: async () => "ok",
      impriClient: client,
      kind: "email.send",
      title: "Send email",
    });
    expect(gated.toolDef).toBe(sendEmailTool);
  });

  it("submits action, waits for approval, calls execute, returns string result", async () => {
    makeMockSequence("approve");

    const client = new ImpriClient({ apiKey: "im_test" });
    const executeCalls: Record<string, unknown>[] = [];

    const gated = withImpriApproval({
      toolDef: sendEmailTool,
      execute: async (input) => {
        executeCalls.push(input);
        return `Email sent to ${input["to"] as string}`;
      },
      impriClient: client,
      kind: "email.send",
      title: ({ to }) => `Send email to ${to as string}`,
      preview: ({ body }) => ({ format: "plain" as const, body: String(body) }),
      editable: ["preview.body"],
    });

    const result = await gated.handle(makeBlock({ to: "alice@example.com", body: "Hello Alice!" }));

    expect(result).toBe("Email sent to alice@example.com");
    expect(executeCalls).toHaveLength(1);
    // Three fetches: createAction, getAction, reportResult
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("includes tool_use_id and input in the Impri action payload", async () => {
    makeMockSequence("approve");

    const client = new ImpriClient({ apiKey: "im_test" });
    const gated = withImpriApproval({
      toolDef: sendEmailTool,
      execute: async () => "ok",
      impriClient: client,
      kind: "email.send",
      title: "Send email",
    });

    await gated.handle(makeBlock({ to: "alice@example.com", body: "Hello!" }));

    const [, createInit] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((createInit as RequestInit).body as string) as {
      payload: { tool_use_id: string; tool_name: string; input: unknown };
    };
    expect(body.payload.tool_use_id).toBe("tool_use_abc");
    expect(body.payload.tool_name).toBe("send_email");
    expect(body.payload.input).toMatchObject({ to: "alice@example.com" });
  });

  it("returns rejection message string when human rejects (does not throw by default)", async () => {
    makeMockSequence("reject");

    const client = new ImpriClient({ apiKey: "im_test" });
    const executeCalled = vi.fn();

    const gated = withImpriApproval({
      toolDef: sendEmailTool,
      execute: async () => {
        executeCalled();
        return "should not run";
      },
      impriClient: client,
      kind: "email.send",
      title: "Send email",
    });

    const result = await gated.handle(makeBlock({ to: "alice@example.com", body: "Hello!" }));

    expect(result).toMatch(/rejected/i);
    expect(result).toContain("act_t1");
    expect(executeCalled).not.toHaveBeenCalled();
  });

  it("uses custom onRejected handler when provided", async () => {
    makeMockSequence("reject");

    const client = new ImpriClient({ apiKey: "im_test" });
    const gated = withImpriApproval({
      toolDef: sendEmailTool,
      execute: async () => "ok",
      impriClient: client,
      kind: "email.send",
      title: "Send email",
      onRejected: (err) => `Custom rejection: ${err.actionId}`,
    });

    const result = await gated.handle(makeBlock({ to: "alice@example.com" }));
    expect(result).toBe("Custom rejection: act_t1");
  });

  it("defaults preview to JSON of input when preview option is omitted", async () => {
    makeMockSequence("approve");

    const client = new ImpriClient({ apiKey: "im_test" });
    const gated = withImpriApproval({
      toolDef: sendEmailTool,
      execute: async () => "ok",
      impriClient: client,
      kind: "email.send",
      title: "Send email",
    });

    await gated.handle(makeBlock({ to: "alice@example.com", body: "Hello!" }));

    const [, createInit] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((createInit as RequestInit).body as string) as {
      preview: { format: string; body: string };
    };
    expect(body.preview.format).toBe("plain");
    // The body should be JSON-stringified input
    expect(body.preview.body).toContain("alice@example.com");
  });

  it("injects human-edited body into input when execute has body key", async () => {
    const created = { id: "act_t2", status: "pending", inbox_url: "", expires_at: 9999999999, created_at: 0 };
    const approved = {
      id: "act_t2",
      kind: "email.send",
      title: "T",
      status: "approved",
      preview: { format: "plain", body: "Original body" },
      editable: ["preview.body"],
      payload: { tool_use_id: "tool_use_abc", tool_name: "send_email", input: {} },
      expires_at: 9999999999,
      created_at: 0,
      updated_at: 0,
      decision: {
        verdict: "approve",
        decided_at: 0,
        final_preview: { format: "plain", body: "Human-edited body" },
        diff: "--- \n+++ ",
      },
    };
    const ack = { id: "act_t2", status: "executed", updated_at: 0 };

    mockFetch
      .mockResolvedValueOnce(mockOk(created, 201))
      .mockResolvedValueOnce(mockOk(approved))
      .mockResolvedValueOnce(mockOk(ack));

    const client = new ImpriClient({ apiKey: "im_test" });
    const receivedInputs: Record<string, unknown>[] = [];

    const gated = withImpriApproval({
      toolDef: sendEmailTool,
      execute: async (input) => {
        receivedInputs.push(input);
        return "ok";
      },
      impriClient: client,
      kind: "email.send",
      title: "T",
      preview: ({ body }) => ({ format: "plain" as const, body: String(body) }),
      editable: ["preview.body"],
    });

    await gated.handle(makeBlock({ to: "alice@example.com", body: "Original body" }));

    // Must inject the human-edited body.
    expect(receivedInputs[0]?.["body"]).toBe("Human-edited body");
    expect(receivedInputs[0]?.["body"]).not.toBe("Original body");
  });

  it("serialises non-string execute result to JSON string", async () => {
    makeMockSequence("approve");

    const client = new ImpriClient({ apiKey: "im_test" });
    const gated = withImpriApproval({
      toolDef: sendEmailTool,
      execute: async () => ({ sent: true, recipients: 1 }),
      impriClient: client,
      kind: "email.send",
      title: "Send email",
    });

    const result = await gated.handle(makeBlock({ to: "alice@example.com" }));
    const parsed = JSON.parse(result) as { sent: boolean; recipients: number };
    expect(parsed.sent).toBe(true);
    expect(parsed.recipients).toBe(1);
  });

  it("surfaces ImpriTimeout when approval polling times out", async () => {
    const created = { id: "act_t3", status: "pending", inbox_url: "", expires_at: 9999999999, created_at: 0 };
    const pending = {
      id: "act_t3",
      kind: "email.send",
      title: "T",
      status: "pending",
      preview: { format: "plain", body: "B" },
      editable: [],
      expires_at: 9999999999,
      created_at: 0,
      updated_at: 0,
    };

    mockFetch
      .mockResolvedValueOnce(mockOk(created, 201))
      .mockResolvedValueOnce(mockOk(pending));

    const client = new ImpriClient({ apiKey: "im_test" });
    const gated = withImpriApproval({
      toolDef: sendEmailTool,
      execute: async () => "ok",
      impriClient: client,
      kind: "email.send",
      title: "T",
      timeoutS: 0,
    });

    await expect(gated.handle(makeBlock({ to: "alice@example.com" }))).rejects.toThrow(
      /timed out/i,
    );
  });

  it("reports execute_failed and rethrows when execute throws", async () => {
    const created = { id: "act_t4", status: "pending", inbox_url: "", expires_at: 9999999999, created_at: 0 };
    const approved = {
      id: "act_t4",
      kind: "email.send",
      title: "T",
      status: "approved",
      preview: { format: "plain", body: "B" },
      editable: [],
      payload: {},
      expires_at: 9999999999,
      created_at: 0,
      updated_at: 0,
      decision: { verdict: "approve", decided_at: 0, final_preview: { format: "plain", body: "B" } },
    };
    const ack = { id: "act_t4", status: "execute_failed", updated_at: 0 };

    mockFetch
      .mockResolvedValueOnce(mockOk(created, 201))
      .mockResolvedValueOnce(mockOk(approved))
      .mockResolvedValueOnce(mockOk(ack));

    const client = new ImpriClient({ apiKey: "im_test" });
    const gated = withImpriApproval({
      toolDef: sendEmailTool,
      execute: async () => { throw new Error("SMTP unavailable"); },
      impriClient: client,
      kind: "email.send",
      title: "T",
    });

    await expect(gated.handle(makeBlock({ to: "alice@example.com" }))).rejects.toThrow(
      "SMTP unavailable",
    );

    // The third fetch must be reportResult with execute_failed.
    const [, , thirdCall] = mockFetch.mock.calls;
    const [resultUrl, resultInit] = thirdCall!;
    expect(resultUrl as string).toContain("/result");
    const body = JSON.parse((resultInit as RequestInit).body as string) as {
      status: string;
      detail: string;
    };
    expect(body.status).toBe("execute_failed");
    expect(body.detail).toBe("SMTP unavailable");
  });
});

// ─── makeToolResult ───────────────────────────────────────────────────────────

describe("makeToolResult", () => {
  it("builds a tool_result block param", () => {
    const block = makeToolResult("tool_use_abc", "Email sent successfully");
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("tool_use_abc");
    expect(block.content).toBe("Email sent successfully");
    expect(block.is_error).toBeUndefined();
  });

  it("includes is_error when requested", () => {
    const block = makeToolResult("tool_use_abc", "Error: SMTP failed", true);
    expect(block.is_error).toBe(true);
  });
});
