/**
 * serverInfo.ts is what mcp/src/index.ts (the stdio server) passes into the
 * SDK's `Server` constructor's name/title/version/instructions — and what
 * server/src/routes/mcp.ts and server/src/mcp/serverCard.ts import for the
 * hosted /mcp route and the public server card. Testing it here covers the
 * stdio side (index.ts has no testable seam of its own: it's a CLI entry
 * point with a top-level `await server.connect(transport)`), and the
 * server-side tests (server/test/mcp.test.ts) cover the same constants
 * reaching /mcp and the server card.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { INSTRUCTIONS, SERVER_NAME, SERVER_TITLE, VERSION } from "../src/serverInfo.js";

const _require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(_require.resolve("../package.json"), "utf8")) as { version: string };

describe("serverInfo", () => {
  it("VERSION matches mcp/package.json, not any other package's version", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("SERVER_NAME/SERVER_TITLE are set", () => {
    expect(SERVER_NAME).toBe("@impri/mcp");
    expect(SERVER_TITLE).toBe("Impri");
  });

  it("INSTRUCTIONS covers the push/await/report flow and watchers, and is a reasonable size", () => {
    expect(INSTRUCTIONS.length).toBeGreaterThan(400);
    expect(INSTRUCTIONS.length).toBeLessThan(1200);
    for (const tool of [
      "impri_push_action",
      "impri_await_decision",
      "impri_report_result",
      "impri_create_watcher",
    ]) {
      expect(INSTRUCTIONS).toContain(tool);
    }
    // Decision outcomes a model needs to branch on.
    expect(INSTRUCTIONS).toContain("approved");
    expect(INSTRUCTIONS).toContain("rejected");
  });
});
