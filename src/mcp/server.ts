// Deltawright MCP server (stdio). Exposes the delta primitive to agents (Claude Code,
// Cursor, …) so they consume "what changed + is it actionable" natively instead of
// re-dumping accessibility snapshots. Complements Playwright MCP; does not replace it.
//
//   Run:  npx tsx src/mcp/server.ts   (dev)  ·  deltawright-mcp  (installed bin)
//   Embed: import { startServer, DeltawrightSession } from 'deltawright/mcp'
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DeltawrightSession, type McpAction } from './session';

// Re-exported so `deltawright/mcp` is a real importable module (embedders can drive a
// session directly), not just a runnable bin.
export { DeltawrightSession };

const session = new DeltawrightSession();
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function buildAction(
  action: 'click' | 'fill' | 'select' | 'check' | 'press',
  selector: string,
  value?: string,
  key?: string,
): McpAction {
  switch (action) {
    case 'fill':
      return { kind: 'fill', selector, value: value ?? '' };
    case 'select':
      return { kind: 'select', selector, value: value ?? '' };
    case 'press':
      return { kind: 'press', selector, key: key ?? 'Enter' };
    case 'check':
      return { kind: 'check', selector };
    default:
      return { kind: 'click', selector };
  }
}

const server = new McpServer({ name: 'deltawright', version: '0.1.0' });

server.registerTool(
  'navigate',
  {
    title: 'Navigate',
    description: 'Open a URL in the browser and return its accessibility snapshot.',
    inputSchema: { url: z.string().describe('The URL to open') },
  },
  async ({ url }) => text(await session.navigate(url)),
);

server.registerTool(
  'act_and_observe',
  {
    title: 'Act and observe',
    description:
      'Perform ONE action and return a compact delta: exactly what changed on the page, ' +
      'where it is, and whether each changed element is actionable. Use this instead of ' +
      're-snapshotting the whole page after an action.',
    inputSchema: {
      action: z.enum(['click', 'fill', 'select', 'check', 'press']),
      selector: z.string().describe('CSS selector, or [data-dw-ref="eN"] from a prior delta'),
      value: z.string().optional().describe('Value for fill/select'),
      key: z.string().optional().describe('Key for press, e.g. "Enter"'),
    },
  },
  async ({ action, selector, value, key }) =>
    text(await session.act(buildAction(action, selector, value, key))),
);

server.registerTool(
  'snapshot',
  {
    title: 'Full snapshot',
    description: 'Return the full accessibility snapshot of the current page (the rare fallback).',
    inputSchema: {},
  },
  async () => text(await session.snapshot()),
);

/**
 * Start the stdio MCP server. Invoked automatically when this file is run directly
 * (the `deltawright-mcp` bin, `deltawright mcp`, or `tsx src/mcp/server.ts`); exported
 * so embedders can start it themselves.
 */
export async function startServer(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

// Self-run ONLY when executed as the entry point, not when imported (deltawright/mcp),
// so the module stays importable for embedders without spawning a server on import.
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await startServer();
}
