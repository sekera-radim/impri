import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImpriClient } from "../src/client.js";
import {
  ImpriConflict,
  ImpriExpired,
  ImpriNotFound,
  ImpriRateLimited,
  ImpriRejected,
  ImpriTimeout,
  ImpriUnauthorized,
  ImpriValidationError,
} from "../src/errors.js";

// ─── Fetch mock helpers ───────────────────────────────────────────────────────

function mockOk(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mockErr(status: number, body: Record<string, unknown> = {}, headers?: Headers): Response {
  return {
    ok: false,
    status,
    statusText: "Error",
    headers: headers ?? new Headers(),
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

// ─── Client construction ──────────────────────────────────────────────────────

describe("ImpriClient constructor", () => {
  it("uses apiKey from constructor arg", () => {
    const client = new ImpriClient({ apiKey: "im_test" });
    expect(client).toBeDefined();
  });

  it("falls back to IMPRI_API_KEY env var", () => {
    vi.stubEnv("IMPRI_API_KEY", "im_from_env");
    const client = new ImpriClient();
    expect(client).toBeDefined();
    vi.unstubAllEnvs();
  });

  it("strips trailing slash from baseUrl", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({ id: "act_x", status: "pending", inbox_url: "", expires_at: 0, created_at: 0 }, 201),
    );
    const client = new ImpriClient({ apiKey: "im_test", baseUrl: "http://localhost:8484/" });
    await client.createAction({
      kind: "test",
      title: "T",
      preview: { format: "plain", body: "b" },
    });
    const [url] = mockFetch.mock.calls[0]!;
    // Must not have double slash before /v1
    expect(url as string).toBe("http://localhost:8484/v1/actions");
  });

  it("throws ImpriConfigError when no API key is available", () => {
    vi.stubEnv("IMPRI_API_KEY", "");
    expect(() => new ImpriClient()).toThrow("IMPRI_API_KEY is not set");
    vi.unstubAllEnvs();
  });
});

// ─── createAction ─────────────────────────────────────────────────────────────

describe("createAction", () => {
  it("POSTs to /v1/actions with Authorization header and returns ActionCreated", async () => {
    const created = {
      id: "act_001",
      status: "pending" as const,
      inbox_url: "https://impri.dev/inbox/act_001",
      expires_at: 1720086400,
      created_at: 1720000000,
    };
    mockFetch.mockResolvedValueOnce(mockOk(created, 201));

    const client = new ImpriClient({ apiKey: "im_abc", baseUrl: "http://localhost:8484" });
    const result = await client.createAction({
      kind: "email.send",
      title: "Send welcome email to Alice",
      preview: { format: "plain", body: "Hello Alice!" },
      editable: ["preview.body"],
    });

    expect(result.id).toBe("act_001");
    expect(result.status).toBe("pending");
    expect(result.inbox_url).toContain("act_001");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:8484/v1/actions");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer im_abc",
      "Content-Type": "application/json",
    });
  });

  it("surfaces ImpriUnauthorized on 401", async () => {
    mockFetch.mockResolvedValueOnce(mockErr(401, { message: "Invalid API key" }));
    const client = new ImpriClient({ apiKey: "im_bad" });
    await expect(
      client.createAction({ kind: "x", title: "x", preview: { format: "plain", body: "x" } }),
    ).rejects.toBeInstanceOf(ImpriUnauthorized);
  });

  it("surfaces ImpriValidationError on 422", async () => {
    mockFetch.mockResolvedValueOnce(
      mockErr(422, { message: "Validation error", issues: [{ path: ["kind"], message: "Required" }] }),
    );
    const client = new ImpriClient({ apiKey: "im_test" });
    await expect(
      client.createAction({ kind: "", title: "T", preview: { format: "plain", body: "b" } }),
    ).rejects.toBeInstanceOf(ImpriValidationError);
  });

  it("surfaces ImpriRateLimited on 429 and carries retryAfter", async () => {
    const headers = new Headers({ "Retry-After": "30" });
    mockFetch.mockResolvedValueOnce(mockErr(429, { message: "Too many requests" }, headers));
    const client = new ImpriClient({ apiKey: "im_test" });
    let err: unknown;
    try {
      await client.createAction({ kind: "x", title: "x", preview: { format: "plain", body: "x" } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ImpriRateLimited);
    expect((err as ImpriRateLimited).retryAfter).toBe(30);
  });
});

// ─── getAction ────────────────────────────────────────────────────────────────

describe("getAction", () => {
  it("GETs /v1/actions/:id", async () => {
    const action = {
      id: "act_002",
      kind: "email.send",
      title: "Welcome email",
      status: "pending" as const,
      preview: { format: "plain", body: "Hello!" },
      editable: [],
      expires_at: 1720086400,
      created_at: 1720000000,
      updated_at: 1720000000,
    };
    mockFetch.mockResolvedValueOnce(mockOk(action));

    const client = new ImpriClient({ apiKey: "im_test" });
    const result = await client.getAction("act_002");

    expect(result.id).toBe("act_002");
    const [url] = mockFetch.mock.calls[0]!;
    expect(url as string).toContain("/v1/actions/act_002");
  });

  it("surfaces ImpriNotFound on 404", async () => {
    mockFetch.mockResolvedValueOnce(mockErr(404, { message: "Not found" }));
    const client = new ImpriClient({ apiKey: "im_test" });
    await expect(client.getAction("act_nonexistent")).rejects.toBeInstanceOf(ImpriNotFound);
  });
});

// ─── awaitDecision ────────────────────────────────────────────────────────────

describe("awaitDecision", () => {
  it("returns immediately when action is already approved", async () => {
    const action = {
      id: "act_003",
      kind: "email.send",
      title: "T",
      status: "approved",
      preview: { format: "plain", body: "Original" },
      payload: {},
      editable: ["preview.body"],
      expires_at: 9999999999,
      created_at: 1720000000,
      updated_at: 1720000000,
      decision: {
        verdict: "approve",
        decided_at: 1720003600,
        final_preview: { format: "plain", body: "Original" },
      },
    };
    mockFetch.mockResolvedValueOnce(mockOk(action));

    const client = new ImpriClient({ apiKey: "im_test" });
    const result = await client.awaitDecision("act_003", { pollIntervalMs: 0 });

    expect(result.actionId).toBe("act_003");
    expect(result.finalPreview.body).toBe("Original");
    expect(result.isUntrusted).toBe(false);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("surfaces human-edited finalPreview when reviewer changed body", async () => {
    const action = {
      id: "act_004",
      kind: "email.send",
      title: "T",
      status: "approved",
      preview: { format: "plain", body: "Draft" },
      payload: {},
      editable: ["preview.body"],
      expires_at: 9999999999,
      created_at: 1720000000,
      updated_at: 1720000000,
      decision: {
        verdict: "approve",
        decided_at: 1720003600,
        final_preview: { format: "plain", body: "Human-edited text" },
        diff: "--- original\n+++ edited",
      },
    };
    mockFetch.mockResolvedValueOnce(mockOk(action));

    const client = new ImpriClient({ apiKey: "im_test" });
    const result = await client.awaitDecision("act_004", { pollIntervalMs: 0 });

    // CRITICAL: must carry the human-edited text, not the original draft.
    expect(result.finalPreview.body).toBe("Human-edited text");
    expect(result.finalPreview.body).not.toBe("Draft");
  });

  it("polls pending → approved with two fetches", async () => {
    const pending = {
      id: "act_005",
      kind: "email.send",
      title: "T",
      status: "pending",
      preview: { format: "plain", body: "B" },
      editable: [],
      expires_at: 9999999999,
      created_at: 1720000000,
      updated_at: 1720000000,
    };
    const approved = {
      ...pending,
      status: "approved",
      decision: {
        verdict: "approve",
        decided_at: 1720003600,
        final_preview: { format: "plain", body: "B" },
      },
    };

    mockFetch
      .mockResolvedValueOnce(mockOk(pending))
      .mockResolvedValueOnce(mockOk(approved));

    const client = new ImpriClient({ apiKey: "im_test" });
    const result = await client.awaitDecision("act_005", { pollIntervalMs: 0, timeoutS: 60 });

    expect(result.actionId).toBe("act_005");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws ImpriTimeout when deadline expires with action still pending", async () => {
    const pending = {
      id: "act_006",
      status: "pending",
      preview: { format: "plain", body: "B" },
      editable: [],
      expires_at: 9999999999,
    };
    mockFetch.mockResolvedValue(mockOk(pending));

    const client = new ImpriClient({ apiKey: "im_test" });
    await expect(
      client.awaitDecision("act_006", { timeoutS: 0, pollIntervalMs: 0 }),
    ).rejects.toBeInstanceOf(ImpriTimeout);
  });

  it("throws ImpriRejected when human rejects", async () => {
    const action = {
      id: "act_007",
      status: "rejected",
      preview: { format: "plain", body: "B" },
      editable: [],
      expires_at: 9999999999,
      created_at: 1720000000,
      updated_at: 1720000000,
      decision: { verdict: "reject", decided_at: 1720003600 },
    };
    mockFetch.mockResolvedValueOnce(mockOk(action));

    const client = new ImpriClient({ apiKey: "im_test" });
    const err = await client.awaitDecision("act_007", { pollIntervalMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(ImpriRejected);
    expect((err as ImpriRejected).actionId).toBe("act_007");
  });

  it("throws ImpriExpired when status is expired", async () => {
    const action = {
      id: "act_008",
      status: "expired",
      preview: { format: "plain", body: "B" },
      editable: [],
      expires_at: 1700000000, // past
      created_at: 1699999900,
      updated_at: 1700000000,
    };
    mockFetch.mockResolvedValueOnce(mockOk(action));

    const client = new ImpriClient({ apiKey: "im_test" });
    await expect(
      client.awaitDecision("act_008", { pollIntervalMs: 0 }),
    ).rejects.toBeInstanceOf(ImpriExpired);
  });

  it("flags isUntrusted when payload.untrusted is true", async () => {
    const action = {
      id: "act_009",
      kind: "watcher.triage",
      title: "New Reddit post",
      status: "approved",
      preview: { format: "plain", body: "Content from Reddit" },
      payload: { untrusted: true, url: "https://reddit.com/r/..." },
      editable: [],
      expires_at: 9999999999,
      created_at: 1720000000,
      updated_at: 1720000000,
      decision: {
        verdict: "approve",
        decided_at: 1720003600,
        final_preview: { format: "plain", body: "Content from Reddit" },
      },
    };
    mockFetch.mockResolvedValueOnce(mockOk(action));

    const client = new ImpriClient({ apiKey: "im_test" });
    const result = await client.awaitDecision("act_009", { pollIntervalMs: 0 });
    expect(result.isUntrusted).toBe(true);
  });
});

// ─── reportResult ─────────────────────────────────────────────────────────────

describe("reportResult", () => {
  it("POSTs /v1/actions/:id/result with status and detail", async () => {
    const ack = { id: "act_010", status: "executed", updated_at: 1720010000 };
    mockFetch.mockResolvedValueOnce(mockOk(ack));

    const client = new ImpriClient({ apiKey: "im_test" });
    const result = await client.reportResult("act_010", {
      status: "executed",
      detail: "Sent successfully",
    });

    expect(result.status).toBe("executed");
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url as string).toContain("/v1/actions/act_010/result");
    expect((init as RequestInit).method).toBe("POST");

    const body = JSON.parse((init as RequestInit).body as string) as {
      status: string;
      detail: string;
    };
    expect(body.status).toBe("executed");
    expect(body.detail).toBe("Sent successfully");
  });

  it("surfaces ImpriConflict on 409", async () => {
    mockFetch.mockResolvedValueOnce(mockErr(409, { message: "Action not in approved state" }));
    const client = new ImpriClient({ apiKey: "im_test" });
    await expect(
      client.reportResult("act_011", { status: "executed" }),
    ).rejects.toBeInstanceOf(ImpriConflict);
  });
});

// ─── requiresApproval HOF ─────────────────────────────────────────────────────

describe("requiresApproval", () => {
  it("submits action, waits for approval, calls fn, reports executed", async () => {
    const createdAction = {
      id: "act_hof_1",
      status: "pending",
      inbox_url: "https://impri.dev/inbox/act_hof_1",
      expires_at: 9999999999,
      created_at: 1720000000,
    };
    const approvedAction = {
      id: "act_hof_1",
      kind: "email.send",
      title: "Send email",
      status: "approved",
      preview: { format: "plain", body: "Hello Alice!" },
      payload: {},
      editable: ["preview.body"],
      expires_at: 9999999999,
      created_at: 1720000000,
      updated_at: 1720000000,
      decision: {
        verdict: "approve",
        decided_at: 1720003600,
        final_preview: { format: "plain", body: "Hello Alice!" },
      },
    };
    const resultAck = { id: "act_hof_1", status: "executed", updated_at: 1720004000 };

    mockFetch
      .mockResolvedValueOnce(mockOk(createdAction, 201)) // createAction
      .mockResolvedValueOnce(mockOk(approvedAction))     // getAction (awaitDecision)
      .mockResolvedValueOnce(mockOk(resultAck));          // reportResult

    const fnCalls: { to: string; body: string }[] = [];
    const fn = async (to: string, body: string) => {
      fnCalls.push({ to, body });
      return `sent to ${to}`;
    };

    const client = new ImpriClient({ apiKey: "im_test" });
    const wrapped = client.requiresApproval(fn, {
      kind: "email.send",
      title: (to: string) => `Send email to ${to}`,
      preview: (_to: string, body: string) => ({ format: "plain" as const, body }),
      editable: ["preview.body"],
    });

    const result = await wrapped("alice@example.com", "Hello Alice!");

    expect(result).toBe("sent to alice@example.com");
    expect(fnCalls).toHaveLength(1);
    expect(fnCalls[0]).toEqual({ to: "alice@example.com", body: "Hello Alice!" });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("injects human-edited body into second positional arg", async () => {
    const created = {
      id: "act_hof_2",
      status: "pending",
      inbox_url: "",
      expires_at: 9999999999,
      created_at: 0,
    };
    const approved = {
      id: "act_hof_2",
      kind: "email.send",
      title: "T",
      status: "approved",
      preview: { format: "plain", body: "Original body" },
      payload: {},
      editable: ["preview.body"],
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
    const ack = { id: "act_hof_2", status: "executed", updated_at: 0 };

    mockFetch
      .mockResolvedValueOnce(mockOk(created, 201))
      .mockResolvedValueOnce(mockOk(approved))
      .mockResolvedValueOnce(mockOk(ack));

    const receivedBodies: string[] = [];
    const fn = async (_to: string, body: string) => {
      receivedBodies.push(body);
    };

    const client = new ImpriClient({ apiKey: "im_test" });
    const wrapped = client.requiresApproval(fn, {
      kind: "email.send",
      title: "T",
      preview: (_to: string, body: string) => ({ format: "plain" as const, body }),
      editable: ["preview.body"],
    });

    await wrapped("bob@example.com", "Original body");

    // The edited body must be injected, not the original.
    expect(receivedBodies[0]).toBe("Human-edited body");
  });

  it("throws ImpriRejected when human rejects, does NOT call fn", async () => {
    const created = {
      id: "act_hof_3",
      status: "pending",
      inbox_url: "",
      expires_at: 9999999999,
      created_at: 0,
    };
    const rejectedAction = {
      id: "act_hof_3",
      kind: "email.send",
      title: "T",
      status: "rejected",
      preview: { format: "plain", body: "Body" },
      editable: [],
      expires_at: 9999999999,
      created_at: 0,
      updated_at: 0,
      decision: { verdict: "reject", decided_at: 0 },
    };

    mockFetch
      .mockResolvedValueOnce(mockOk(created, 201))
      .mockResolvedValueOnce(mockOk(rejectedAction));

    const fnCalled = vi.fn();
    const fn = async () => {
      fnCalled();
    };

    const client = new ImpriClient({ apiKey: "im_test" });
    const wrapped = client.requiresApproval(fn, { kind: "x", title: "T" });

    await expect(wrapped()).rejects.toBeInstanceOf(ImpriRejected);
    expect(fnCalled).not.toHaveBeenCalled();
  });

  it("calls reportResult with execute_failed when fn throws", async () => {
    const created = { id: "act_hof_4", status: "pending", inbox_url: "", expires_at: 9999999999, created_at: 0 };
    const approved = {
      id: "act_hof_4",
      kind: "x",
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
    const ack = { id: "act_hof_4", status: "execute_failed", updated_at: 0 };

    mockFetch
      .mockResolvedValueOnce(mockOk(created, 201))
      .mockResolvedValueOnce(mockOk(approved))
      .mockResolvedValueOnce(mockOk(ack));

    const client = new ImpriClient({ apiKey: "im_test" });
    const wrapped = client.requiresApproval(
      async () => { throw new Error("downstream failure"); },
      { kind: "x", title: "T" },
    );

    await expect(wrapped()).rejects.toThrow("downstream failure");

    // Third fetch must be the reportResult call with execute_failed.
    const [, , thirdCall] = mockFetch.mock.calls;
    expect(thirdCall).toBeDefined();
    const [resultUrl, resultInit] = thirdCall!;
    expect(resultUrl as string).toContain("/result");
    const body = JSON.parse((resultInit as RequestInit).body as string) as { status: string; detail: string };
    expect(body.status).toBe("execute_failed");
    expect(body.detail).toBe("downstream failure");
  });
});

// ─── approvalGate ─────────────────────────────────────────────────────────────

describe("approvalGate", () => {
  it("creates action and returns ApprovedAction on approval", async () => {
    const created = { id: "act_gate_1", status: "pending", inbox_url: "", expires_at: 9999999999, created_at: 0 };
    const approved = {
      id: "act_gate_1",
      kind: "db.exec",
      title: "DROP TABLE users",
      status: "approved",
      preview: { format: "plain", body: "DROP TABLE users;" },
      editable: ["preview.body"],
      payload: {},
      expires_at: 9999999999,
      created_at: 0,
      updated_at: 0,
      decision: {
        verdict: "approve",
        decided_at: 0,
        final_preview: { format: "plain", body: "DROP TABLE users;" },
      },
    };

    mockFetch
      .mockResolvedValueOnce(mockOk(created, 201))
      .mockResolvedValueOnce(mockOk(approved));

    const client = new ImpriClient({ apiKey: "im_test" });
    const result = await client.approvalGate({
      kind: "db.exec",
      title: "DROP TABLE users",
      preview: { format: "plain", body: "DROP TABLE users;" },
      editable: ["preview.body"],
    });

    expect(result.actionId).toBe("act_gate_1");
    expect(result.finalPreview.body).toBe("DROP TABLE users;");
  });
});
