import { TOOLS } from '@impri/mcp/toolDefs';

// Static metadata card at /.well-known/mcp/server-card.json. Directories
// (Smithery, the Claude connectors directory, etc.) fetch this BEFORE trying
// to connect, so it must be reachable with no Authorization header at all —
// that's the whole point: a scanner that can't get past a 401 can still see
// what this server does and how to authenticate.
//
// Built from the same TOOLS array the stdio package and the /mcp endpoint
// use, so the three can never describe different tools.
export function buildServerCard(baseUrl: string, serverVersion: string) {
  return {
    serverInfo: {
      name: 'io.github.sekera-radim/impri',
      version: serverVersion,
    },
    description: 'Impri — human-in-the-loop approval inbox for AI agents. Push an action, wait for a human to approve or reject it, then report the result.',
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
