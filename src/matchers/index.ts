// Deltawright Playwright matchers (#53, #54) — `deltawright/matchers`.
//
// Register once, then assert per locator or per delta:
//
//   import { expect } from '@playwright/test';
//   import { dwMatchers } from 'deltawright/matchers';
//   expect.extend(dwMatchers);
//
//   await expect(page.getByRole('button', { name: 'Submit' })).toBeActionable();   // #53
//   expect(delta).toMatchDeltaChecksum('submit-opens-dialog');                     // #54
//   expect(delta).toMatchDeltaSnapshot();                                          // #54 (auto id)
//
// Update checksum baselines intentionally with `DW_UPDATE_CHECKSUMS=1`, Playwright's
// `--update-snapshots`, or `deltawright checksum --update -- <test command>`.

import { test } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { toBeActionable } from './actionable';
import { matchDeltaChecksum, type ChecksumMatchResult } from './checksum';
import type { Delta } from '../host/types';

export { preflight, toBeActionable } from './actionable';
export type { PreflightOptions, PreflightResult } from './actionable';
export { matchDeltaChecksum } from './checksum';
export type { ChecksumMatchResult, MatchDeltaChecksumOptions } from './checksum';
export { verifySuggestions } from './verify-suggest';
export type {
  VerifiedSuggestResult,
  VerifiedSelectorSuggestion,
  VerifyStatus,
  VerifySuggestionsOptions,
} from './verify-suggest';

import type { PreflightOptions } from './actionable';

const CHECKSUM_DIR = '__dw_checksums__';

/** Filesystem-safe baseline id. */
function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'delta';
}

/**
 * Resolve the baseline file + update mode. Baselines live in a `__dw_checksums__/` dir next to the
 * running spec (like Playwright snapshots) when a test context is available, else under the cwd.
 * Update fires on `DW_UPDATE_CHECKSUMS=1` OR Playwright's `--update-snapshots` (`updateSnapshots` is
 * `'all'` or `'changed'` — the bare `-u` flag maps to `'changed'`). In CI a MISSING baseline fails
 * (still written) so an unestablished baseline can't first-run-green forever.
 */
function resolveBaseline(id: string): { file: string; update: boolean; failOnMissing: boolean } {
  let dir = resolve(process.cwd(), CHECKSUM_DIR);
  let update = process.env.DW_UPDATE_CHECKSUMS === '1';
  const failOnMissing = !!process.env.CI;
  try {
    const info = test.info();
    if (info.file) dir = resolve(dirname(info.file), CHECKSUM_DIR);
    const mode = info.config.updateSnapshots;
    if (mode === 'all' || mode === 'changed') update = true;
  } catch {
    // Not inside a Playwright test (or the API is unavailable) — use cwd + env only.
  }
  return { file: resolve(dir, `${sanitize(id)}.json`), update, failOnMissing };
}

/** `expect(delta).toMatchDeltaChecksum(id)` — compares against `__dw_checksums__/<id>.json` (#54). */
export function toMatchDeltaChecksum(delta: Delta, id: string): ChecksumMatchResult {
  const { file, update, failOnMissing } = resolveBaseline(id);
  return matchDeltaChecksum(delta, file, { update, failOnMissing });
}

/**
 * `expect(delta).toMatchDeltaSnapshot(name?)` — like `toMatchDeltaChecksum`, but derives the id from
 * the current test's title path (pass `name` to disambiguate multiple snapshots in one test) (#54).
 * REQUIRES a Playwright test context (it needs the test title); `toMatchDeltaChecksum(id)` does not.
 */
export function toMatchDeltaSnapshot(delta: Delta, name?: string): ChecksumMatchResult {
  let info;
  try {
    info = test.info();
  } catch {
    throw new Error(
      'toMatchDeltaSnapshot() needs a running Playwright test to derive the baseline id from the ' +
        'test title. Use toMatchDeltaChecksum(id) with an explicit id outside a test.',
    );
  }
  const base = sanitize(info.titlePath.join('-'));
  const id = name ? `${base}-${sanitize(name)}` : base;
  const { file, update, failOnMissing } = resolveBaseline(id);
  return matchDeltaChecksum(delta, file, { update, failOnMissing });
}

/** The matcher bag for `expect.extend(dwMatchers)`. */
export const dwMatchers = { toBeActionable, toMatchDeltaChecksum, toMatchDeltaSnapshot };

// Type the matchers onto Playwright's `expect` for consumers that import this module. Playwright's
// custom-matcher interface is the global `PlaywrightTest.Matchers<R, T>`, so the augmentation MUST
// use that namespace + arity to merge (hence the scoped lint-disable). Loosely typed (each appears on
// every `expect(...)`, the usual third-party-matcher trade-off); `toBeActionable` is meaningful on a
// Locator and the checksum matchers on a Delta.
/* eslint-disable @typescript-eslint/no-namespace, @typescript-eslint/no-unused-vars */
declare global {
  namespace PlaywrightTest {
    interface Matchers<R, T = unknown> {
      /** Pass iff Playwright's role-aware actionability probe finds this locator actionable (#53). */
      toBeActionable(options?: PreflightOptions): Promise<R>;
      /** Pass iff the delta's geometry-tolerant checksum matches the `<id>` baseline (#54). */
      toMatchDeltaChecksum(id: string): R;
      /** Like `toMatchDeltaChecksum`, id derived from the current test's title path (#54). */
      toMatchDeltaSnapshot(name?: string): R;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace, @typescript-eslint/no-unused-vars */
