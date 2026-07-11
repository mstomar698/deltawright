import { test, expect } from '@playwright/test';
import { verifySuggestions } from '../src/matchers';
import type { VerifiedSuggestResult, VerifiedSelectorSuggestion } from '../src/matchers';
import type { Delta, DeltaNode, Verdict } from '../src/index';

// Durable-selector recommender (Wave-2 #6) — the PAGE-AWARE layer over pure suggest(). Live tests:
// set page content (with data-dw-ref stamped, as the observer does at collect), build a matching
// synthetic delta, and assert each candidate is classified verified / ambiguous / unique-elsewhere /
// broken against the real page, plus the DW-03 stay-unsure + refs-absent warnings.

function node(over: Partial<DeltaNode> = {}, verdict: Verdict = 'ACTIONABLE'): DeltaNode {
  return {
    ref: 'e1',
    kind: 'added',
    tag: 'button',
    role: 'button',
    name: 'Save',
    interactive: true,
    parentRef: null,
    geometry: {
      rect: { x: 0, y: 0, width: 80, height: 30 },
      inViewport: true,
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      pointerEvents: 'auto',
      hitSelf: true,
      coveredBy: null,
      offscreen: false,
    },
    actionability: {
      verdict,
      reason: null,
      geometryVerdict: verdict,
      playwright: { actionable: verdict === 'ACTIONABLE' },
      agreed: true,
    },
    ...over,
  };
}

const delta = (nodes: DeltaNode[]): Delta => ({
  action: 'x',
  nodes,
  stats: {
    rawRecords: 1,
    settleMs: 1,
    hitMaxWait: false,
    animationsAwaited: 0,
    droppedBackground: 0,
  },
});

const find = (r: VerifiedSuggestResult, ref: string, tier: string): VerifiedSelectorSuggestion =>
  r.selectors.find((s) => s.ref === ref && s.tier === tier)!;

test('verifies a unique candidate, demotes an ambiguous one, and picks bestVerified', async ({
  page,
}) => {
  await page.setContent(`
    <button data-dw-ref="e1" aria-label="Save">Save</button>
    <button aria-label="Save">Save copy</button>
    <input data-dw-ref="e2" type="text" aria-label="Email">
  `);
  const r = await verifySuggestions(
    page,
    delta([
      node({ ref: 'e1', role: 'button', name: 'Save', tag: 'button' }),
      node({ ref: 'e2', role: 'textbox', name: 'Email', tag: 'input' }),
    ]),
  );

  // e2's role selector resolves to exactly the delta's element → verified.
  const e2 = find(r, 'e2', 'role');
  expect(e2.matches).toBe(1);
  expect(e2.verified).toBe(true);
  expect(e2.status).toBe('verified');

  // e1's role selector matches BOTH Save buttons → ambiguous, not verified.
  const e1 = find(r, 'e1', 'role');
  expect(e1.matches).toBe(2);
  expect(e1.verified).toBe(false);
  expect(e1.status).toBe('ambiguous');

  // bestVerified is a verified-unique candidate (e2), and verified candidates rank first.
  expect(r.bestVerified?.verified).toBe(true);
  expect(r.bestVerified?.ref).toBe('e2');
  expect(r.selectors[0]!.verified).toBe(true);

  // Assertions are RE-POINTED to verified selectors: e2 keeps one (on its verified role selector);
  // e1 is ambiguous with NO verified selector, so its assertion is dropped (never handed back on a
  // selector we proved ambiguous) and a warning says so.
  expect(r.assertions.map((a) => a.ref)).toEqual(['e2']);
  expect(r.assertions[0]!.code).toContain("getByRole('textbox', { name: 'Email' })");
  expect(r.warnings.some((w) => w.includes('dropped 1 suggested assertion'))).toBe(true);
});

test('flags a unique-but-wrong-target candidate as unique-elsewhere (not verified)', async ({
  page,
}) => {
  await page.setContent(`
    <a data-dw-ref="e3" href="#">Alpha</a>
    <a href="#">Beta</a>
  `);
  // The node's ref is on the Alpha link, but its name points at the (unique) Beta link.
  const r = await verifySuggestions(
    page,
    delta([node({ ref: 'e3', role: 'link', name: 'Beta', tag: 'a' })]),
  );
  const cand = find(r, 'e3', 'role');
  expect(cand.matches).toBe(1); // resolves uniquely …
  expect(cand.unique).toBe(true);
  expect(cand.verified).toBe(false); // … but to the WRONG element
  expect(cand.status).toBe('unique-elsewhere');
  expect(r.bestVerified?.ref).not.toBe('e3'); // never surfaced as the paste-ready selector
});

test('marks a candidate that resolves to nothing as broken', async ({ page }) => {
  await page.setContent(`<button data-dw-ref="e4" aria-label="Real">Real</button>`);
  const r = await verifySuggestions(
    page,
    delta([node({ ref: 'e4', role: 'button', name: 'Ghost', tag: 'button' })]),
  );
  const roleCand = find(r, 'e4', 'role'); // getByRole(button, name:Ghost) → 0
  expect(roleCand.matches).toBe(0);
  expect(roleCand.status).toBe('broken');
});

test('stays unsure (bestVerified null + warning) when nothing resolves uniquely', async ({
  page,
}) => {
  await page.setContent(`
    <button data-dw-ref="e5" aria-label="Dup">Dup</button>
    <button aria-label="Dup">Dup</button>
  `);
  const r = await verifySuggestions(
    page,
    delta([node({ ref: 'e5', role: 'button', name: 'Dup', tag: 'button' })]),
  );
  expect(r.bestVerified).toBeNull();
  expect(r.warnings.some((w) => w.includes('no candidate resolves uniquely'))).toBe(true);
});

test('marks a unique match as unconfirmed (not wrong) + warns when the delta refs are absent', async ({
  page,
}) => {
  // No data-dw-ref anywhere — same-element identity cannot be confirmed. A unique match must be
  // reported as `unconfirmed` (identity unknown), NEVER as `unique-elsewhere` (which claims it is the
  // wrong element) — absence of evidence must not become evidence of absence (DW-03).
  await page.setContent(`<input type="text" aria-label="Solo">`);
  const r = await verifySuggestions(
    page,
    delta([node({ ref: 'e6', role: 'textbox', name: 'Solo', tag: 'input' })]),
  );
  const cand = find(r, 'e6', 'role');
  expect(cand.matches).toBe(1);
  expect(cand.unique).toBe(true);
  expect(cand.verified).toBe(false);
  expect(cand.status).toBe('unconfirmed');
  expect(r.warnings.some((w) => w.includes('data-dw-ref markers are on the page'))).toBe(true);
});

test('all-broken candidates with refs PRESENT do not trigger a spurious called-too-late warning', async ({
  page,
}) => {
  // A node whose selectors resolve to nothing, but whose ref IS on the page → this is a bad-selector
  // situation, not a timing/cleared-ref one. The refs-absent warning must NOT fire (it would send the
  // user to re-run at a moment that can't help).
  await page.setContent(`<span data-dw-ref="e7">not a button</span>`);
  const r = await verifySuggestions(
    page,
    // role button + tag "button" both miss (the element is a span); its ref is present.
    delta([node({ ref: 'e7', role: 'button', name: 'Ghost', tag: 'button' })]),
  );
  expect(find(r, 'e7', 'role').status).toBe('broken');
  expect(r.warnings.some((w) => w.includes('data-dw-ref markers are on the page'))).toBe(false);
});
