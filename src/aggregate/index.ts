import { readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ROOT_CAUSE_TAXONOMY, type RootCauseCategory, type RootCauseCode } from '../host/taxonomy';
import { CONFIDENCE_ORDER, atLeastAsConfident, type Confidence } from '../host/confidence';

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

/** A per-diagnosis line retained from a side-car, defensively typed (foreign side-cars may vary). */
export interface FlakeDiagnosis {
  code: string;
  confidence: string;
  scope: string;
  detail: string;
}

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
  /** The side-car's human-readable `detail` (why this cause / why unsure). Retained for the dashboard. */
  detail: string;
  /** Where the diagnosis came from (`delta-attachment` / `error-text`). Retained for the dashboard. */
  source: string;
  /** The side-car's cross-test clustering fingerprint (empty on an old/foreign side-car — then a coarse
   *  key is recomputed from the record at cluster time). */
  fingerprint: string;
  /** `delta` (structural) / `coarse` (error-shape) / `none` (absent on an old/foreign side-car). */
  fingerprintSource: 'delta' | 'coarse' | 'none';
  /** Every diagnosis the side-car carried, so the dashboard can explain the failure, not just count it. */
  diagnoses: FlakeDiagnosis[];
}

/** A compact per-failure-record view the dashboard expands under a test row (its explanation). */
export interface TestFlakeRecordView {
  runId: string;
  code: RootCauseCode | 'unsure';
  confidence: Confidence;
  category: RootCauseCategory | null;
  detail: string;
  source: string;
  detached: boolean;
  lateWave: boolean;
  staleRect: boolean;
  diagnoses: FlakeDiagnosis[];
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
  /** This test's failure records with their retained explanation, so the dashboard can expand them. */
  records: TestFlakeRecordView[];
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
  detail?: unknown;
  source?: unknown;
  detached?: unknown;
  lateWave?: unknown;
  staleRect?: unknown;
  fingerprint?: unknown;
  fingerprintSource?: unknown;
  diagnoses?: Array<{ code?: unknown; confidence?: unknown; scope?: unknown; detail?: unknown }>;
}

/** Read a possibly-missing string field, defaulting to '' — foreign / partial side-cars may omit it. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
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
  // Retain every diagnosis line (defensively typed) so the dashboard can explain a failure, not just
  // count it — the explanatory `detail`/`scope`/`confidence` were previously discarded.
  const diagnoses: FlakeDiagnosis[] = Array.isArray(s.diagnoses)
    ? s.diagnoses.map((d) => ({
        code: str(d?.code),
        confidence: str(d?.confidence) || 'unknown',
        scope: str(d?.scope),
        detail: str(d?.detail),
      }))
    : [];
  const codes = diagnoses.map((d) => d.code);

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
    detail: str(s.detail),
    source: str(s.source),
    fingerprint: str(s.fingerprint),
    fingerprintSource:
      s.fingerprintSource === 'delta' || s.fingerprintSource === 'coarse'
        ? s.fingerprintSource
        : 'none',
    diagnoses,
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
      // Carry each record's retained explanation so the dashboard can expand the row's detail panel.
      records: recs.map((r) => ({
        runId: r.runId,
        code: r.code,
        confidence: r.confidence,
        category: r.category,
        detail: r.detail,
        source: r.source,
        detached: r.detached,
        lateWave: r.lateWave,
        staleRect: r.staleRect,
        diagnoses: r.diagnoses,
      })),
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

// --- Cross-test cause-clustering (triage T1) — suite-scale "one root cause, N-test blast radius" -------
//
// Incumbents cluster on TEST IDENTITY (per-test flakiness) or a TEXT signature (message/stack — which
// provably over- and under-groups). This clusters on the OBSERVED STRUCTURAL MECHANISM, a key no one else
// has: the closed taxonomy CODE (Level 1, the anti-over-group firewall — two different codes NEVER merge)
// × the geometry/timing/message-tolerant delta FINGERPRINT (Level 2, the anti-under-group key — "same
// cause" collapses even when the error text jitters). HONESTY (DW-03/04): a cluster is a HYPOTHESIS of a
// shared cause, never "the same bug"; `unsure` is NEVER clustered (you can't fingerprint an absence of
// evidence) — each unsure record stays a singleton, exactly as `aggregate` refuses to fold unsure into a
// category.

export interface CauseCluster {
  /** The shared taxonomy code (never `unsure` — those are not clustered). */
  code: RootCauseCode;
  category: RootCauseCategory;
  /** The shared clustering fingerprint (Level 2 key). */
  fingerprint: string;
  /** Resolution of the fingerprint: structural `delta` vs error-shape `coarse` — surfaced, never hidden. */
  fingerprintSource: 'delta' | 'coarse';
  /** Distinct tests sharing this cause+fingerprint — the blast radius. A CANDIDATE fix-once-fix-many
   *  (a shared-cause hypothesis: one fix MAY clear them all, not a guarantee it will). */
  blastRadius: number;
  /** Total failure records in the cluster. */
  failures: number;
  /** Distinct runs the cluster spans. */
  runs: number;
  /** The HIGHEST confidence band across the cluster's records (a deliberate MAX, not a consensus): the
   *  cause was confirmed on at least one member, so the cluster carries that band. */
  confidence: Confidence;
  /** The distinct tests in the cluster (sorted). */
  tests: string[];
  /** A representative `detail` (from the highest-confidence record). */
  detailSample: string;
}

