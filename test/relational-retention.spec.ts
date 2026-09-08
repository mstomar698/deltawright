import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';
import { actAndObserve } from '../src/index';
import {
  scoreSelectors,
  measureRetention,
  type SelectorRetention,
} from '../src/matchers/score-selectors';
import {
  DEFAULT_ANCHOR_COUNT,
  RELATIONAL_BROKEN_MAX,
  RELATIONAL_PRESERVED_MIN,
} from '../src/matchers/relational-fingerprint';
import { startStaticServer, type StaticServer } from '../bench/static-server';
import { RELATIONAL_FIXTURE_URL, RETENTION_FIXTURE_URL } from './helpers';

// v1.2 — the LIVE half of the relational fingerprint, against real pages and real Playwright locators.
//
// Every case here is one where `centerShift` alone answers wrongly. The target is the "Save changes"
// button in the Account card; `measureRetention` re-checks it across a snapshot-B transition, and the
// two position witnesses are read side by side:
//
//   transition                        centerShift says   relationalAgreement says   the truth
//   page scrolled 600px               moved (600)        1.0  context preserved     same button
//   viewport 1280 -> 700 (breakpoint) moved (500)        1.0  context preserved     same button
//   tall row inserted above its card  moved (344)        1.0  context preserved     same button
//   Account card swapped for Billing  RETAINED (0)       0.33 context broken        DIFFERENT button
//
// The last row is the one that matters most: it is the false heal the research sweep names repeatedly
// (VON Similo's "selects a random element from the visual overlap"), and it is the case a
// position-only check cannot see, because the impostor is standing in exactly the right place.

const TARGET = 'Save changes';

const targetOf = (selectors: SelectorRetention[]): SelectorRetention => {
  const s = selectors.find((x) => x.tier === 'role' && x.code.includes(TARGET));
  expect(s, `a role-tier "${TARGET}" candidate was re-checked`).toBeTruthy();
  return s!;
};

/** Build the page, score snapshot A, then measure retention across `reRender`. */
async function measure(
  page: Page,
  reRender: () => Promise<void>,
  opts: Parameters<typeof measureRetention>[3] = {},
) {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const scored = await scoreSelectors(page, delta);
  const before = scored.selectors.find((s) => s.tier === 'role' && s.code.includes(TARGET));
  expect(before?.verified, `"${TARGET}" verified uniquely on snapshot A`).toBe(true);
  return measureRetention(page, delta, scored, { reRender, ...opts });
}

test.beforeEach(async ({ page }) => {
  await page.goto(RELATIONAL_FIXTURE_URL);
});

test('a page SCROLL moves the absolute centre 600px while every relation is preserved', async ({
  page,
}) => {
  const result = await measure(page, () => page.evaluate(() => window.scrollTo(0, 600)));
  const save = targetOf(result.selectors);

  // `centerShift` is exactly the failure its own doc comment predicts: the viewport scrolled, so the
  // one absolute point it tracks moved the full scroll distance and the verdict reads `moved`.
  expect(save.retention).toBe('moved');
  expect(save.centerShift).toBe(600);

  // The relational witness disagrees, correctly: a scroll translates the candidate AND its neighbours
  // by the same vector, so not one relation changed.
  expect(save.relationalStatus).toBe('measured');
  expect(save.relationalAgreement).toBe(1);
  expect(save.relationalAnchorsCompared).toBe(DEFAULT_ANCHOR_COUNT);
  expect(save.flags).toContain('relational-context-preserved');
});

test('MULTI-VIEWPORT: a responsive breakpoint slides the whole column, not the element in it', async ({
  page,
}) => {
  // 1280 -> 700 crosses the fixture's `max-width: 900px` breakpoint: the 420px rail collapses and the
  // content column slides left. This is a real re-layout, not a scroll — the page reflows.
  const result = await measure(page, () => page.setViewportSize({ width: 700, height: 720 }));
  const save = targetOf(result.selectors);

  expect(save.retention).toBe('moved');
  expect(save.centerShift).toBeGreaterThan(250); // past the default positionTolerance
  expect(save.relationalStatus).toBe('measured');
  expect(save.relationalAgreement).toBe(1);
  expect(save.relationalAnchorsCompared).toBe(DEFAULT_ANCHOR_COUNT);
  expect(save.flags).toContain('relational-context-preserved');
});

