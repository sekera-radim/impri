#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type ImpriConfig } from "./client.js";
import { callTool } from "./dispatch.js";
import { INSTRUCTIONS, SERVER_NAME, SERVER_TITLE, VERSION } from "./serverInfo.js";
import { TOOLS } from "./toolDefs.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const apiKey = process.env["IMPRI_API_KEY"];
if (!apiKey) {
  // Don't exit — start anyway so clients and registries (e.g. Glama) can
  // introspect the tool list before a key is configured. Tool *calls* return
  // a clear error until IMPRI_API_KEY is set (see the CallTool handler).
  process.stderr.write(
    [
      "Warning: IMPRI_API_KEY is not set — tool calls will fail until it is.",
      "Obtain an API key at https://impri.dev and pass it via environment variable.",
      "Example: IMPRI_API_KEY=im_... npx @impri/mcp",
    ].join("\n") + "\n",
  );
}

const config: ImpriConfig = {
  apiKey: apiKey ?? "",
  baseUrl: process.env["IMPRI_BASE_URL"] ?? "http://localhost:8484",
};

// ─── MCP server ───────────────────────────────────────────────────────────────

// name/title/version/instructions come from serverInfo.ts, shared with the
// hosted /mcp route and the server card — see that file for why version is
// read from package.json at runtime rather than hardcoded (this file
// drifted out of sync with package.json before: reported "0.1.0" while the
// package was already at 0.1.1).
const server = new Server(
  { name: SERVER_NAME, title: SERVER_TITLE, version: VERSION },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  if (!apiKey) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Error: IMPRI_API_KEY is not set. Get a key at https://impri.dev and set it in your MCP client config for this server.",
        },
      ],
      isError: true,
    };
  }

  return callTool(config, name, args);
});

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
