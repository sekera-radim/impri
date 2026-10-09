/**
 * Validates that every tool declaring an outputSchema (toolDefs.ts) actually
 * returns structuredContent conforming to it — the MCP spec (2025-06-18)
 * requires this once outputSchema is present. Covers both the "happy path"
 * shape and, where a tool has a separate empty/error branch, that branch too
 * (the error branches are expected to carry NO structuredContent at all,
 * matching the spec's own tool-execution-error example).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import type { ImpriConfig } from "../src/client.js";
import { TOOLS, type ToolOutputSchema } from "../src/toolDefs.js";
import {
  awaitDecision,
  createWatcher,
  createWatcherFromPreset,
  inboxStatus,
  listWatcherPresets,
  listWatchers,
  pushAction,
  reportResult,
} from "../src/tools.js";

const ajv = new Ajv();

function outputSchemaFor(name: string): ToolOutputSchema {
  const tool = TOOLS.find((t) => t.name === name);
  const schema = tool?.outputSchema;
  if (!schema) throw new Error(`${name} has no outputSchema declared in toolDefs.ts`);
  return schema;
}

function expectConforms(toolName: string, structuredContent: unknown): void {
  const validate = ajv.compile(outputSchemaFor(toolName));
  const valid = validate(structuredContent);
  expect(valid, JSON.stringify(validate.errors)).toBe(true);
}

const config: ImpriConfig = { apiKey: "im_test_key", baseUrl: "http://localhost:8484" };

function mockOk(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
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

describe("tool metadata (toolDefs.ts)", () => {
  it("every one of the 8 tools has a title and all four annotation hints set", () => {
    expect(TOOLS).toHaveLength(8);
    for (const t of TOOLS) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.annotations.title, t.name).toBeTruthy();
      expect(t.annotations.readOnlyHint, t.name).toBeDefined();
      expect(t.annotations.destructiveHint, t.name).toBeDefined();
      expect(t.annotations.idempotentHint, t.name).toBeDefined();
      expect(t.annotations.openWorldHint, t.name).toBeDefined();
    }
  });
});

describe("structuredContent conforms to outputSchema — success paths", () => {
  it("impri_push_action", async () => {
    mockFetch.mockResolvedValue(
      mockOk({ id: "act_001", status: "pending", inbox_url: "https://impri.dev/inbox/act_001" }, 201),
    );
    const result = await pushAction(config, {
      kind: "reddit.comment",
      title: "x",
      preview: { format: "text", body: "x" },
    });
    expectConforms("impri_push_action", result.structuredContent);
  });

  it("impri_await_decision (approved, with human edit)", async () => {
    mockFetch.mockResolvedValue(
      mockOk({
        id: "act_002",
        kind: "reddit.comment",
        title: "x",
        status: "approved",
        inbox_url: "https://impri.dev/inbox/act_002",
        preview: { format: "text", body: "original" },
        decision: {
          verdict: "approve",
          decided_at: 1_700_000_000,
          final_preview: { format: "text", body: "edited" },
          diff: "-original\n+edited",
        },
      }),
    );
    const result = await awaitDecision(config, { action_id: "act_002" }, 0);
    expectConforms("impri_await_decision", result.structuredContent);
  });

  it("impri_await_decision (rejected, untrusted watcher content)", async () => {
    mockFetch.mockResolvedValue(
      mockOk({
        id: "act_003",
        kind: "watcher.triage",
        title: "x",
        status: "rejected",
        inbox_url: "https://impri.dev/inbox/act_003",
        preview: { format: "text", body: "scraped content" },
        payload: { untrusted: true },
        decision: { verdict: "reject", decided_at: 1_700_000_100 },
      }),
    );
    const result = await awaitDecision(config, { action_id: "act_003" }, 0);
    expectConforms("impri_await_decision", result.structuredContent);
    expect(result.structuredContent?._untrusted_content_note).toBeTruthy();
  });

  it("impri_report_result", async () => {
    mockFetch.mockResolvedValue(mockOk({ id: "act_004", status: "executed", updated_at: 1_700_000_200 }));
    const result = await reportResult(config, { action_id: "act_004", status: "executed" });
    expectConforms("impri_report_result", result.structuredContent);
  });

  it("impri_inbox_status (non-empty)", async () => {
    mockFetch.mockResolvedValue(
      mockOk({ items: [{ id: "act_005", kind: "x", title: "x", status: "pending", inbox_url: "u" }] }),
    );
    const result = await inboxStatus(config);
    expectConforms("impri_inbox_status", result.structuredContent);
  });

  it("impri_inbox_status (empty)", async () => {
    mockFetch.mockResolvedValue(mockOk({ items: [] }));
    const result = await inboxStatus(config);
    expectConforms("impri_inbox_status", result.structuredContent);
    expect(result.structuredContent).toEqual({ pending_count: 0 });
  });

  it("impri_create_watcher", async () => {
    mockFetch.mockResolvedValue(
      mockOk(
        { id: "w_001", name: "AI radar", kind: "rss", status: "active", schedule: {}, created_at: 1 },
        201,
      ),
    );
    const result = await createWatcher(config, { spec: { name: "AI radar", kind: "rss", config: {} } });
    expectConforms("impri_create_watcher", result.structuredContent);
  });

  it("impri_list_watchers (non-empty)", async () => {
    mockFetch.mockResolvedValue(
      mockOk({
        items: [{ id: "w_001", name: "AI radar", kind: "rss", status: "active", schedule: {}, created_at: 1 }],
      }),
    );
    const result = await listWatchers(config);
    expectConforms("impri_list_watchers", result.structuredContent);
  });

  it("impri_list_watchers (empty)", async () => {
    mockFetch.mockResolvedValue(mockOk({ items: [] }));
    const result = await listWatchers(config);
    expectConforms("impri_list_watchers", result.structuredContent);
    expect(result.structuredContent).toEqual({ count: 0, watchers: [] });
  });

  it("impri_list_watcher_presets", async () => {
    mockFetch.mockResolvedValue(
      mockOk({
        presets: [
          {
            id: "hn-front-page",
            title: "Hacker News Front Page",
            description: "d",
            category: "Community",
            kind: "rss",
            params: [{ name: "keyword", required: true, description: "d", example: "rust" }],
            defaultScheduleEvery: "1h",
          },
        ],
      }),
    );
    const result = await listWatcherPresets(config);
    expectConforms("impri_list_watcher_presets", result.structuredContent);
  });

  it("impri_create_watcher_from_preset", async () => {
    mockFetch.mockResolvedValue(
      mockOk(
        { id: "w_002", name: "HN: rust", kind: "rss", status: "active", schedule: {}, created_at: 1 },
        201,
      ),
    );
    const result = await createWatcherFromPreset(config, { preset_id: "hn-keyword", params: { keyword: "rust" } });
    expectConforms("impri_create_watcher_from_preset", result.structuredContent);
  });
});

describe("error results carry no structuredContent (per MCP spec's own error example)", () => {
  it("impri_await_decision timeout", async () => {
    mockFetch.mockResolvedValue(
      mockOk({ id: "act_006", kind: "x", title: "x", status: "pending", inbox_url: "u" }),
    );
    const result = await awaitDecision(config, { action_id: "act_006", timeout_s: 0 }, 0);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it("impri_await_decision expired", async () => {
    mockFetch.mockResolvedValue(
      mockOk({ id: "act_007", kind: "x", title: "x", status: "expired", inbox_url: "u" }),
    );
    const result = await awaitDecision(config, { action_id: "act_007" }, 0);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});
