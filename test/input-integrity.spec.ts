import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { actAndObserve, diagnose } from '../src/index';
import { summarizeDiagnoses } from '../src/host/summarize';
import { classifyInput } from '../src/host/input-integrity';
import { fixtureUrl } from './helpers';

// v0.9 Move 1 — post-settle input-integrity. A value-bearing action (fill/type) that Playwright
// reports as SUCCESS, but the field commits a different, shorter value AFTER the settle window (the
// async debounce-then-clear a synchronous post-fill check cannot see). DW reads the committed value
// at the existing post-settle read point and, for a strict-subsequence LOSS, emits
// `input-not-committed` (suspected). A case/format MASK (a transform, not a loss) must NOT be
// flagged — the make-or-break false-positive guard. Read-and-compare only; PW's verdict is untouched.

const URL = fixtureUrl('input-drop.html');
const INTENDED = 'acetaminophen500'; // 16 distinctive chars

/** Read a field's committed value after settle (the reader threaded into actAndObserve). */
const readValue = (selector: string) => (page: Page) => page.locator(selector).inputValue();

/** Type char-by-char (pressSequentially) so per-keystroke widgets are exercised, then diagnose. */
async function typeAndDiagnose(page: Page, selector: string) {
  await page.goto(URL);
  const delta = await actAndObserve(
    page,
    async (p) => {
      await p.locator(selector).click();
      await p.locator(selector).pressSequentially(INTENDED);
    },
    {
      label: `type ${selector}`,
      inputIntegrity: { intended: INTENDED, readCommitted: readValue(selector) },
    },
  );
  return { delta, diagnosed: diagnose(delta) };
}

// --- The pure classifier (fast, no browser) — the shape decisions in one place ------------------

test('classifyInput names the loss shape and leaves a mask unflagged', () => {
  expect(classifyInput('abc', 'abc')).toBe('clean');
  expect(classifyInput('abc', '')).toBe('never-committed');
  expect(classifyInput('acetaminophen', 'acetamin')).toBe('truncated'); // proper prefix
  expect(classifyInput('acetaminophen', 'aeaiohn')).toBe('dropped'); // non-prefix subsequence
  expect(classifyInput('acetaminophen', 'ACETAMINOPHEN')).toBe('transformed'); // case mask
  expect(classifyInput('abc', 'abcd')).toBe('transformed'); // longer than intent — not a loss
  expect(classifyInput('', 'x')).toBe('transformed'); // non-empty commit into empty intent

  // Subtractive separator/whitespace masks ARE shorter subsequences, but drop only formatting —
  // NOT a loss (the make-or-break false-positive guard the 2-lens review caught).
  expect(classifyInput('4111 1111 1111 1111', '4111111111111111')).toBe('transformed'); // strip spaces
  expect(classifyInput('123-456-7890', '1234567890')).toBe('transformed'); // strip dashes
  expect(classifyInput('hello ', 'hello')).toBe('transformed'); // trailing trim
  expect(classifyInput('1,000.50', '1000.50')).toBe('transformed'); // thousands separator

  // ...but a genuine loss (a letter/number dropped) still flags — incl. non-English (Unicode-aware).
  expect(classifyInput('a b c', 'a c')).toBe('dropped'); // dropped the letter 'b'
  expect(classifyInput('абвг', 'авг')).toBe('dropped'); // dropped Cyrillic 'б' — real content
});

// --- Live: the SuggestBox clear (the #41 pathology) ---------------------------------------------

test('flags a debounce-then-clear SuggestBox as input-not-committed (never-committed)', async ({
  page,
}) => {
  const { delta, diagnosed } = await typeAndDiagnose(page, '#debounce-clear');

  // The field really did drop everything typed — the drift is post-settle, not a PW failure.
  expect(delta.stats.inputIntegrity?.shape).toBe('never-committed');
  expect(delta.stats.inputIntegrity?.intendedLen).toBe(INTENDED.length);
  expect(delta.stats.inputIntegrity?.committedLen).toBe(0);

  const d = diagnosed.diagnoses.find((x) => x.code === 'input-not-committed');
  expect(d, 'input-not-committed was emitted').toBeTruthy();
  expect(d!.confidence).toBe('suspected'); // clamped — never confirmed (DW-03)

  // It is the primary cause an agent would route on.
  expect(summarizeDiagnoses(diagnosed.diagnoses).cause).toBe('input-not-committed');

  // Honest phrasing: never echoes the typed value (privacy), never blames Playwright's fill.
  expect(d!.detail).not.toContain(INTENDED);
  expect(d!.detail.toLowerCase()).not.toContain('fill failed');
});

