import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT_CAUSE_TAXONOMY,
  ROOT_CAUSE_CODES,
  PRIMITIVE_SIGNALS,
  rootCauseSpec,
  toRootCauseCode,
  type RootCauseCategory,
} from '../src/host/taxonomy';

// The canonical closed root-cause taxonomy (#46). These tests enforce the three
// properties that keep it "one accurate vocabulary": closed, grounded, and governed.

const CATEGORIES: readonly RootCauseCategory[] = [
  'actionability-blocking',
  'verdict-disagreement',
  'membership-attribution',
  'capture-integrity',
  'fallback',
  'unknown',
];

test('should_map_every_diagnosis_to_a_defined_code_or_unknown', () => {
  // `unknown` is the first-class catch-all: any string that is not a defined code maps to
  // it, and any defined code maps to itself. So EVERY diagnosis lands on a defined code.
  expect(ROOT_CAUSE_CODES).toContain('unknown');
  expect(toRootCauseCode('disabled')).toBe('disabled');
  expect(toRootCauseCode('not-a-real-code')).toBe('unknown');
  expect(toRootCauseCode('')).toBe('unknown');
  expect(rootCauseSpec('covered-by-overlay')?.code).toBe('covered-by-overlay');
  expect(rootCauseSpec('not-a-real-code')).toBeUndefined();

  // Table integrity: each entry's code equals its key, and its category is in the closed set.
  for (const [key, spec] of Object.entries(ROOT_CAUSE_TAXONOMY)) {
    expect(spec.code, `entry ${key} code matches its key`).toBe(key);
    expect(CATEGORIES, `${key} has a defined category`).toContain(spec.category);
  }

  // Every declared category is actually used (no dead buckets) and vice versa.
  const used = new Set(Object.values(ROOT_CAUSE_TAXONOMY).map((s) => s.category));
  expect([...used].sort()).toEqual([...CATEGORIES].sort());
});

test('should_ground_each_code_in_a_real_primitive_signal', () => {
  const known = new Set<string>(PRIMITIVE_SIGNALS);

  for (const [key, spec] of Object.entries(ROOT_CAUSE_TAXONOMY)) {
    // Grounded: at least one signal, each drawn from the closed primitive-signal set, and
    // non-empty human meaning + grounding gloss (no vague/ungrounded code).
    expect(spec.signals.length, `${key} names >=1 grounding signal`).toBeGreaterThan(0);
    for (const sig of spec.signals) {
      expect(known.has(sig), `${key} signal "${sig}" is a real primitive signal`).toBe(true);
    }
    expect(spec.meaning.trim().length, `${key} has a meaning`).toBeGreaterThan(0);
    expect(spec.grounding.trim().length, `${key} has a grounding gloss`).toBeGreaterThan(0);

    // `catch-all` is reserved for `unknown` alone — every other code is really grounded.
    if (key === 'unknown') {
      expect(spec.signals).toContain('catch-all');
    } else {
      expect(spec.signals, `${key} does not use the reserved catch-all`).not.toContain('catch-all');
    }
  }
});

test('should_require_an_adr_and_corpus_relabel_to_add_or_rename_a_code', () => {
  // DW-04 gate. This frozen hash locks the exact code set. If it fails you added, removed,
  // or renamed a code — which per DW-04 requires, IN ORDER: (1) an ADR, (2) a corpus
  // relabel (bench/flake-corpus, #51), (3) an accuracy-harness re-run (#52). Updating this
  // constant is the DELIBERATE LAST step, not a quick fix to make the test green.
  const FROZEN_TAXONOMY_SHA = '5b74394545f5e8716e55d9574ec5b421cb2d6b04c37809885852dc31a4fe1756';
  const sorted = [...ROOT_CAUSE_CODES].sort();
  const sha = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  expect(sha, 'taxonomy code set changed — see DW-04 before updating this lock').toBe(
    FROZEN_TAXONOMY_SHA,
  );

  // Doc <-> code sync: the canonical spec must document every code, so the vocabulary and
  // its human contract cannot drift apart.
  const specPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../docs/specs/v0.6-root-cause-taxonomy.md',
  );
  const spec = readFileSync(specPath, 'utf8');
  for (const code of ROOT_CAUSE_CODES) {
    expect(spec.includes(`\`${code}\``), `spec documents \`${code}\``).toBe(true);
  }
});
