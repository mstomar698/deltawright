import { test, expect } from '@playwright/test';
import {
  triageFailure,
  coarseSignature,
  DELTA_ATTACHMENT_NAME,
  type TriageInput,
} from '../src/reporter/triage';
import { clusterByCause, type FlakeRecord } from '../src/aggregate';
import type { Delta, DeltaNode } from '../src/host/types';

// Triage T1: cross-test cause-clustering keyed on (taxonomy code × delta fingerprint). Two halves:
// (1) the side-car now persists a fingerprint; (2) clusterByCause groups a corpus on it.

const input = (over: Partial<TriageInput>): TriageInput => ({
  status: 'failed',
  title: 'suite > a test',
  errorMessages: [],
  attachments: [],
  ...over,
});

function coveredNode(over: Partial<DeltaNode> = {}): DeltaNode {
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
      hitSelf: false,
      coveredBy: 'div.overlay',
      offscreen: false,
    },
    actionability: {
      verdict: 'NOT-actionable',
      reason: 'covered-by div.overlay',
      geometryVerdict: 'NOT-actionable',
      playwright: { actionable: false, error: 'covered (intercepted)' },
      agreed: true,
    },
    ...over,
  };
}

const coveredDelta = (): Delta => ({
  action: 'submit',
  nodes: [coveredNode()],
  stats: { hitMaxWait: false } as Delta['stats'],
});

const deltaAttachment = (delta: Delta): TriageInput['attachments'] => [
  { name: DELTA_ATTACHMENT_NAME, contentType: 'application/json', body: JSON.stringify(delta) },
];

// --- (1) fingerprint persistence ------------------------------------------------------------------

test('a passive side-car carries a COARSE fingerprint (cause + diagnosis codes + flags), stable across identical inputs', () => {
  const a = triageFailure(input({ errorMessages: ['element is not enabled'] }))!;
  const b = triageFailure(input({ errorMessages: ['element is not enabled'] }))!;
  expect(a.fingerprintSource).toBe('coarse');
  expect(a.fingerprint).toBe(b.fingerprint); // deterministic
  expect(a.fingerprint.startsWith(a.cause)).toBe(true); // cause is the level-1 partition
  // coarseSignature is the shared helper — matches what the side-car computed.
  expect(a.fingerprint).toBe(
    coarseSignature(
      a.cause,
      a.diagnoses.map((d) => d.code),
      { detached: a.detached, lateWave: a.lateWave, staleRect: a.staleRect },
    ),
  );
});

test('a rich (delta-attachment) side-car carries a DELTA fingerprint (structural checksum), stable across identical deltas', () => {
  const a = triageFailure(input({ attachments: deltaAttachment(coveredDelta()) }))!;
  const b = triageFailure(input({ attachments: deltaAttachment(coveredDelta()) }))!;
  expect(a.fingerprintSource).toBe('delta');
  expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  expect(a.fingerprint).toBe(b.fingerprint); // same structure → same fingerprint
});

// --- (2) clusterByCause ---------------------------------------------------------------------------

let refN = 0;
function rec(over: Partial<FlakeRecord> = {}): FlakeRecord {
  return {
    testId: `test-${refN++}`,
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
    fingerprint: 'FP-A',
    fingerprintSource: 'delta',
    diagnoses: [{ code: 'covered-by-overlay', confidence: 'suspected', scope: 'node', detail: '' }],
    ...over,
  };
}

test('collapses same-code + same-fingerprint failures across tests into ONE cluster with a blast radius', () => {
  const { clusters } = clusterByCause([
    rec({ testId: 'A', fingerprint: 'FP-A' }),
    rec({ testId: 'B', fingerprint: 'FP-A' }),
    rec({ testId: 'C', fingerprint: 'FP-A' }),
  ]);
  expect(clusters).toHaveLength(1);
  expect(clusters[0]!.code).toBe('covered-by-overlay');
  expect(clusters[0]!.blastRadius).toBe(3); // 3 distinct tests → fix-once-fix-many
  expect(clusters[0]!.failures).toBe(3);
  expect(clusters[0]!.tests).toEqual(['A', 'B', 'C']);
});

test('never merges two different taxonomy codes, even with the same fingerprint (anti-over-group firewall)', () => {
  const { clusters } = clusterByCause([
    rec({ testId: 'A', code: 'covered-by-overlay', fingerprint: 'SAME' }),
    rec({ testId: 'B', code: 'disabled', fingerprint: 'SAME', category: 'actionability-blocking' }),
  ]);
  expect(clusters).toHaveLength(2);
  expect(new Set(clusters.map((c) => c.code))).toEqual(new Set(['covered-by-overlay', 'disabled']));
});

test('splits same code with different fingerprints into separate sub-clusters (anti-under-group)', () => {
  const { clusters } = clusterByCause([
    rec({ testId: 'A', fingerprint: 'FP-A' }),
    rec({ testId: 'B', fingerprint: 'FP-B' }),
  ]);
  expect(clusters).toHaveLength(2);
});

test('NEVER clusters unsure records — each stays a singleton routed to a human', () => {
  const { clusters, unsure } = clusterByCause([
    rec({ testId: 'A', code: 'unsure', category: null }),
    rec({ testId: 'B', code: 'unsure', category: null }),
    rec({ testId: 'C' }), // one real cause
  ]);
  expect(clusters).toHaveLength(1); // only the real cause clustered
  expect(clusters[0]!.code).toBe('covered-by-overlay');
  expect(unsure).toHaveLength(2); // the two unsure records, apart, never merged
});

test('ranks clusters by blast radius (highest-leverage fix first)', () => {
  const { clusters } = clusterByCause([
    // a 1-test cluster …
    rec({ testId: 'X', code: 'disabled', category: 'actionability-blocking', fingerprint: 'D' }),
    // … and a 2-test cluster that must rank ABOVE it.
    rec({ testId: 'A', code: 'covered-by-overlay', fingerprint: 'C' }),
    rec({ testId: 'B', code: 'covered-by-overlay', fingerprint: 'C' }),
  ]);
  expect(clusters[0]!.blastRadius).toBe(2);
  expect(clusters[0]!.code).toBe('covered-by-overlay');
  expect(clusters[1]!.blastRadius).toBe(1);
});

test('an old side-car with no fingerprint still clusters via a recomputed coarse key', () => {
  const { clusters } = clusterByCause([
    rec({ testId: 'A', fingerprint: '', fingerprintSource: 'none' }),
    rec({ testId: 'B', fingerprint: '', fingerprintSource: 'none' }),
  ]);
  expect(clusters).toHaveLength(1); // recomputed coarse key (code + diagnosis codes + flags) collapses them
  expect(clusters[0]!.fingerprintSource).toBe('coarse');
  expect(clusters[0]!.blastRadius).toBe(2);
});
