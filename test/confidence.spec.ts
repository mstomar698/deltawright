import { test, expect } from '@playwright/test';
import {
  assessConfidence,
  atLeastAsConfident,
  CONFIDENCE_ORDER,
  type EvidenceSource,
} from '../src/host/confidence';

// The shared Confidence primitive (#47). "Unsure beats confidently wrong": these tests pin
// the three DW-03 rules — unsure on thin evidence, never over-claim geometry/timing, and
// downgrade on conflict.

const ALL_SOURCES: readonly EvidenceSource[] = [
  'playwright',
  'geometry+playwright',
  'geometry',
  'timing',
  'none',
];

test('should_emit_unsure_when_evidence_is_insufficient', () => {
  // No grounding signal fired → unknown/unsure, regardless of the conflict flag.
  expect(assessConfidence({ source: 'none' })).toBe('unknown');
  expect(assessConfidence({ source: 'none', conflicting: true })).toBe('unknown');
});

test('should_never_present_geometry_only_or_timing_only_as_confirmed', () => {
  // A geometry-only or timing-only read is inherently a hypothesis — it can never be
  // `confirmed`, with or without conflict.
  for (const source of ['geometry', 'timing'] as const) {
    expect(assessConfidence({ source })).toBe('suspected');
    expect(assessConfidence({ source }), `${source} must not be confirmed`).not.toBe('confirmed');
    expect(assessConfidence({ source, conflicting: true })).not.toBe('confirmed');
  }
  // Only an authoritative engine (or a geometry+Playwright agreement) earns `confirmed`.
  expect(assessConfidence({ source: 'playwright' })).toBe('confirmed');
  expect(assessConfidence({ source: 'geometry+playwright' })).toBe('confirmed');
});

test('should_downgrade_confidence_when_signals_conflict', () => {
  // Conflict drops exactly one notch — authoritative → suspected, hypothesis → unsure.
  expect(assessConfidence({ source: 'playwright' })).toBe('confirmed');
  expect(assessConfidence({ source: 'playwright', conflicting: true })).toBe('suspected');
  expect(assessConfidence({ source: 'geometry' })).toBe('suspected');
  expect(assessConfidence({ source: 'geometry', conflicting: true })).toBe('unknown');

  // Conflict never UPGRADES: for every source, the conflicting result is no stronger.
  for (const source of ALL_SOURCES) {
    const base = assessConfidence({ source });
    const conflicted = assessConfidence({ source, conflicting: true });
    expect(atLeastAsConfident(base, conflicted), `${source}: conflict must not upgrade`).toBe(true);
  }

  // Sanity: the ordering helper is monotonic over the declared bands.
  expect(CONFIDENCE_ORDER).toEqual(['confirmed', 'suspected', 'unknown']);
  expect(atLeastAsConfident('confirmed', 'suspected')).toBe(true);
  expect(atLeastAsConfident('unknown', 'confirmed')).toBe(false);
});
