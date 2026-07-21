import { test, expect } from '@playwright/test';
import {
  clusterByCause,
  prioritize,
  renderPriorityQueue,
  renderHtml,
  aggregate,
  type FlakeRecord,
} from '../src/aggregate';

// Reporting A: the Actionability Priority queue — rank clusters by shared-cause blast radius ×
// confidence (decomposed, no opaque score), with `unsure` in its own human-triage lane.

let n = 0;
function rec(over: Partial<FlakeRecord> = {}): FlakeRecord {
  return {
    testId: `t-${n++}`,
    runId: 'run-1',
    code: 'covered-by-overlay',
    confidence: 'suspected',
    category: 'actionability-blocking',
    hitMaxWait: false,
    disagreement: false,
    detached: false,
    lateWave: false,
    staleRect: false,
    detail: 'covered',
    source: 'delta-attachment',
    fingerprint: 'FP',
    fingerprintSource: 'delta',
    diagnoses: [{ code: 'covered-by-overlay', confidence: 'suspected', scope: 'node', detail: '' }],
    ...over,
  };
}

// R = 3 tests (suspected); Q = 2 tests (confirmed); P = 2 tests (suspected); plus one unsure.
const corpus = (): FlakeRecord[] => [
  rec({ testId: 'r1', code: 'off-screen', fingerprint: 'R' }),
  rec({ testId: 'r2', code: 'off-screen', fingerprint: 'R' }),
  rec({ testId: 'r3', code: 'off-screen', fingerprint: 'R' }),
  rec({ testId: 'q1', code: 'disabled', fingerprint: 'Q', confidence: 'confirmed' }),
  rec({ testId: 'q2', code: 'disabled', fingerprint: 'Q', confidence: 'confirmed' }),
  rec({ testId: 'p1', code: 'covered-by-overlay', fingerprint: 'P' }),
  rec({ testId: 'p2', code: 'covered-by-overlay', fingerprint: 'P' }),
  rec({ testId: 'u1', code: 'unsure', category: null }),
];

test('ranks by blast radius PRIMARY, then confidence SECONDARY', () => {
  const { rows, humanLane } = prioritize(clusterByCause(corpus()));

  // #1 = the 3-test cluster (highest blast radius), regardless of its suspected confidence.
  expect(rows[0]!.code).toBe('off-screen');
  expect(rows[0]!.blastRadius).toBe(3);
  expect(rows[0]!.rank).toBe(1);

  // #2 vs #3: same blast radius (2) → the CONFIRMED cluster ranks above the suspected one.
  expect(rows[1]!.code).toBe('disabled');
  expect(rows[1]!.confidence).toBe('confirmed');
  expect(rows[2]!.code).toBe('covered-by-overlay');
  expect(rows[2]!.confidence).toBe('suspected');

  // ranks are 1-based and sequential.
  expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  // the unsure failure is in its own lane, NOT a ranked row.
  expect(humanLane).toHaveLength(1);
  expect(rows.some((r) => r.code === ('unsure' as unknown))).toBe(false);
});

test('the rank is DECOMPOSED — rows expose their axes, never a single opaque score', () => {
  const { rows } = prioritize(clusterByCause(corpus()));
  for (const r of rows) {
    expect(r).toHaveProperty('blastRadius');
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('failures');
    // no opaque composite score is exposed.
    expect(r).not.toHaveProperty('score');
    expect(r).not.toHaveProperty('priority');
  }
});

test('renderPriorityQueue surfaces the human-triage lane and decomposed rows', () => {
  const text = renderPriorityQueue(prioritize(clusterByCause(corpus())));
  expect(text).toMatch(/human-triage lane .*route to a human/);
  expect(text).toMatch(/#1 .*off-screen/);
  expect(text).toMatch(/blast radius × confidence.*decomposed/);
  expect(text).toMatch(/HIGHEST band/); // the confidence-is-max disclosure (review fix)
});

test('the HTML dashboard leads with the Fix-first panel when a priority queue is supplied', () => {
  const records = corpus();
  const withPriority = renderHtml(aggregate(records), prioritize(clusterByCause(records)));
  expect(withPriority).toContain('Fix first — priority by shared root cause');
  expect(withPriority).toContain('off-screen');
  expect(withPriority).toMatch(/fix-once-fix-many candidate/);
  // The panel is OMITTED when no priority queue is passed (backward compatible).
  const withoutPriority = renderHtml(aggregate(records));
  expect(withoutPriority).not.toContain('Fix first — priority by shared root cause');
});

test('HONESTY: unsure is never scored as a cause — an all-unsure corpus yields an empty queue + a full human lane', () => {
  const { rows, humanLane } = prioritize(
    clusterByCause([
      rec({ testId: 'a', code: 'unsure', category: null }),
      rec({ testId: 'b', code: 'unsure', category: null }),
    ]),
  );
  expect(rows).toHaveLength(0);
  expect(humanLane).toHaveLength(2);
});
