import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignoffConfig } from "../src/client.js";
import {
  awaitDecision,
  createWatcher,
  inboxStatus,
  listWatchers,
  pushAction,
  reportResult,
} from "../src/tools.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const config: SignoffConfig = {
  apiKey: "so_test_key_123",
  baseUrl: "http://localhost:8484",
};

function mockOk(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mockErr(status: number, body: { message?: string } = {}): Response {
  return {
    ok: false,
    status,
    statusText: "Error",
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

// ─── pushAction ───────────────────────────────────────────────────────────────

describe("pushAction", () => {
  it("creates an action and returns id, status, inbox_url", async () => {
    mockFetch.mockResolvedValue(
      mockOk(
        { id: "act_001", status: "pending", inbox_url: "https://signoff.dev/inbox/act_001" },
        201,
      ),
    );

    const result = await pushAction(config, {
      kind: "reddit.comment",
      title: "Reply: Why is resume advice so conflicting?",
      preview: { format: "markdown", body: "The advice conflicts because..." },
    });

    const parsed = JSON.parse(result) as { action_id: string; status: string; inbox_url: string };
    expect(parsed.action_id).toBe("act_001");
    expect(parsed.status).toBe("pending");
    expect(parsed.inbox_url).toContain("act_001");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:8484/v1/actions");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer so_test_key_123" }),
    );
  });
});

// ─── awaitDecision ────────────────────────────────────────────────────────────

describe("awaitDecision", () => {
  it("returns immediately when action is already approved", async () => {
    mockFetch.mockResolvedValue(
      mockOk({
        id: "act_002",
        kind: "reddit.comment",
        title: "Reply: Test",
        status: "approved",
        inbox_url: "https://signoff.dev/inbox/act_002",
        decision_at: "2026-07-10T08:00:00Z",
        preview: { format: "markdown", body: "Approved body" },
        payload: { post_id: "abc123" },
      }),
    );

    const result = await awaitDecision(config, { action_id: "act_002" }, 0);

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.text) as { action_id: string; status: string };
    expect(parsed.action_id).toBe("act_002");
    expect(parsed.status).toBe("approved");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("polls pending → approved transition with two fetches", async () => {
    const pending = {
      id: "act_003",
      kind: "blog.post",
      title: "Draft: Lessons from building Signoff",
      status: "pending",
      inbox_url: "https://signoff.dev/inbox/act_003",
    };
    const approved = { ...pending, status: "approved", decision_at: "2026-07-10T08:01:00Z" };

    mockFetch
      .mockResolvedValueOnce(mockOk(pending))
      .mockResolvedValueOnce(mockOk(approved));

    const result = await awaitDecision(config, { action_id: "act_003", timeout_s: 60 }, 0);

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.text) as { status: string };
    expect(parsed.status).toBe("approved");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns isError and timeout message when deadline is exceeded", async () => {
    // timeout_s = 0 means deadline = now, so after the first poll we exit
    mockFetch.mockResolvedValue(
      mockOk({ id: "act_004", status: "pending", inbox_url: "https://signoff.dev/inbox/act_004" }),
    );

    const result = await awaitDecision(config, { action_id: "act_004", timeout_s: 0 }, 0);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/timed out/i);
    expect(result.text).toContain("act_004");
  });

  it("returns rejected decision without isError flag", async () => {
    mockFetch.mockResolvedValue(
      mockOk({
        id: "act_005",
        kind: "email.send",
        title: "Email: Follow-up",
        status: "rejected",
        inbox_url: "https://signoff.dev/inbox/act_005",
        decision_at: "2026-07-10T08:02:00Z",
      }),
    );

    const result = await awaitDecision(config, { action_id: "act_005" }, 0);

    // rejected is a valid decision: the agent should read the status, not treat it as a system error
    const parsed = JSON.parse(result.text) as { status: string };
    expect(parsed.status).toBe("rejected");
    expect(result.isError).toBeFalsy();
  });

  it("returns isError for expired action", async () => {
    mockFetch.mockResolvedValue(
      mockOk({ id: "act_006", status: "expired", inbox_url: "https://signoff.dev/inbox/act_006" }),
    );

    const result = await awaitDecision(config, { action_id: "act_006" }, 0);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/expired/i);
    expect(result.text).toMatch(/signoff_push_action/i);
  });
});

// ─── reportResult ─────────────────────────────────────────────────────────────

describe("reportResult", () => {
  it("reports executed status", async () => {
    mockFetch.mockResolvedValue(mockOk({}, 204));

    const result = await reportResult(config, {
      action_id: "act_007",
      status: "executed",
    });

    expect(result).toContain("act_007");
    expect(result).toContain("executed");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:8484/v1/actions/act_007/result");
  });

  it("reports execute_failed with error detail", async () => {
    mockFetch.mockResolvedValue(mockOk({}, 204));

    const result = await reportResult(config, {
      action_id: "act_008",
      status: "execute_failed",
      detail: "Network timeout when posting to Reddit",
    });

    expect(result).toContain("act_008");
    expect(result).toContain("execute_failed");
    expect(result).toContain("Network timeout");
  });
});

// ─── inboxStatus ──────────────────────────────────────────────────────────────

describe("inboxStatus", () => {
  it("reports empty inbox clearly", async () => {
    mockFetch.mockResolvedValue(mockOk([]));

    const result = await inboxStatus(config);

    expect(result).toMatch(/0 pending/i);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:8484/v1/actions?status=pending");
  });

  it("lists pending action count and titles", async () => {
    mockFetch.mockResolvedValue(
      mockOk([
        { id: "act_009", kind: "reddit.comment", title: "Reply: First post", status: "pending" },
        { id: "act_010", kind: "email.send", title: "Email: Follow-up to John", status: "pending" },
      ]),
    );

    const result = await inboxStatus(config);

    expect(result).toContain("2 pending");
    expect(result).toContain("act_009");
    expect(result).toContain("Reply: First post");
    expect(result).toContain("act_010");
  });
});

// ─── Phase 2 stubs ────────────────────────────────────────────────────────────

describe("createWatcher", () => {
  it("returns isError with a phase 2 message", () => {
    const result = createWatcher();
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/phase 2/i);
  });
});

describe("listWatchers", () => {
  it("returns isError with a phase 2 message", () => {
    const result = listWatchers();
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/phase 2/i);
  });
});

// ─── API error mapping ────────────────────────────────────────────────────────

describe("API error mapping", () => {
  it("maps 401 to a clear authentication error", async () => {
    mockFetch.mockResolvedValue(mockErr(401, { message: "Invalid API key" }));

    await expect(
      pushAction(config, {
        kind: "test",
        title: "Test",
        preview: { format: "text", body: "body" },
      }),
    ).rejects.toThrow(/authentication failed/i);
  });

  it("maps 404 to a not-found error", async () => {
    mockFetch.mockResolvedValue(mockErr(404, { message: "Not found" }));

    await expect(
      reportResult(config, { action_id: "act_999", status: "executed" }),
    ).rejects.toThrow(/not found/i);
  });

  it("maps 410 to an expired action error", async () => {
    mockFetch.mockResolvedValue(mockErr(410, { message: "Gone" }));

    await expect(
      reportResult(config, { action_id: "act_999", status: "executed" }),
    ).rejects.toThrow(/expired/i);
  });
});