test('REFLOW: a sibling row inserted ABOVE the target pushes it down with its whole neighbourhood', async ({
  page,
}) => {
  // A 320px banner inserted as the first child of <main>, i.e. before the card holding the target.
  const result = await measure(page, () => page.click('#insert-above'));
  const save = targetOf(result.selectors);

  expect(save.retention).toBe('moved');
  expect(save.centerShift).toBeGreaterThan(250);
  // The card came down as a unit, so the target's position relative to its anchors is untouched.
  expect(save.relationalStatus).toBe('measured');
  expect(save.relationalAgreement).toBe(1);
  expect(save.flags).toContain('relational-context-preserved');
});

test('TRUE NEGATIVE: a different button in the same place is NOT rescued by looking similar', async ({
  page,
}) => {
  // The Account card is replaced by a Billing card of identical geometry that also has a "Save changes"
  // button. The selector re-resolves uniquely, in the same spot, onto a DIFFERENT element.
  const result = await measure(page, () => page.click('#swap-panel'));
  const save = targetOf(result.selectors);

  // Position alone is fooled completely — this is the false heal, and it is reported `retained`.
  expect(save.retention).toBe('retained');
  expect(save.centerShift).toBeLessThanOrEqual(1);

  // The relational witness is not fooled: the neighbourhood is a different neighbourhood.
  expect(save.relationalStatus).toBe('measured');
  expect(save.relationalAgreement).not.toBeNull();
  expect(save.relationalAgreement!).toBeLessThanOrEqual(RELATIONAL_BROKEN_MAX);
  expect(save.flags).toContain('relational-context-broken');
  expect(save.flags).not.toContain('relational-context-preserved');

  // HONESTY (DW-02/03): being unconvinced is all it does. It does NOT overturn the verdict — Playwright
  // resolved one element uniquely and near the recorded rect, and that stays `retained`. The relational
  // reading is the evidence a reviewer needs to doubt it, surfaced next to the verdict, never instead
  // of it.
  expect(save.retention).toBe('retained');
});

test('the two witnesses genuinely disagree — a preserved context outscores a broken one', async ({
  page,
}) => {
  const reflow = targetOf((await measure(page, () => page.click('#insert-above'))).selectors);
  await page.goto(RELATIONAL_FIXTURE_URL);
  const falseHeal = targetOf((await measure(page, () => page.click('#swap-panel'))).selectors);

  // centerShift ranks these EXACTLY backwards: the same button reads as a big move, the impostor reads
  // as a perfect stay.
  expect(reflow.centerShift!).toBeGreaterThan(falseHeal.centerShift!);
  // The relational reading ranks them the right way round. That inversion is the whole feature.
  expect(reflow.relationalAgreement!).toBeGreaterThan(falseHeal.relationalAgreement!);
  expect(reflow.relationalAgreement!).toBeGreaterThanOrEqual(RELATIONAL_PRESERVED_MIN);
});

test('folds into measuredDurability ADDITIVELY: it recovers the `moved` penalty, never more', async ({
  page,
}) => {
  const withRelational = targetOf(
    (await measure(page, () => page.click('#insert-above'))).selectors,
  );
  await page.goto(RELATIONAL_FIXTURE_URL);
  const without = targetOf(
    (await measure(page, () => page.click('#insert-above'), { relational: false })).selectors,
  );

  // Both are `moved`; only the relational evidence differs. Without it, the plain 30% `moved` penalty.
  expect(without.retention).toBe('moved');
  expect(without.relationalStatus).toBe('disabled');
  expect(without.relationalAgreement).toBeNull();
  expect(without.measuredDurability).toBe(Math.round(without.estimatedDurability * 0.7));

  // With a fully preserved context the penalty is fully recovered — and capped THERE. The snapshot-A
  // estimate is the ceiling: relational agreement can never mint durability the estimate never granted.
  expect(withRelational.retention).toBe('moved');
  expect(withRelational.relationalAgreement).toBe(1);
  expect(withRelational.measuredDurability).toBe(withRelational.estimatedDurability);
  expect(withRelational.measuredDurability).toBeLessThanOrEqual(withRelational.estimatedDurability);

  // And the verdict itself is untouched by the relational reading, in both directions.
  expect(withRelational.retention).toBe(without.retention);
});

