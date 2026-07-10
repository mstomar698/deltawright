import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { recordFromSidecar, aggregate, toJSONL, readSidecars } from '../src/aggregate';
import { ROOT_CAUSE_TAXONOMY } from '../src/index';

// Flake-priority aggregator (#59). Pure core over parsed side-cars + an fs ingest across run dirs.

function sidecar(over: Record<string, unknown> = {}) {
  return {
    test: 'suite > a test',
    status: 'failed',
    source: 'error-text',
    cause: 'disabled',
    confidence: 'confirmed',
    detail: 'x',
    detached: false,
    lateWave: false,
    staleRect: false,
    diagnoses: [{ code: 'disabled', confidence: 'confirmed', scope: 'delta', detail: '' }],
    ...over,
  };
}

/** Write a side-car JSON file into a run dir; returns the run dir. */
function writeSidecar(runDir: string, name: string, obj: Record<string, unknown>): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(resolve(runDir, `${name}.deltawright-sidecar.json`), JSON.stringify(obj, null, 2));
}

test('should_ingest_sidecar_artifacts_across_runs_and_rank_by_flake_frequency_and_category', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'dw-agg-'));
  // run-1: testA fails twice (disabled, covered) + testB once (off-screen). run-2: testA once.
  writeSidecar(resolve(root, 'run-1'), 'a1', sidecar({ test: 'A', cause: 'disabled' }));
  writeSidecar(
    resolve(root, 'run-1'),
    'a2',
    sidecar({
      test: 'A',
      cause: 'covered-by-overlay',
      diagnoses: [
        { code: 'covered-by-overlay', confidence: 'confirmed', scope: 'node', detail: '' },
      ],
    }),
  );
  writeSidecar(
    resolve(root, 'run-1'),
    'b1',
    sidecar({
      test: 'B',
      cause: 'off-screen',
      diagnoses: [{ code: 'off-screen', confidence: 'confirmed', scope: 'node', detail: '' }],
    }),
  );
  writeSidecar(resolve(root, 'run-2'), 'a3', sidecar({ test: 'A', cause: 'disabled' }));

  const records = readSidecars([root]);
  expect(records.length).toBe(4);
  // runId is the containing dir's basename → two distinct runs.
  expect(new Set(records.map((r) => r.runId))).toEqual(new Set(['run-1', 'run-2']));

  const report = aggregate(records);
  // Most-flaky first: A (3 failures across 2 runs) ranks above B (1).
  expect(report.tests[0]!.testId).toBe('A');
  expect(report.tests[0]!.failures).toBe(3);
  expect(report.tests[0]!.runs).toBe(2);
  // A's dominant category is disabled/covered's category.
  expect(report.tests[0]!.dominantCategory).toBe(ROOT_CAUSE_TAXONOMY['disabled'].category);
  expect(report.tests[1]!.testId).toBe('B');
});

test('should_bucket_unsure_diagnoses_separately', () => {
  const records = [
    recordFromSidecar(sidecar({ test: 'T', cause: 'disabled' }), 'run-1')!,
    recordFromSidecar(
      sidecar({ test: 'T', cause: 'unsure', confidence: 'unknown', diagnoses: [] }),
      'run-1',
    )!,
    recordFromSidecar(
      sidecar({ test: 'T', cause: 'unsure', confidence: 'unknown', diagnoses: [] }),
      'run-2',
    )!,
  ];
  // unsure carries no category.
  expect(records[1]!.category).toBeNull();

  const report = aggregate(records);
  const t = report.tests[0]!;
  // The 2 unsure records are bucketed apart and do NOT inflate any taxonomy category.
  expect(t.unsure).toBe(2);
  expect(report.unsureBucket).toBe(2);
  const categoryTotal = Object.values(t.categories).reduce((a, b) => a + b, 0);
  expect(categoryTotal).toBe(1); // only the single `disabled` record
  expect(t.dominantCategory).toBe(ROOT_CAUSE_TAXONOMY['disabled'].category);
});

