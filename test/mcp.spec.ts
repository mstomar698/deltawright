import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DeltawrightSession } from '../src/mcp/session';
import { FIXTURE_URL, fixtureUrl } from './helpers';

// Tests the MCP session logic (the actual behavior behind the tools) without the
// stdio protocol. The server (src/mcp/server.ts) is a thin registerTool wrapper.

test('MCP session: navigate + act_and_observe returns a compact actionable delta', async () => {
  const session = new DeltawrightSession();
  try {
    const nav = await session.navigate(FIXTURE_URL);
    expect(nav).toContain('navigated to');

    // The star tool: one action -> the delta (what changed + actionability + tokens).
    const delta = await session.act({ kind: 'click', selector: '#open-popup' });
    expect(delta).toMatch(/dialog "Session expired"/);
    expect(delta).toMatch(/button "Renew".*ACTIONABLE/);
    expect(delta).toMatch(/\d+ tokens/);

    // Snapshot fallback still works.
    const snap = await session.snapshot();
    expect(snap.toLowerCase()).toContain('renew');
  } finally {
    await session.close();
  }
});

test('MCP session: fill action drives a real input and reports its delta', async () => {
  const session = new DeltawrightSession();
  try {
    await session.navigate(fixtureUrl('roles.html'));
    await session.act({ kind: 'click', selector: '#open-form' });
    // A fill action on a real input runs through Playwright and returns a delta.
    const delta = await session.act({ kind: 'fill', selector: '.normal', value: 'hello' });
    expect(delta).toMatch(/tokens/);
  } finally {
    await session.close();
  }
});

test('MCP server e2e: a client lists the tools and gets a delta over stdio', async () => {
  test.setTimeout(60_000); // cold npx + tsx + chromium launch in a subprocess
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/mcp/server.ts'],
  });
  const client = new Client({ name: 'deltawright-smoke', version: '0.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['act_and_observe', 'navigate', 'snapshot']);

    await client.callTool({ name: 'navigate', arguments: { url: FIXTURE_URL } });
    const res = await client.callTool({
      name: 'act_and_observe',
      arguments: { action: 'click', selector: '#open-popup' },
    });
    const out = (res.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('');
    expect(out).toMatch(/dialog "Session expired"/);
    expect(out).toMatch(/ACTIONABLE/);
  } finally {
    await client.close();
  }
});
