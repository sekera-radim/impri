import { TOOLS } from '@impri/mcp/toolDefs';
import { INSTRUCTIONS, SERVER_TITLE, VERSION } from '@impri/mcp/serverInfo';

// Static metadata card at /.well-known/mcp/server-card.json. Directories
// (Smithery, the Claude connectors directory, etc.) fetch this BEFORE trying
// to connect, so it must be reachable with no Authorization header at all —
// that's the whole point: a scanner that can't get past a 401 can still see
// what this server does and how to authenticate.
//
// Built from the same TOOLS array the stdio package and the /mcp endpoint
// use, so the three can never describe different tools. `version` comes
// from @impri/mcp/serverInfo (VERSION), not @impri/server's own
// package.json — this card describes the @impri/mcp protocol surface, so it
// must track that package's version, same as the /mcp route's `initialize`
// response.
export function buildServerCard(baseUrl: string) {
  return {
    serverInfo: {
      // Registry identity (matches server.json's "name"), distinct from the
      // "@impri/mcp" Implementation.name the protocol's initialize response
      // uses — see server/src/routes/mcp.ts.
      name: 'io.github.sekera-radim/impri',
      title: SERVER_TITLE,
      version: VERSION,
    },
    description: 'Impri — human-in-the-loop approval inbox for AI agents. Push an action, wait for a human to approve or reject it, then report the result.',
    instructions: INSTRUCTIONS,
    homepage: 'https://impri.dev',
    documentation: 'https://impri.dev/docs',
    transport: {
      type: 'streamable-http',
      url: `${baseUrl}/mcp`,
    },
    authentication: {
      required: true,
      schemes: ['bearer'],
    },
    tools: TOOLS.map(t => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
      annotations: t.annotations,
    })),
    prompts: [],
    resources: [],
  };
}
