import { readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ROOT_CAUSE_TAXONOMY, type RootCauseCategory, type RootCauseCode } from '../host/taxonomy';
import type { Confidence } from '../host/confidence';

// Flake-priority aggregator (#59) — `deltawright/aggregate` (+ the `deltawright aggregate` bin). A
// READ-ONLY pass over the #55 reporter's side-car artifacts (`*.deltawright-sidecar.json`) across
// runs → a JSONL stream + a ranked summary: which tests fail most, under which dominant taxonomy
// CATEGORY, and at what settle-cap / geometry-disagreement rate. It writes nothing.
//
// HONESTY: `unsure` (and any untaxonomized code) is bucketed SEPARATELY and NEVER inflates a real
// taxonomy category — silence beats a confidently-wrong category. Missing/foreign side-cars are
// skipped, not guessed. The rendered HTML dashboard is deliberately CUT this cycle; this is the
// cheap, engine-independent stub.

const SIDECAR_SUFFIX = '.deltawright-sidecar.json';

/** One normalized flake data point derived from a side-car. */
export interface FlakeRecord {
  testId: string;
  runId: string;
  code: RootCauseCode | 'unsure';
  confidence: Confidence;
  /**
   * The taxonomy category of `code`, or null when the record is bucketed apart as unsure: the
   * reporter's `unsure` sentinel, an untaxonomized code, OR the taxonomy's own `unknown` — its
   * first-class "unsure" outcome, whose `unknown` category is NEVER surfaced as a real category.
   */
  category: RootCauseCategory | null;
  /** settle-cap: the failure carried a `settle-timeout` diagnosis (settle hit the maxWait cap). */
  hitMaxWait: boolean;
  /** a `geom-disagreement` diagnosis was present (geometry ↔ Playwright disagreed). */
  disagreement: boolean;
  detached: boolean;
  lateWave: boolean;
  staleRect: boolean;
}

export interface TestFlakeSummary {
  testId: string;
  /** Total failure records for this test across all runs. */
  failures: number;
  /** Distinct runs the test failed in. */
  runs: number;
  /** The most frequent taxonomy category (null when every record was unsure/untaxonomized). */
  dominantCategory: RootCauseCategory | null;
  /** Per-category failure counts (excludes unsure). */
  categories: Partial<Record<RootCauseCategory, number>>;
  /** Records bucketed as unsure / untaxonomized — never folded into a category. */
  unsure: number;
  /** Fraction of failures whose settle hit the maxWait cap. */
  settleCapRate: number;
  /** Fraction of failures carrying a geometry↔Playwright disagreement. */
  disagreementRate: number;
}

export interface FlakeReport {
  /** Tests ranked most-flaky first (by failure count, then distinct runs, then testId). */
  tests: TestFlakeSummary[];
  totalRecords: number;
  /** Total unsure/untaxonomized records across all tests. */
  unsureBucket: number;
}

/** The subset of a side-car this reads. Kept minimal so a partial/old side-car still degrades. */
interface SidecarShape {
  test?: unknown;
  cause?: unknown;
  confidence?: unknown;
  detached?: unknown;
  lateWave?: unknown;
  staleRect?: unknown;
  diagnoses?: Array<{ code?: unknown }>;
}

/** Map a parsed side-car object into a FlakeRecord, or null if it is not a recognizable side-car. */
export function recordFromSidecar(sidecar: unknown, runId: string): FlakeRecord | null {
  const s = sidecar as SidecarShape;
  if (!s || typeof s.test !== 'string' || typeof s.cause !== 'string') return null;

  const code = s.cause as RootCauseCode | 'unsure';
  // `unsure`, any code not in the (closed) taxonomy, AND the taxonomy's own `unknown` (its
  // first-class "unsure" outcome, category `unknown`) all have NO category — bucketed apart, never
  // inflating a real category. Keying off the resolved `unknown` category rather than the literal
  // `unknown` code also covers any future code the taxonomy files under `unknown`. This is likewise
  // how it degrades when the taxonomy is absent/foreign.
  const resolved: RootCauseCategory | null =
    code === 'unsure' ? null : (ROOT_CAUSE_TAXONOMY[code as RootCauseCode]?.category ?? null);
  const category: RootCauseCategory | null = resolved === 'unknown' ? null : resolved;
  const codes = Array.isArray(s.diagnoses)
    ? s.diagnoses.map((d) => (d && typeof d.code === 'string' ? d.code : ''))
    : [];

  return {
    testId: s.test,
    runId,
    code,
    confidence: (typeof s.confidence === 'string' ? s.confidence : 'unknown') as Confidence,
    category,
    hitMaxWait: codes.includes('settle-timeout'),
    disagreement: codes.includes('geom-disagreement'),
    detached: s.detached === true,
    lateWave: s.lateWave === true,
    staleRect: s.staleRect === true,
  };
}