// --- Live: the deferred truncate ----------------------------------------------------------------

test('flags a deferred truncate as input-not-committed (truncated)', async ({ page }) => {
  const { delta, diagnosed } = await typeAndDiagnose(page, '#truncate-deferred');

  expect(delta.stats.inputIntegrity?.shape).toBe('truncated');
  expect(delta.stats.inputIntegrity?.committedLen).toBe(8);

  const d = diagnosed.diagnoses.find((x) => x.code === 'input-not-committed');
  expect(d, 'input-not-committed was emitted').toBeTruthy();
  expect(d!.detail).toContain('8 of 16'); // length-based, value-free
});

// --- Live: the false-positive guards (the make-or-break) ----------------------------------------

test('does NOT flag a clean field (no drift, no stat, no diagnosis)', async ({ page }) => {
  const { delta, diagnosed } = await typeAndDiagnose(page, '#clean');

  expect(delta.stats.inputIntegrity).toBeUndefined();
  expect(diagnosed.diagnoses.some((x) => x.code === 'input-not-committed')).toBe(false);
});

test('does NOT flag a formatting mask — a transform is seen but honestly not a loss', async ({
  page,
}) => {
  const { delta, diagnosed } = await typeAndDiagnose(page, '#mask-upper');

  // DW SEES the drift (records the transform shape) but declines to flag it — DW-03.
  expect(delta.stats.inputIntegrity?.shape).toBe('transformed');
  expect(diagnosed.diagnoses.some((x) => x.code === 'input-not-committed')).toBe(false);
});

test('does NOT flag a subtractive separator mask (a card field stripping spaces)', async ({
  page,
}) => {
  // The committed value ("4111...") IS a shorter subsequence of the intent ("4111 1111...") — the
  // exact false-positive the 2-lens review caught. Only whitespace was dropped, so it is a mask.
  const card = '4111 1111 1111 1111';
  await page.goto(URL);
  const delta = await actAndObserve(
    page,
    async (p) => {
      await p.locator('#strip-spaces').click();
      await p.locator('#strip-spaces').pressSequentially(card);
    },
    {
      label: 'type #strip-spaces',
      inputIntegrity: { intended: card, readCommitted: readValue('#strip-spaces') },
    },
  );
  expect(delta.stats.inputIntegrity?.shape).toBe('transformed');
  expect(diagnose(delta).diagnoses.some((x) => x.code === 'input-not-committed')).toBe(false);
});

// --- The default path is byte-unchanged when the option is absent -------------------------------

test('records nothing when the inputIntegrity option is not passed', async ({ page }) => {
  await page.goto(URL);
  const delta = await actAndObserve(
    page,
    async (p) => {
      await p.locator('#debounce-clear').click();
      await p.locator('#debounce-clear').pressSequentially(INTENDED);
    },
    { label: 'type without opt-in' },
  );
  expect(delta.stats.inputIntegrity).toBeUndefined();
  expect(diagnose(delta).diagnoses.some((x) => x.code === 'input-not-committed')).toBe(false);
});

// --- fill() drifts too (the deferred clear is method-independent) --------------------------------

test('flags the same drift for fill() (deferred clear survives a bulk value set)', async ({
  page,
}) => {
  await page.goto(URL);
  const delta = await actAndObserve(page, (p) => p.locator('#debounce-clear').fill(INTENDED), {
    label: 'fill #debounce-clear',
    inputIntegrity: { intended: INTENDED, readCommitted: readValue('#debounce-clear') },
  });
  expect(delta.stats.inputIntegrity?.shape).toBe('never-committed');
  expect(diagnose(delta).diagnoses.some((x) => x.code === 'input-not-committed')).toBe(true);
});