test('should_bucket_the_taxonomy_first_class_unknown_code_apart_not_as_a_real_category', () => {
  // `unknown` IS a taxonomy code, but it is the first-class "unsure" outcome (category `unknown`).
  // It must be bucketed apart like `unsure`, NOT surfaced as a real `unknown` category — else the
  // honesty guarantee ("unsure never inflates a real category") leaks for exactly the foreign/old
  // artifacts this is meant to degrade over.
  expect(ROOT_CAUSE_TAXONOMY['unknown'].category).toBe('unknown'); // the trap: a truthy category
  const rec = recordFromSidecar(
    sidecar({
      test: 'U',
      cause: 'unknown',
      confidence: 'unknown',
      diagnoses: [{ code: 'unknown', confidence: 'unknown', scope: 'delta', detail: '' }],
    }),
    'run-1',
  )!;
  expect(rec.category).toBeNull();

  const report = aggregate([rec]);
  expect(report.unsureBucket).toBe(1);
  expect(report.tests[0]!.unsure).toBe(1);
  expect(report.tests[0]!.dominantCategory).toBeNull();
  expect(Object.keys(report.tests[0]!.categories)).toHaveLength(0);
});

test('readSidecars dedups overlapping input dirs and survives a symlink cycle (no multi-count)', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'dw-agg3-'));
  writeSidecar(resolve(root, 'run-1'), 's1', sidecar({ test: 'D', cause: 'disabled' }));
  writeSidecar(resolve(root, 'run-1'), 's2', sidecar({ test: 'D', cause: 'disabled' }));

  // Overlapping inputs: the parent dir already covers run-1, so passing both must NOT double-count.
  const overlap = readSidecars([root, resolve(root, 'run-1')]);
  expect(overlap.length).toBe(2);

  // A symlink cycle inside the tree (a realistic CI `latest -> .` link) must not multiply counts.
  try {
    symlinkSync(root, resolve(root, 'run-1', 'loop'));
  } catch {
    return; // platform without symlink support (e.g. Windows CI) — the overlap assertion suffices
  }
  const cycled = readSidecars([root]);
  expect(cycled.length).toBe(2); // still just the two real files, not an inflated count
});

test('should_be_read_only_and_degrade_gracefully_when_the_taxonomy_is_absent', () => {
  // Read-only: the module writes nothing. Broad grep so a future write via ANY common fs mutator
  // (sync or async, promises or streams) trips the guard — not just the handful we happen to use.
  const src = readFileSync(resolve(process.cwd(), 'src/aggregate/index.ts'), 'utf8');
  expect(src).not.toMatch(
    /\b(write|writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|truncate|truncateSync|open|openSync|createWriteStream|cp|cpSync|copyFile|copyFileSync|chmod|chmodSync|symlink|symlinkSync|link|linkSync|utimes|utimesSync)\s*\(/,
  );

  // Degrade: a side-car with a foreign / untaxonomized cause → no category (bucketed unsure), no crash.
  const foreign = recordFromSidecar(sidecar({ test: 'T', cause: 'not-a-real-code' }), 'run-1')!;
  expect(foreign.category).toBeNull();

  // A non-side-car object → skipped (null), not guessed.
  expect(recordFromSidecar({ hello: 'world' }, 'run-1')).toBeNull();
  expect(recordFromSidecar(null, 'run-1')).toBeNull();

  const report = aggregate([foreign]);
  expect(report.tests[0]!.dominantCategory).toBeNull();
  expect(report.tests[0]!.unsure).toBe(1);
  expect(report.unsureBucket).toBe(1);
});

test('readSidecars skips missing dirs and unparseable files; settle-cap + disagreement derive from diagnoses', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'dw-agg2-'));
  writeSidecar(
    resolve(root, 'run-1'),
    'capped',
    sidecar({
      test: 'C',
      cause: 'disabled',
      diagnoses: [
        { code: 'disabled', confidence: 'confirmed', scope: 'delta', detail: '' },
        { code: 'settle-timeout', confidence: 'suspected', scope: 'delta', detail: '' },
        { code: 'geom-disagreement', confidence: 'suspected', scope: 'node', detail: '' },
      ],
    }),
  );
  // an unparseable file in the same dir is skipped, not fatal.
  mkdirSync(resolve(root, 'run-1'), { recursive: true });
  writeFileSync(resolve(root, 'run-1', 'junk.deltawright-sidecar.json'), '{ not json');

  const records = readSidecars([root, resolve(root, 'does-not-exist')]);
  expect(records.length).toBe(1);
  expect(records[0]!.hitMaxWait).toBe(true); // derived from the settle-timeout diagnosis
  expect(records[0]!.disagreement).toBe(true); // derived from the geom-disagreement diagnosis

  // JSONL: one parseable JSON object per line.
  const jsonl = toJSONL(records);
  expect(jsonl.split('\n').length).toBe(1);
  expect(JSON.parse(jsonl).testId).toBe('C');
});