test('outside the `moved` band, measuredDurability is numerically unchanged from pre-v1.2', async ({
  page,
}) => {
  // Only the `moved` band folds relational evidence in. A `retained` candidate keeps the exact modest
  // +10 confirmation nudge it had before — including the false-heal case, whose agreement is 0.33.
  // (`flags` DO gain relational entries in every band; it is the SCORE that is unchanged, not the whole
  // record — the false-heal case below carries `relational-context-broken` while scoring as before.)
  const save = targetOf((await measure(page, () => page.click('#swap-panel'))).selectors);
  expect(save.retention).toBe('retained');
  expect(save.measuredDurability).toBe(Math.min(100, save.estimatedDurability + 10));

  // …and across the v1.1 retention fixture, which is the only one that actually produces all five
  // verdicts — including `ambiguous`, which this fixture never generates.
  await page.goto(RETENTION_FIXTURE_URL);
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const scored = await scoreSelectors(page, delta);
  const all = await measureRetention(page, delta, scored, {
    reRender: () => page.click('#rerender'),
  });
  const seen = new Set(all.selectors.map((s) => s.retention));
  expect(seen).toContain('retained');
  expect(seen).toContain('moved');
  expect(seen).toContain('ambiguous');
  expect(seen).toContain('lost');
  expect(seen).toContain('inconclusive');

  for (const s of all.selectors) {
    if (s.retention === 'ambiguous') {
      // Pinned exactly, not just "<= estimate": `round(est * 0.3)` is what shipped in v1.1.
      expect(s.measuredDurability).toBe(Math.round(s.estimatedDurability * 0.3));
    } else if (s.retention === 'retained') {
      expect(s.measuredDurability).toBe(Math.min(100, s.estimatedDurability + 10));
    } else if (s.retention === 'lost') {
      expect(s.measuredDurability).toBe(0);
    } else if (s.retention === 'inconclusive') {
      expect(s.measuredDurability).toBe(s.estimatedDurability);
    } else {
      expect(s.measuredDurability).toBeLessThanOrEqual(s.estimatedDurability);
    }
  }
});

test('`relationalAnchors` bounds K, and the denominator is reported alongside the score', async ({
  page,
}) => {
  const result = await measure(page, () => page.evaluate(() => window.scrollTo(0, 600)), {
    relationalAnchors: 3,
  });
  const save = targetOf(result.selectors);
  expect(save.relationalAnchorsCompared).toBe(3);
  // An agreement of 1 over 3 anchors is weaker evidence than 1 over 6, and the result says which it is.
  expect(save.relationalAgreement).toBe(1);
});

test('degrades honestly: what cannot be measured reports null, never a 0 meaning "destroyed"', async ({
  page,
}) => {
  // The v1.1 retention fixture is deliberately hostile and exercises every degradation at once: a bare
  // <div> outside the salient set (`candidate-unmapped`), a display:none link with a 0x0 box
  // (`candidate-unmeasurable`), and removed/duplicated controls that never re-resolve to one element
  // (`not-re-resolved`). The relational fixture's own transitions are all cleanly measurable, so this
  // case has to be measured where the degradations actually live.
  await page.goto(RETENTION_FIXTURE_URL);
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const scored = await scoreSelectors(page, delta);
  const result = await measureRetention(page, delta, scored, {
    reRender: () => page.click('#rerender'),
  });

  const unmeasured = result.selectors.filter((s) => s.relationalStatus !== 'measured');
  const statuses = new Set(unmeasured.map((s) => s.relationalStatus));
  expect(statuses).toContain('candidate-unmapped'); // the panel <div> is not a salient node
  expect(statuses).toContain('candidate-unmeasurable'); // the display:none "Docs" link has no box
  expect(statuses).toContain('not-re-resolved'); // removed / duplicated controls

  for (const s of unmeasured) {
    // A missing measurement and a broken context are DIFFERENT facts. An unmeasurable candidate must
    // never be handed a 0, which would read as "its context was destroyed" — the same refusal
    // `centerShift` already makes by returning null when boundingBox() does.
    expect(s.relationalAgreement, `${s.code} (${s.relationalStatus})`).toBeNull();
    expect(s.relationalAnchorsCompared).toBe(0);
    expect(s.flags).not.toContain('relational-context-broken');
    expect(s.flags).not.toContain('relational-context-preserved');
  }

  // And every selector that COULD be measured was, so the degradations above are the real exceptions
  // rather than a silently disabled feature.
  expect(result.selectors.length).toBeGreaterThan(unmeasured.length);
});

