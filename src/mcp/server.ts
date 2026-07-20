// Deltawright MCP server (stdio). Exposes the delta primitive to agents (Claude Code,
// Cursor, …) so they consume "what changed + is it actionable" natively instead of
// re-dumping accessibility snapshots. Complements Playwright MCP; does not replace it.
//
//   Run:  npx tsx src/mcp/server.ts   (dev)  ·  deltawright-mcp  (installed bin)
//   Embed: import { startServer, DeltawrightSession } from 'deltawright/mcp'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DeltawrightSession, type McpAction } from './session';

// Advertise the REAL package version in the MCP initialize handshake (not a stale hardcode). The
// package.json sits two levels up from dist/mcp/server.js (and from src/mcp/server.ts in the dev tree).
function packageVersion(): string {
  try {
    return (
      JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ??
      '0.0.0'
    );
  } catch {
    return '0.0.0';
  }
}

// Re-exported so `deltawright/mcp` is a real importable module (embedders can drive a
// session directly), not just a runnable bin.
export { DeltawrightSession };

const session = new DeltawrightSession();
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function buildAction(
  action: 'click' | 'fill' | 'type' | 'select' | 'check' | 'press',
  selector: string,
  value?: string,
  key?: string,
): McpAction {
  switch (action) {
    case 'fill':
      return { kind: 'fill', selector, value: value ?? '' };
    case 'type':
      return { kind: 'type', selector, value: value ?? '' };
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

const server = new McpServer({ name: 'deltawright', version: packageVersion() });

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
      action: z.enum(['click', 'fill', 'type', 'select', 'check', 'press']),
      selector: z.string().describe('CSS selector, or [data-dw-ref="eN"] from a prior delta'),
      value: z.string().optional().describe('Value for fill/type/select'),
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

// --- #60 agent-assist debug tools (LIVE-REPRODUCE; additive) ------------------------------------
// Each drives THIS server's own browser session and diagnoses what happens here. They do NOT read
// your live Playwright test run (the session has no handle on it), and NONE mutates a test or
// "fixes" a flake — they only observe and explain. The action tools share act_and_observe's schema.
const actionSchema = {
  action: z.enum(['click', 'fill', 'type', 'select', 'check', 'press']),
  selector: z.string().describe('CSS selector, or [data-dw-ref="eN"] from a prior delta'),
  value: z.string().optional().describe('Value for fill/type/select'),
  key: z.string().optional().describe('Key for press, e.g. "Enter"'),
};

server.registerTool(
  'preflight',
  {
    title: 'Preflight a selector',
    description:
      'LIVE-REPRODUCE (this session, NOT your test run): probe one selector on the current page ' +
      "and return Playwright's AUTHORITATIVE actionability verdict, what geometry alone concluded, " +
      'and whether they agreed. Reads only — performs no action, mutates nothing.',
    inputSchema: { selector: z.string().describe('CSS selector to preflight') },
  },
  async ({ selector }) => text(JSON.stringify(await session.preflightSelector(selector), null, 2)),
);

server.registerTool(
  'observe_settle',
  {
    title: 'Observe settle',
    description:
      'LIVE-REPRODUCE (this session, NOT your test run): perform ONE action and report the settle ' +
      'SIGNAL — when the DOM went structurally quiet, whether that was inconclusive (hit the cap), ' +
      'and whether a late wave landed. A signal, NOT a readiness guarantee; it does not retry, ' +
      'suppress a flake, or mutate the test.',
    inputSchema: actionSchema,
  },
  async ({ action, selector, value, key }) =>
    text(
      JSON.stringify(
        await session.observeSettle(buildAction(action, selector, value, key)),
        null,
        2,
      ),
    ),
);

server.registerTool(
  'explain_delta',
  {
    title: 'Explain delta',
    description:
      'LIVE-REPRODUCE (this session, NOT your test run): perform ONE action and return its compact ' +
      'delta WITH the root-cause diagnostics section — the same explanation an author would read. ' +
      'Observes and explains only; it does not change the page permanently or fix anything.',
    inputSchema: actionSchema,
  },
  async ({ action, selector, value, key }) =>
    text(await session.explainDelta(buildAction(action, selector, value, key))),
);

server.registerTool(
  'diagnose',
  {
    title: 'Diagnose action',
    description:
      'LIVE-REPRODUCE (this session, NOT your test run): perform ONE action and return the gated ' +
      "taxonomy read — {category, confidence, unsure, geomDisagreement} grounded in Playwright's " +
      'AUTHORITATIVE verdict. When no cause crosses the confidence gate it stays `unsure` (never a ' +
      'fabricated cause). It reports a hypothesis; it does not mutate the test or fix a flake.',
    inputSchema: actionSchema,
  },
  async ({ action, selector, value, key }) =>
    text(
      JSON.stringify(
        await session.diagnoseAction(buildAction(action, selector, value, key)),
        null,
        2,
      ),
    ),
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
