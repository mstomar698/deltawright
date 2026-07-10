import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeDelta } from '../host/checksum';
import type { Delta } from '../host/types';

// Delta checksum regression matcher (#54). A GROUND-TRUTH wrapper packaging an already-shipped
// primitive: byte-equality of the geometry/timing-TOLERANT normalized delta (checksum.ts). It fails
// on a verdict or tree change but matches across pixel/timing jitter.
//
// HONESTY (per checksum.ts's own note): a green checksum is REGRESSION-ONLY — it proves the delta's
// structure/semantics is unchanged from the captured baseline, and says NOTHING about whether the
// fixture faithfully models a real app or that Deltawright "works". Do not read fidelity into it. And
// the fingerprint has a known blind spot: it records THAT a node's attributes changed, not WHICH ones
// (see src/host/checksum.ts), so an attrChanged-identity swap with an unchanged verdict/tree passes.

const REGRESSION_ONLY =
  'A green delta checksum is REGRESSION-ONLY: it proves the normalized structure/semantics is ' +
  'unchanged, NOT that the delta is correct or that it models a real app faithfully.';

export interface ChecksumMatchResult {
  pass: boolean;
  message: () => string;
  /** True when this call created or overwrote the baseline (first run / update mode). */
  written: boolean;
}

export interface MatchDeltaChecksumOptions {
  /** Overwrite the baseline (or write a missing one) and pass — an intentional refresh. */
  update?: boolean;
  /**
   * FAIL on a missing baseline (still writing it) instead of passing. Set in CI so an uncommitted /
   * gitignored / relocated baseline can't first-run-write-and-green forever, guarding nothing. A
   * local first run (this off) writes + passes, jest-style; an explicit `update` always passes.
   */
  failOnMissing?: boolean;
}

/** Pretty-print the canonical normalized form for a readable diff (it is valid JSON). */
function pretty(normalized: string): string {
  try {
    return JSON.stringify(JSON.parse(normalized), null, 2);
  } catch {
    return normalized;
  }
}

/** A compact LCS line diff (`- ` removed / `+ ` added / `  ` context) of two normalized forms. */
function structuralDiff(storedNormalized: string, currentNormalized: string): string {
  const a = pretty(storedNormalized).split('\n');
  const b = pretty(currentNormalized).split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push('  ' + a[i]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push('- ' + a[i]);
      i++;
    } else {
      out.push('+ ' + b[j]);
      j++;
    }
  }
  while (i < m) out.push('- ' + a[i++]);
  while (j < n) out.push('+ ' + b[j++]);
  return out.join('\n');
}

/**
 * Compare a delta's normalized (geometry/timing-tolerant) fingerprint against a baseline FILE.
 * Writes the baseline on first run (missing) or in `update` mode and passes; on a real change it
 * fails with a STRUCTURAL (not pixel) diff. Filesystem is the only side effect and the file path is
 * injected, so the whole matcher is a pure, browser-free unit. The stored form IS the canonical
 * normalized JSON, so the baseline file is a git-committable regression fingerprint.
 */
export function matchDeltaChecksum(
  delta: Delta,
  baselineFile: string,
  opts: MatchDeltaChecksumOptions = {},
): ChecksumMatchResult {
  const current = normalizeDelta(delta);
  const exists = existsSync(baselineFile);

  if (!exists || opts.update) {
    mkdirSync(dirname(baselineFile), { recursive: true });
    writeFileSync(baselineFile, current + '\n');
    // A missing baseline in CI (failOnMissing) is written but FAILS, so an unestablished baseline
    // can't green forever; an explicit update, or a local first run, passes.
    const pass = exists ? true : opts.update === true || opts.failOnMissing !== true;
    const verb = exists ? 'updated' : 'wrote';
    return {
      pass,
      written: true,
      message: () =>
        `${verb} delta checksum baseline: ${baselineFile}` +
        (pass ? '' : ' — commit it and re-run (or run with --update to accept)') +
        `\n${REGRESSION_ONLY}`,
    };
  }

  const stored = readFileSync(baselineFile, 'utf8').trim();
  if (stored === current) {
    return {
      pass: true,
      written: false,
      message: () => `delta matches checksum baseline ${baselineFile}. ${REGRESSION_ONLY}`,
    };
  }

  return {
    pass: false,
    written: false,
    message: () =>
      `delta does NOT match checksum baseline ${baselineFile}.\n${REGRESSION_ONLY}\n` +
      `If this change is intended, refresh the baseline with ` +
      `\`DW_UPDATE_CHECKSUMS=1\` (or \`--update-snapshots\`, or \`deltawright checksum --update\`).\n\n` +
      `structural diff (baseline vs current):\n${structuralDiff(stored, current)}`,
  };
}
