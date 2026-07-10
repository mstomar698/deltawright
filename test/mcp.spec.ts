import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DeltawrightSession, LIVE_REPRODUCE_NOTE } from '../src/mcp/session';
import { summarizeDiagnoses } from '../src/host/summarize';
import type { Diagnosis } from '../src/host/types';
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
    expect(tools.map((t) => t.name).sort()).toEqual([
      'act_and_observe',
      'diagnose',
      'explain_delta',
      'navigate',
      'observe_settle',
      'preflight',
      'snapshot',
    ]);

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

// --- #60 agent-assist debug tools (LIVE-REPRODUCE) ------------------------------------------------
// These reproduce over the session's OWN browser and diagnose what happens there. They do NOT read
// the user's live Playwright run, and none mutates a test or fixes a flake.

const SERVER_SRC = readFileSync(resolve(process.cwd(), 'src/mcp/server.ts'), 'utf8');
/** Every tool description registered in the server, by name. */
function toolDescriptions(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /registerTool\(\s*'([^']+)'\s*,\s*\{([\s\S]*?)\n {2}\},/g;
  for (let m = re.exec(SERVER_SRC); m; m = re.exec(SERVER_SRC)) {
    // Descriptions are `+`-concatenated string fragments in BOTH quote styles (double quotes wrap the
    // fragments that themselves contain an apostrophe, e.g. "Playwright's"), so capture either.
    const desc = [...m[2]!.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map((x) => x[2]).join(' ');
    out.set(m[1]!, desc);
  }
  return out;
}
const DEBUG_TOOLS = ['preflight', 'observe_settle', 'explain_delta', 'diagnose'];

test('should_expose_diagnose_returning_taxonomy_category_and_confidence_with_playwright_authoritative_verdicts', async () => {
  const session = new DeltawrightSession();
  try {
    // roles.html reveals a form with a disabled/read-only input on #open-form — a Playwright
    // NOT-actionable target with an authoritative blocking cause.
    await session.navigate(fixtureUrl('roles.html'));
    const d = await session.diagnoseAction({ kind: 'click', selector: '#open-form' });

    expect(d.category).toBe('actionability-blocking'); // a real taxonomy category…
    expect(d.confidence).toBe('confirmed'); // …at a Playwright-authoritative confidence…
    expect(d.unsure).toBe(false);
    expect(d.cause).not.toBe('unsure');
    expect(d.verdict).toBe('NOT-actionable'); // …grounded in Playwright's own verdict (DW-02).
  } finally {
    await session.close();
  }
});

test('should_mark_low_confidence_as_unsure', async () => {
  const session = new DeltawrightSession();
  try {
    // LIVE: an all-actionable outcome (the north-star popup opens a usable dialog) → no cause
    // crosses the gate → unsure, with NO category surfaced.
    await session.navigate(FIXTURE_URL);
    const d = await session.diagnoseAction({ kind: 'click', selector: '#open-popup' });
    expect(d.unsure).toBe(true);
    expect(d.category).toBeNull();
    expect(d.cause).toBe('unsure');
    expect(d.confidence).toBe('unknown');
    expect(d.verdict).toBe('n/a'); // never grounds a verdict on a cause it won't name
  } finally {
    await session.close();
  }

  // UNIT (the shared reducer the tool consumes): a below-the-bar hypothesis is marked unsure, its
  // category withheld — the tool can't drift from this because it IS this reduction.
  const suspected: Diagnosis[] = [
    { code: 'off-screen', confidence: 'suspected', scope: 'node', ref: 'e1', detail: 'x' },
  ];
  const raisedBar = summarizeDiagnoses(suspected, { minConfidence: 'confirmed' });
  expect(raisedBar.unsure).toBe(true);
  expect(raisedBar.category).toBeNull();
  expect(raisedBar.cause).toBe('unsure');
  // and the taxonomy's own `unknown` code never leaks a real category either.
  const unknownOnly = summarizeDiagnoses([
    { code: 'unknown', confidence: 'confirmed', scope: 'delta', detail: 'x' },
  ]);
  expect(unknownOnly.unsure).toBe(true);
  expect(unknownOnly.category).toBeNull();
});

test('should_not_claim_to_read_the_users_live_test_run', async () => {
  // The disclaimer itself is explicit that this is NOT the user's run.
  expect(LIVE_REPRODUCE_NOTE.toLowerCase()).toContain('does not read your');

  // Every debug tool result carries that disclaimer at runtime.
  const session = new DeltawrightSession();
  try {
    await session.navigate(fixtureUrl('roles.html'));
    expect((await session.preflightSelector('#open-form')).note).toBe(LIVE_REPRODUCE_NOTE);
    expect((await session.diagnoseAction({ kind: 'click', selector: '#open-form' })).note).toBe(
      LIVE_REPRODUCE_NOTE,
    );
    expect((await session.observeSettle({ kind: 'click', selector: '#open-form' })).note).toBe(
      LIVE_REPRODUCE_NOTE,
    );
    expect(await session.explainDelta({ kind: 'click', selector: '#open-form' })).toContain(
      LIVE_REPRODUCE_NOTE,
    );

    // The disclaimer also survives the ERROR path — the tools exist to probe FAILING actions, so a
    // thrown action error (here a malformed selector) must NOT look like the user's own test error.
    const bad = { kind: 'click' as const, selector: 'button:has-text(' };
    await expect(session.diagnoseAction(bad)).rejects.toThrow(LIVE_REPRODUCE_NOTE);
    await expect(session.explainDelta(bad)).rejects.toThrow(LIVE_REPRODUCE_NOTE);
    await expect(session.observeSettle(bad)).rejects.toThrow(LIVE_REPRODUCE_NOTE);
  } finally {
    await session.close();
  }

  // And every debug tool's DESCRIPTION disclaims it (says "NOT your test run") and none claims to
  // read the live run. Checked over the extracted DESCRIPTIONS (not raw source) so a reflowed comment
  // can't false-trip it, and so the assertion is about what the tools SAY, not incidental phrasing.
  const descs = toolDescriptions();
  for (const name of DEBUG_TOOLS) {
    expect(descs.get(name)!.toLowerCase()).toContain('not your test run');
  }
  const allDescs = [...descs.values()].join(' ').toLowerCase();
  expect(allDescs).not.toMatch(
    /reads?\s+(your|the user'?s)\s+(live\s+)?(playwright\s+)?(test\s+)?run/,
  );
});

test('should_expose_no_tool_that_mutates_a_test_or_fixes_a_flake', async () => {
  const descs = toolDescriptions();
  const names = [...descs.keys()].sort();
  // The additive debug tools are read/observe/explain only — no mutate/fix/retry/suppress verb.
  expect(names).toEqual(
    [
      'act_and_observe',
      'diagnose',
      'explain_delta',
      'navigate',
      'observe_settle',
      'preflight',
      'snapshot',
    ].sort(),
  );
  for (const name of names) {
    expect(name).not.toMatch(/\b(fix|retry|patch|mutat|suppress|rewrite|edit|repair|heal)/i);
  }
  // Every debug tool's description AFFIRMS it does not mutate/fix — it discloses the anti-goal rather
  // than quietly relying on it. (We check for the disclaimer, not for the mere absence of the verbs:
  // an honest "it does not mutate the test" SHOULD be present.)
  for (const name of DEBUG_TOOLS) {
    const d = descs.get(name)!.toLowerCase();
    expect(d).toMatch(
      /mutates nothing|reads only|observes and explains only|not a readiness guarantee|does not (retry|mutate|fix|change|suppress)/,
    );
  }
});