test('a main-frame root is measured; the guard is about CHILD frames, not the object type', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const scored = await scoreSelectors(page.mainFrame(), delta);
  const result = await measureRetention(page.mainFrame(), delta, scored, {
    reRender: () => page.evaluate(() => window.scrollTo(0, 600)),
  });
  // `page.mainFrame()` is a `Frame`, but it shares the page's document and coordinate space exactly, so
  // refusing it would be a technicality about which object the caller passed.
  expect(targetOf(result.selectors).relationalStatus).toBe('measured');
});

test('HONESTY: the warnings state what the relational signal is, and is not', async ({ page }) => {
  const result = await measure(page, () => page.click('#insert-above'));
  const w = result.warnings.join('\n');

  // It is a second witness, not a replacement, and not a verdict.
  expect(w).toMatch(/ALONGSIDE `centerShift`, not a replacement/);
  expect(w).toMatch(/EVIDENCE, never a verdict/);
  expect(w).toMatch(/never changes `retention`/);
  // Its two load-bearing limits are stated, not buried.
  expect(w).toMatch(/anchors are dropped, never mismatched/);
  expect(w).toMatch(/NOT to reflow within the candidate's own neighbourhood/);
  // The TARGET's context is fully preserved here, so nothing claims otherwise about it. (The page-wide
  // warning may still fire for a different element, and correctly does: <main> itself grew by the
  // inserted banner, so <main>'s own relations to its neighbours really did change. Only elements whose
  // own context changed should score low, and only those do.)
  expect(targetOf(result.selectors).flags).not.toContain('relational-context-broken');
  // The pre-v1.2 caveats are all still there.
  expect(w).toMatch(/MEASURED across the ONE re-render/);
  expect(w).toMatch(/object identity is INFERRED/i);

  // No result object claims the relational reading proves identity.
  for (const s of result.selectors) {
    expect(s).not.toHaveProperty('sameElement');
    expect(s).not.toHaveProperty('identityProven');
  }
});

test('a broken context is NAMED in the warnings — otherwise nothing surfaces it', async ({
  page,
}) => {
  // The relational reading never moves `retention` (DW-02/03), so `retentionRate` and `bestRetained`
  // still count the impostor. A caller reading only those numbers would never learn what the
  // fingerprint saw. The warning is the one place that says it out loud.
  const result = await measure(page, () => page.click('#swap-panel'));
  const save = targetOf(result.selectors);
  expect(save.retention).toBe('retained');
  expect(save.flags).toContain('relational-context-broken');

  const w = result.warnings.join('\n');
  expect(w).toMatch(/BROKEN relational context/);
  // …and a second, WIDER warning names every `retained` candidate whose context did not hold, not just
  // those under the broken bar — otherwise a false heal scoring in the 0.4-0.8 gap between the two
  // thresholds would produce no flag and no warning at all.
  expect(w).toMatch(/measured `retained` on position while their relational context did NOT hold/);
  expect(w).toMatch(/`retentionRate` and `bestRetained` still count them as retained/);
});

test('a REMOUNTED subtree never yields a confidently wrong score (stale `data-dw-map-ref`)', async ({
  page,
}) => {
  // `data-dw-map-ref` is assigned POSITIONALLY (m1..mN, document order) and cleared with a document
  // query that cannot reach a DETACHED subtree — so a card that re-mounts while the snapshot-B scan
  // runs comes back wearing a snapshot-A ref that now names a DIFFERENT element. Before this was
  // checked, that produced a confident `relationalAgreement` of 0.167 and a `relational-context-broken`
  // flag on a page whose DOM was byte-identical to snapshot A.
  const result = await measure(page, () => page.click('#remount'));
  const save = targetOf(result.selectors);

  // The page really is unchanged — position says so unambiguously.
  expect(save.retention).toBe('retained');
  expect(save.centerShift).toBe(0);

  // So the ONLY honest answers are "preserved" or "could not measure". A measured low score here is a
  // fabrication about a different element's neighbourhood.
  if (save.relationalStatus === 'measured') {
    expect(save.relationalAgreement).toBe(1);
  } else {
    expect(save.relationalStatus).toBe('candidate-unmapped');
    expect(save.relationalAgreement).toBeNull();
  }
  expect(save.flags).not.toContain('relational-context-broken');
});

test('`no-anchors`: a fingerprint with nothing to anchor on reports null, not 0', async ({
  page,
}) => {
  // K=0 is the deterministic way to reach the branch; the page-shaped route to it is a candidate whose
  // every salient neighbour lacks a unique (role, name).
  const result = await measure(page, () => page.click('#insert-above'), { relationalAnchors: 0 });
  const save = targetOf(result.selectors);
  expect(save.relationalStatus).toBe('no-anchors');
  expect(save.relationalAgreement).toBeNull();
  expect(save.relationalAnchorsCompared).toBe(0);
  // The verdict and its score are exactly what they would be with the feature off.
  expect(save.retention).toBe('moved');
  expect(save.measuredDurability).toBe(Math.round(save.estimatedDurability * 0.7));
});

test('`page-map-blocked`: a scan that cannot run degrades to pre-v1.2, it does not throw', async ({
  page,
}) => {
  const delta = await actAndObserve(page, (p) => p.click('#go'), { label: 'build' });
  const scored = await scoreSelectors(page, delta);
  // Stand in for a strict CSP / a detached page: the observer is present but its scan cannot complete.
  await page.evaluate(() => {
    (window as unknown as { __deltawright: { scan: () => never } }).__deltawright.scan = () => {
      throw new Error('scan unavailable');
    };
  });
  const result = await measureRetention(page, delta, scored, {
    reRender: () => page.click('#insert-above'),
  });

  const save = targetOf(result.selectors);
  expect(save.relationalStatus).toBe('page-map-blocked');
  expect(save.relationalAgreement).toBeNull();
  // Everything that worked before v1.2 still works — the relational read is additional evidence and
  // must never be able to break the measurement it was added to.
  expect(save.retention).toBe('moved');
  expect(save.centerShift).toBeGreaterThan(250);
  expect(save.measuredDurability).toBe(Math.round(save.estimatedDurability * 0.7));
  expect(result.warnings.join('\n')).toMatch(/salient page map could not be read/);
});

test.describe('a CHILD frame stands down rather than comparing two coordinate spaces', () => {
  const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
  let server: StaticServer;

  // Served over HTTP so parent and child share an origin (file:// iframes are cross-origin in Chromium).
  test.beforeAll(async () => {
    server = await startStaticServer(fixturesDir);
  });
  test.afterAll(async () => {
    await server.close();
  });

  test('reports frame-root and says so in the warnings', async ({ page }) => {
    await page.goto(`${server.origin}/iframe.html`);
    await page.frameLocator('#f').locator('body').waitFor({ timeout: 3000 });
    const delta = await actAndObserve(page, (p) => p.click('#open'), {
      label: 'open in iframe',
      frames: true,
    });
    const child = page.frames().find((f) => f !== page.mainFrame())!;
    const scored = await scoreSelectors(child, delta);
    const result = await measureRetention(child, delta, scored, {});

    // `pageMap()` scans the main document; a child frame's rects are in the frame's own space. Anchoring
    // one against the other would manufacture relations that were never there, so nothing is measured.
    const w = result.warnings.join('\n');
    expect(w).toMatch(/`root` is a child Frame.*stood down/s);
    // …and the caller is not simultaneously told a relational reading was taken.
    expect(w).not.toMatch(/ALONGSIDE `centerShift`, not a replacement/);
    for (const s of result.selectors) {
      expect(s.relationalStatus).toBe('frame-root');
      expect(s.relationalAgreement).toBeNull();
    }
  });
});