export interface CauseClusterReport {
  /** Real-cause clusters, ranked by blast-radius (then failures, then code) — highest-leverage first. */
  clusters: CauseCluster[];
  /** `unsure`/untaxonomized records, listed apart and NEVER merged into a cause — each its own. */
  unsure: Array<{ testId: string; runId: string; detail: string }>;
  totalRecords: number;
}

/** The effective clustering fingerprint for a record: the persisted one, or a coarse key recomputed from
 *  the record when a side-car predates fingerprinting (so old corpora still cluster at the cause level).
 *  MIXED-CORPUS NOTE: an OLD rich side-car (a delta attachment but no persisted fingerprint) recomputes a
 *  `coarse` key here, while a NEW rich side-car of the same failure keys on the `delta` checksum — so the
 *  same failure can split into a `coarse` and a `delta` cluster across a mixed corpus. `fingerprintSource`
 *  on each cluster makes that resolution difference visible. */
function effectiveFingerprint(r: FlakeRecord): { fp: string; source: 'delta' | 'coarse' } {
  if (r.fingerprint && r.fingerprintSource !== 'none') {
    return { fp: r.fingerprint, source: r.fingerprintSource };
  }
  const codes = [...new Set(r.diagnoses.map((d) => d.code))].sort().join(',');
  const f = `${r.detached ? 'd' : ''}${r.lateWave ? 'l' : ''}${r.staleRect ? 's' : ''}`;
  return { fp: `${r.code}#${codes}#${f}`, source: 'coarse' };
}

/**
 * Cluster a corpus of flake records into root-cause clusters keyed on (taxonomy code × delta fingerprint).
 * Read-only + pure. `unsure`/untaxonomized records are never clustered — they are returned as singletons
 * (a cluster is a hypothesis of a shared cause, and you cannot fingerprint an absence of evidence).
 */
