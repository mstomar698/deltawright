import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { matchDeltaChecksum } from '../src/matchers/checksum';
import type { Delta, DeltaNode } from '../src/index';

// Delta checksum regression matcher (#54). Exercises the PURE core (browser-free, tmp baseline dir),
// which is exactly the matcher's behavior — the thin `expect(delta).toMatchDeltaChecksum(id)` wrapper
// only resolves the baseline path + update mode from the test context.

function node(over: Partial<DeltaNode> = {}, geomOver = {}, actOver = {}): DeltaNode {
  return {
    ref: 'e1',
    kind: 'added',
    tag: 'button',
    role: 'button',
    name: 'Submit',
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
      ...geomOver,
    },
    actionability: {
      verdict: 'ACTIONABLE',
      reason: null,
      geometryVerdict: 'ACTIONABLE',
      playwright: { actionable: true },
      agreed: true,
      ...actOver,
    },
    ...over,
  };
}

function delta(nodes: DeltaNode[], statsOver = {}): Delta {
  return {
    action: 'click "Submit"',
    nodes,
    stats: {
      rawRecords: 2,
      settleMs: 130,
      hitMaxWait: false,
      animationsAwaited: 0,
      droppedBackground: 0,
      ...statsOver,
    },
  };
}

function tmpBaseline(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'dw-checksum-'));
  return resolve(dir, 'nested', 'case.json'); // nested → also proves mkdir -p
}

test('should_write_a_baseline_on_first_run_and_render_a_structural_diff_on_mismatch', () => {
  const file = tmpBaseline();
  const base = delta([node()]);

  // First run: no baseline → write it and pass.
  const first = matchDeltaChecksum(base, file);
  expect(first.pass).toBe(true);
  expect(first.written).toBe(true);
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, 'utf8').trim().length).toBeGreaterThan(0);

  // A real change (verdict flip) → fail, with a structural (+/-) diff naming the verdict.
  const changed = matchDeltaChecksum(delta([node({}, {}, { verdict: 'NOT-actionable' })]), file);
  expect(changed.pass).toBe(false);
  expect(changed.written).toBe(false);
  const msg = changed.message();
  expect(msg).toContain('structural diff');
  expect(msg).toMatch(/^[-+] /m); // at least one added/removed line
  expect(msg).toContain('NOT-actionable'); // the changed verdict shows in the diff
});

test('should_match_across_pixel_and_timing_jitter_but_fail_on_a_verdict_or_tree_change', () => {
  const file = tmpBaseline();
  matchDeltaChecksum(delta([node()]), file); // seed the baseline

  // Pixel jitter (within the same size bucket) + timing jitter + reason text → still MATCHES, because
  // the normalized fingerprint drops raw rects/timing/reason.
  const jittered = matchDeltaChecksum(
    delta([node({}, { rect: { x: 13, y: 8, width: 84, height: 33 } })], {
      settleMs: 411,
      rawRecords: 9,
      animationsAwaited: 3,
    }),
    file,
  );
  expect(jittered.pass).toBe(true);
  expect(jittered.written).toBe(false);

  // A verdict change → FAILS.
  expect(matchDeltaChecksum(delta([node({}, {}, { verdict: 'NOT-actionable' })]), file).pass).toBe(
    false,
  );

  // A tree change (an added child node) → FAILS.
  const withChild = delta([node(), node({ ref: 'e2', name: 'Cancel', parentRef: 'e1' })]);
  expect(matchDeltaChecksum(withChild, file).pass).toBe(false);
});

test('should_document_a_match_is_regression_only_not_fidelity', () => {
  const file = tmpBaseline();
  const wrote = matchDeltaChecksum(delta([node()]), file);
  const matched = matchDeltaChecksum(delta([node()]), file);
  const missed = matchDeltaChecksum(delta([node({}, {}, { verdict: 'NOT-actionable' })]), file);

  // Every outcome carries the regression-only honesty note (a green checksum ≠ fidelity/correctness).
  for (const m of [wrote.message(), matched.message(), missed.message()]) {
    expect(m).toContain('REGRESSION-ONLY');
    expect(m).toMatch(/not that the delta is correct|models a real app/i);
  }
});

test('update mode rewrites an existing baseline and passes', () => {
  const file = tmpBaseline();
  matchDeltaChecksum(delta([node()]), file); // baseline = ACTIONABLE
  const changed = delta([node({}, {}, { verdict: 'NOT-actionable' })]);

  // Without update → fails; with update → rewrites and passes, and the new baseline now matches.
  expect(matchDeltaChecksum(changed, file).pass).toBe(false);
  const updated = matchDeltaChecksum(changed, file, { update: true });
  expect(updated.pass).toBe(true);
  expect(updated.written).toBe(true);
  expect(matchDeltaChecksum(changed, file).pass).toBe(true);
});

test('failOnMissing (CI) writes a missing baseline but FAILS, so an unestablished baseline cannot green', () => {
  const base = delta([node()]);

  // CI semantics: a missing baseline is WRITTEN but the run FAILS (commit + re-run) — no silent green.
  const ci = matchDeltaChecksum(base, tmpBaseline(), { failOnMissing: true });
  expect(ci.written).toBe(true);
  expect(ci.pass).toBe(false);
  expect(ci.message()).toContain('commit it and re-run');

  // An explicit update still passes even in CI (intentional first write).
  const ciUpdate = matchDeltaChecksum(base, tmpBaseline(), { failOnMissing: true, update: true });
  expect(ciUpdate.pass).toBe(true);

  // Local default (failOnMissing off) writes + passes on first run, jest-style.
  const local = matchDeltaChecksum(base, tmpBaseline());
  expect(local.pass).toBe(true);
  expect(local.written).toBe(true);
});
