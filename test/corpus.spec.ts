import { test, expect } from '@playwright/test';
import { ROOT_CAUSE_CODES } from '../src/index';
import {
  CORPUS,
  positiveCases,
  confuserCases,
  codesWithoutPositive,
  codesWithoutConfuser,
  oracleViolations,
} from '../bench/flake-corpus/load';

// The labeled flake corpus (#51). These enforce the three properties that make it valid ground
// truth: full per-code coverage, a mandatory near-miss confuser per code, and independent
// oracles (never a stored Deltawright output). Scoring the engine against it is #52.

test('should_label_at_least_one_fixture_per_taxonomy_code', () => {
  const missing = codesWithoutPositive();
  expect(missing, `codes with no positive case: ${missing.join(', ')}`).toEqual([]);
  // Every positive case's manifest code is a real taxonomy code.
  for (const c of positiveCases()) {
    expect(ROOT_CAUSE_CODES, `${c.id} labels an undefined code ${c.code}`).toContain(c.code);
  }
});

test('should_require_a_near_miss_confuser_case_per_code', () => {
  const missing = codesWithoutConfuser();
  expect(missing, `codes with no near-miss confuser: ${missing.join(', ')}`).toEqual([]);
  // Every confuser names the code it resembles, and that code is real.
  for (const c of confuserCases()) {
    expect(c.confusesWith, `${c.id} is a confuser without confusesWith`).toBeDefined();
    expect(ROOT_CAUSE_CODES).toContain(c.confusesWith!);
  }
});

test('should_load_ground_truth_from_independent_oracles_not_stored_dw_output', () => {
  // Every case carries a construction-manifest oracle plus an independent reality anchor
  // (real Playwright verdict / window.__truth / a hand-built delta) — and NO stored DW output.
  const violations = oracleViolations();
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);

  // The schema itself has no field for a stored diagnosis, and no case smuggles one in.
  for (const c of CORPUS) {
    expect('diagnosis' in c || 'predicted' in c || 'dwOutput' in c).toBe(false);
    expect(c.code).toBeDefined();
    expect(c.confidence).toBeDefined();
  }
  // A seed of meaningful size (>= 30 cases, per the plan).
  expect(CORPUS.length).toBeGreaterThanOrEqual(30);
});
