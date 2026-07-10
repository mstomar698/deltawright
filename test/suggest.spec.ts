import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { suggest } from '../src/host/suggest';
import type { Delta, DeltaNode, Verdict } from '../src/index';

// New-test authoring aid (#57). Pure function of a Delta — browser-free unit tests over hand-built
// nodes, exactly like diagnose.spec. Covers the four acceptance criteria + the honesty guards.

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
      rect: { x: 10, y: 10, width: 80, height: 30 },
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
      reason: verdict === 'ACTIONABLE' ? null : 'blocked',
      geometryVerdict: verdict,
      playwright: verdict === 'ACTIONABLE' ? { actionable: true } : { actionable: false },
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

test('should_prefer_getByRole_then_text_then_testid_then_css', () => {
  // role + name → the role tier ranks first and is getByRole(role, { name }).
  const withRole = suggest(delta([node({ ref: 'e1', role: 'button', name: 'Save' })]));
  const e1 = withRole.selectors.filter((s) => s.ref === 'e1');
  expect(e1[0]!.tier).toBe('role');
  expect(e1[0]!.code).toBe("page.getByRole('button', { name: 'Save' })");
  expect(e1.map((s) => s.tier)).toEqual(['role', 'text', 'css']); // testid never emitted; ranked role<text<css

  // name but NULL role → text tier is the top selector.
  const noRole = suggest(delta([node({ ref: 'e2', role: null, name: 'Save' })]));
  const e2 = noRole.selectors.filter((s) => s.ref === 'e2');
  expect(e2[0]!.tier).toBe('text');
  expect(e2[0]!.code).toBe("page.getByText('Save')");

  // role + name both null (a container) → only the css fallback.
  const container = suggest(delta([node({ ref: 'e3', role: null, name: null, tag: 'div' })]));
  const e3 = container.selectors.filter((s) => s.ref === 'e3');
  expect(e3.map((s) => s.tier)).toEqual(['css']);
  expect(e3[0]!.code).toBe("page.locator('div')");
});

test('should_refuse_data_dw_ref_as_a_durable_selector_and_warn_it_is_ephemeral', () => {
  const r = suggest(delta([node()]));
  // No suggested selector references data-dw-ref / the ephemeral ref id.
  expect(r.selectors.every((s) => !/data-dw-ref|\be1\b/.test(s.code))).toBe(true);
  // …and it is warned as ephemeral.
  expect(r.warnings.some((w) => /data-dw-ref/.test(w) && /ephemeral|stripped/i.test(w))).toBe(true);
});

test('should_be_a_pure_function_that_never_writes_test_files', () => {
  // Purity 1: the source imports neither the filesystem nor Playwright (so it cannot write/act).
  const src = readFileSync(resolve(process.cwd(), 'src/host/suggest.ts'), 'utf8');
  expect(src).not.toMatch(/from ['"]node:fs['"]|require\(['"]node:fs['"]\)/);
  expect(src).not.toMatch(/@playwright\/test/);

  // Purity 2: it does not mutate its input.
  const input = delta([node()]);
  const frozen = Object.freeze({ ...input, nodes: input.nodes.map((n) => Object.freeze(n)) });
  expect(() => suggest(frozen)).not.toThrow();
});

test('should_only_suggest_toBeActionable_for_playwright_confirmed_nodes', () => {
  const mixed = suggest(
    delta([
      node({ ref: 'ok' }, 'ACTIONABLE'),
      node({ ref: 'blocked', name: 'Submit' }, 'NOT-actionable'),
      node({ ref: 'na', name: 'Gone' }, 'n/a'),
    ]),
  );
  const refs = mixed.assertions.map((a) => a.ref);
  expect(refs).toEqual(['ok']); // ONLY the ACTIONABLE node
  expect(mixed.assertions[0]!.code).toContain('.toBeActionable()');
  expect(mixed.assertions[0]!.code).toContain("getByRole('button', { name: 'Save' })"); // on its top selector
});

test('emits VALID pasteable JS even when a name contains a newline (aria-label keeps internal breaks)', () => {
  const r = suggest(delta([node({ ref: 'ml', role: 'button', name: 'Save\nnow' })]));
  // The newline is escaped, not left raw (which would be a syntax error in a single-quoted literal).
  const roleSel = r.selectors.find((s) => s.ref === 'ml' && s.tier === 'role')!;
  expect(roleSel.code).toContain('\\n');
  expect(roleSel.code).not.toMatch(/\n(?!ow)/); // no raw newline inside the code
  // Every emitted code string parses as valid JS (a bare expression).
  for (const s of r.selectors) expect(() => new Function('page', 'return ' + s.code)).not.toThrow();
  for (const a of r.assertions)
    expect(
      () => new Function('page', 'expect', 'return ' + a.code.replace(/^await /, '')),
    ).not.toThrow();
});

test('css tier is the bare tag (never a fabricated [role] that misses native elements)', () => {
  // A native <button> has role 'button' with NO role= attribute, so `button[role="button"]` would
  // match nothing — the css fallback must be the tag alone.
  const r = suggest(delta([node({ ref: 'b', role: 'button', tag: 'button' })]));
  const css = r.selectors.find((s) => s.ref === 'b' && s.tier === 'css')!;
  expect(css.code).toBe("page.locator('button')");
  expect(css.code).not.toContain('[role=');
});

test('never fabricates a getByTestId and warns it was not observed', () => {
  const r = suggest(delta([node()]));
  expect(r.selectors.some((s) => s.tier === 'testid')).toBe(false);
  expect(r.selectors.some((s) => /getByTestId/.test(s.code))).toBe(false);
  expect(r.warnings.some((w) => /getByTestId|test-id/i.test(w))).toBe(true);
});