export function clusterByCause(records: FlakeRecord[]): CauseClusterReport {
  const unsure: Array<{ testId: string; runId: string; detail: string }> = [];
  const groups = new Map<string, FlakeRecord[]>();
  for (const r of records) {
    if (r.category === null) {
      unsure.push({ testId: r.testId, runId: r.runId, detail: r.detail });
      continue;
    }
    const { fp } = effectiveFingerprint(r);
    const key = `${r.code}::${fp}`; // code FIRST — two different codes can never share a cluster
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }

  const clusters: CauseCluster[] = [];
  for (const recs of groups.values()) {
    const first = recs[0]!;
    const { fp, source } = effectiveFingerprint(first);
    const tests = [...new Set(recs.map((r) => r.testId))].sort();
    const runs = new Set(recs.map((r) => r.runId)).size;
    let confidence: Confidence = 'unknown';
    for (const r of recs)
      if (atLeastAsConfident(r.confidence, confidence)) confidence = r.confidence;
    const detailSample = recs
      .slice()
      .sort(
        (a, b) => CONFIDENCE_ORDER.indexOf(a.confidence) - CONFIDENCE_ORDER.indexOf(b.confidence),
      )[0]!.detail;
    clusters.push({
      code: first.code as RootCauseCode,
      category: first.category!,
      fingerprint: fp,
      fingerprintSource: source,
      blastRadius: tests.length,
      failures: recs.length,
      runs,
      confidence,
      tests,
      detailSample,
    });
  }

  // Rank by leverage: blast radius, then total failures, then code, then fingerprint — the last two make
  // the order fully deterministic (independent of Map insertion / stable-sort) even on full ties.
  clusters.sort(
    (a, b) =>
      b.blastRadius - a.blastRadius ||
      b.failures - a.failures ||
      a.code.localeCompare(b.code) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
  return { clusters, unsure, totalRecords: records.length };
}

/** Render a compact human summary of the cause clusters (for the CLI `--clusters` view). */
export function renderClusters(report: CauseClusterReport): string {
  const lines = [
    `deltawright cause clusters — ${report.clusters.length} clusters over ${report.totalRecords} records`,
    `unsure singletons (never clustered — route to a human): ${report.unsure.length}`,
    '',
    'highest blast-radius first (a shared-cause hypothesis — one fix MAY clear several, not a guarantee):',
  ];
  for (const c of report.clusters) {
    lines.push(
      `  ${c.blastRadius} tests ×  ${c.code}  [${c.category}]  ` +
        `(${c.confidence}, ${c.fingerprintSource}; ${c.failures} failures / ${c.runs} runs)`,
    );
  }
  return lines.join('\n');
}

// --- Actionability priority queue (reporting A) — "fix THIS cluster first, and here is why" -----------
//
// Incumbents rank by FREQUENCY / CI-time; DW ranks by shared-cause BLAST RADIUS × CONFIDENCE — only
// possible because DW owns the per-action taxonomy they don't. The rank is DECOMPOSED (blast radius, then
// confidence band, then failures) and every row shows its components — never one opaque score that "looks
// decisive". HONESTY: `unsure` is NOT scored low (which would bury it); it goes to its OWN human-triage
// lane, on par with the top lane (DW-04); a high rank is a fix-first HYPOTHESIS, never a confirmed bug or
// a guarantee one fix clears the cluster (DW-03); priority annotates, never overrides Playwright (DW-02).

export interface PriorityRow {
  /** 1-based fix-first rank. */
  rank: number;
  code: RootCauseCode;
  category: RootCauseCategory;
  /** Distinct tests sharing the cause — the leverage axis (a fix-once-fix-many candidate). */
  blastRadius: number;
  /** Highest confidence band in the cluster — the second ranking axis. */
  confidence: Confidence;
  failures: number;
  runs: number;
  fingerprintSource: 'delta' | 'coarse';
  tests: string[];
  detailSample: string;
}

export interface PriorityQueue {
  /** Fix-first rows, DECOMPOSED-ranked (blast radius, then confidence, then failures) — no opaque score. */
  rows: PriorityRow[];
  /** The human-triage lane: `unsure` failures, on par with the top lane — never scored as a cause. */
  humanLane: Array<{ testId: string; runId: string; detail: string }>;
  totalRecords: number;
}

/**
 * Rank cause clusters into a fix-first priority queue by shared-cause blast radius × confidence. Pure.
 * The order is decomposed/auditable (blast radius, then confidence band, then failures — every row shows
 * its components); `unsure` never enters the ranking — it is surfaced apart in a human-triage lane.
 */
export function prioritize(report: CauseClusterReport): PriorityQueue {
  const rows: PriorityRow[] = report.clusters
    .slice()
    .sort(
      (a, b) =>
        b.blastRadius - a.blastRadius || // 1) leverage: how many tests one fix could clear
        CONFIDENCE_ORDER.indexOf(a.confidence) - CONFIDENCE_ORDER.indexOf(b.confidence) || // 2) confidence
        b.failures - a.failures || // 3) volume
        a.code.localeCompare(b.code) ||
        a.fingerprint.localeCompare(b.fingerprint),
    )
    .map((c, i) => ({
      rank: i + 1,
      code: c.code,
      category: c.category,
      blastRadius: c.blastRadius,
      confidence: c.confidence,
      failures: c.failures,
      runs: c.runs,
      fingerprintSource: c.fingerprintSource,
      tests: c.tests,
      detailSample: c.detailSample,
    }));
  return { rows, humanLane: [...report.unsure], totalRecords: report.totalRecords };
}

/** Render the fix-first priority queue as text (the CLI `--priority` view). Decomposed — each row shows
 *  its blast radius, confidence, and failures, never a single opaque priority number. */
export function renderPriorityQueue(queue: PriorityQueue): string {
  const lines = [
    `deltawright fix-first priority — ${queue.rows.length} cause clusters over ${queue.totalRecords} records`,
    `human-triage lane (unsure — route to a human, NOT scored as a cause): ${queue.humanLane.length} failures`,
  ];
  if (queue.rows.length > 0) {
    lines.push(
      '',
      'fix these first (blast radius × confidence [the cluster’s HIGHEST band] — decomposed, a hypothesis not a guarantee):',
    );
  }
  for (const r of queue.rows) {
    lines.push(
      `  #${r.rank}  ${r.blastRadius} tests · ${r.confidence} · ${r.code} [${r.category}] · ` +
        `${r.failures} failures / ${r.runs} runs (${r.fingerprintSource})`,
    );
    if (r.detailSample) lines.push(`      — ${r.detailSample}`);
  }
  return lines.join('\n');
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

// The self-contained, theme-aware HTML dashboard over this same FlakeReport (Wave-1 #2). Kept in a
// sibling module so the large template stays out of the aggregation core; it too writes nothing.
export { renderHtml } from './html';

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
