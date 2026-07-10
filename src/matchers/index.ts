// Deltawright preflight actionability matcher (#53) — `deltawright/matchers`.
//
// A ground-truth wrapper on Playwright's own actionability judgment, usable standalone (no prior
// actAndObserve). Register once, then assert per locator:
//
//   import { expect } from '@playwright/test';
//   import { dwMatchers } from 'deltawright/matchers';
//   expect.extend(dwMatchers);
//   await expect(page.getByRole('button', { name: 'Submit' })).toBeActionable();
//
// Or read the structured result directly: `const { verdict, reason, geometryVerdict, agreed } =
// await preflight(locator)`.

export { preflight, toBeActionable, dwMatchers } from './actionable';
export type { PreflightOptions, PreflightResult } from './actionable';

import type { PreflightOptions } from './actionable';

// Type the matcher onto Playwright's `expect` for consumers that import this module. Playwright's
// custom-matcher interface is the global `PlaywrightTest.Matchers<R, T>`, so the augmentation MUST
// use that namespace + arity to merge (hence the scoped lint-disable). Loosely typed (it appears on
// every `expect(...)`, the usual third-party-matcher trade-off); it is only meaningful on a Locator,
// and the runtime probe reports NOT-actionable for anything unprobeable.
/* eslint-disable @typescript-eslint/no-namespace, @typescript-eslint/no-unused-vars */
declare global {
  namespace PlaywrightTest {
    interface Matchers<R, T = unknown> {
      /** Pass iff Playwright's role-aware actionability probe finds this locator actionable (#53). */
      toBeActionable(options?: PreflightOptions): Promise<R>;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace, @typescript-eslint/no-unused-vars */