const rate = (num: number, den: number): number => (den === 0 ? 0 : num / den);

/** Aggregate flake records into a ranked, unsure-bucketed report. Pure. */
export function aggregate(records: FlakeRecord[]): FlakeReport {
  const byTest = new Map<string, FlakeRecord[]>();
  for (const r of records)
    (byTest.get(r.testId) ?? byTest.set(r.testId, []).get(r.testId)!).push(r);

  const tests: TestFlakeSummary[] = [];
  let unsureBucket = 0;

  for (const [testId, recs] of byTest) {
    const categories: Partial<Record<RootCauseCategory, number>> = {};
    let unsure = 0;
    let capped = 0;
    let disagreed = 0;
    const runs = new Set<string>();
    for (const r of recs) {
      runs.add(r.runId);
      if (r.category) categories[r.category] = (categories[r.category] ?? 0) + 1;
      else unsure++; // unsure / untaxonomized — bucketed apart
      if (r.hitMaxWait) capped++;
      if (r.disagreement) disagreed++;
    }
    unsureBucket += unsure;
    // Dominant category = the most frequent taxonomy category (null when all unsure). Ties break by
    // category name for determinism.
    const dominantCategory =
      (Object.entries(categories) as Array<[RootCauseCategory, number]>).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0]?.[0] ?? null;

    tests.push({
      testId,
      failures: recs.length,
      runs: runs.size,
      dominantCategory,
      categories,
      unsure,
      settleCapRate: rate(capped, recs.length),
      disagreementRate: rate(disagreed, recs.length),
    });
  }

  // Rank most-flaky first: by failure count, then distinct runs, then testId (deterministic).
  tests.sort(
    (a, b) => b.failures - a.failures || b.runs - a.runs || a.testId.localeCompare(b.testId),
  );

  return { tests, totalRecords: records.length, unsureBucket };
}

/** One JSON object per line — the machine-readable stream. Pure. */
export function toJSONL(records: FlakeRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}

/**
 * Recursively collect `*.deltawright-sidecar.json` paths under `dir` (read-only). `seenDirs` holds
 * the REAL (symlink-resolved) path of every directory already walked, so a symlink cycle (e.g. a CI
 * `latest -> run-N` link inside the tree) or an overlapping input dir can't make us walk — and thus
 * multi-count — the same directory. realpathSync is read-only, so the no-write invariant holds.
 */
function walkSidecars(dir: string, seenDirs: Set<string>): string[] {
  const out: string[] = [];
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return out; // unreadable dir / broken symlink — degrade to nothing
  }
  if (seenDirs.has(real)) return out; // already walked via another path — break cycles / overlap
  seenDirs.add(real);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // unreadable dir — degrade to nothing
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) out.push(...walkSidecars(p, seenDirs));
    else if (entry.endsWith(SIDECAR_SUFFIX)) out.push(p);
  }
  return out;
}

/**
 * READ-ONLY: read every `*.deltawright-sidecar.json` under the given dir(s) into FlakeRecords. The
 * `runId` for each record is the basename of its containing directory (so one run = one dir). Files
 * that are missing / unparseable / not a side-car are skipped, never guessed.
 */
export function readSidecars(dirs: string[]): FlakeRecord[] {
  const records: FlakeRecord[] = [];
  const seenDirs = new Set<string>(); // shared across all input dirs — dedups overlap + cycles
  const seenFiles = new Set<string>(); // a file reachable via two input paths is counted once
  for (const dir of dirs) {
    for (const file of walkSidecars(dir, seenDirs)) {
      let key: string;
      try {
        key = realpathSync(file);
      } catch {
        key = file; // can't resolve — fall back to the literal path as the dedup key
      }
      if (seenFiles.has(key)) continue; // same file, two paths — count once, keep the first runId
      seenFiles.add(key);
      const runId = basename(dirname(file));
      try {
        const rec = recordFromSidecar(JSON.parse(readFileSync(file, 'utf8')), runId);
        if (rec) records.push(rec);
      } catch {
        // unparseable JSON — skip
      }
    }
  }
  return records;
}

/** Render a compact human summary of a report (for the CLI `--report` view). */
export function renderReport(report: FlakeReport): string {
  const lines = [
    `deltawright flake aggregate — ${report.totalRecords} failure records, ${report.tests.length} tests`,
    `unsure/untaxonomized bucket: ${report.unsureBucket} (never folded into a category)`,
    '',
    'most flaky first:',
  ];
  for (const t of report.tests) {
    const cat = t.dominantCategory ?? 'unsure';
    lines.push(
      `  ${t.failures}×  ${t.testId}  [${cat}]  ` +
        `(runs ${t.runs}, settle-cap ${(t.settleCapRate * 100).toFixed(0)}%, ` +
        `disagreement ${(t.disagreementRate * 100).toFixed(0)}%, unsure ${t.unsure})`,
    );
  }
  return lines.join('\n');
}
