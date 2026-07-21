import { test, expect } from '@playwright/test';
import { dwMatchers, checkCommittedValue, toHaveCommittedValue } from '../src/matchers';
import { COMMITTED_VALUE_FIXTURE_URL } from './helpers';

// Hardening H1: toHaveCommittedValue — a loud, located post-fill gate for the input-commit flake class
// Playwright has no primitive for. Each input exhibits a distinct committed-value shape.

expect.extend(dwMatchers);

test.beforeEach(async ({ page }) => {
  await page.goto(COMMITTED_VALUE_FIXTURE_URL);
});

test('passes when the field commits the intended value cleanly', async ({ page }) => {
  await page.fill('#clean', 'hello');
  await expect(page.locator('#clean')).toHaveCommittedValue('hello');
  const r = await checkCommittedValue(page.locator('#clean'), 'hello');
  expect(r.shape).toBe('clean');
  expect(r.settled).toBe(true); // a stable field confirms a settle
});

test('reports settled:false for a field that never stops changing (an honest signal)', async ({
  page,
}) => {
  await page.fill('#churn', 'hello');
  // The field mutates every 40ms forever → the poll hits the settleMs cap without a confirmed settle.
  const r = await checkCommittedValue(page.locator('#churn'), 'hello', { settleMs: 350 });
  expect(r.settled).toBe(false);
});

test('PASSES a benign reformat mask (transformed) where toHaveValue FALSE-fails', async ({
  page,
}) => {
  await page.fill('#mask-space', '4111 1111');
  // The field strips the space to "41111111" — an INTENDED mask, not character loss.
  await expect(page.locator('#mask-space')).toHaveCommittedValue('4111 1111');
  const r = await checkCommittedValue(page.locator('#mask-space'), '4111 1111');
  expect(r.shape).toBe('transformed');
  expect(r.isLoss).toBe(false);
  // The differentiator: Playwright's own toHaveValue asserts against the raw intent and FALSE-fails —
  // the committed value is "41111111", not "4111 1111".
  await expect(page.locator('#mask-space')).not.toHaveValue('4111 1111');
  await expect(page.locator('#mask-space')).toHaveValue('41111111');
});

test('FAILS an async debounce-then-clear (never-committed) that a synchronous read would miss', async ({
  page,
}) => {
  await page.fill('#debounce-clear', 'hello');
  // Right after fill the value is still "hello"; the settle read waits past the 150ms async clear.
  const r = await checkCommittedValue(page.locator('#debounce-clear'), 'hello');
  expect(r.shape).toBe('never-committed');
  expect(r.isLoss).toBe(true);
  expect(r.committedLen).toBe(0);
  // The matcher fails loud → `.not` passes here (asserting the failure without failing the test).
  await expect(page.locator('#debounce-clear')).not.toHaveCommittedValue('hello');
});

test('names truncated and dropped as real character loss', async ({ page }) => {
  await page.fill('#truncate', 'hello world');
  const t = await checkCommittedValue(page.locator('#truncate'), 'hello world');
  expect(t.shape).toBe('truncated');
  expect(t.isLoss).toBe(true);
  expect(t.committedLen).toBe(5);

  await page.fill('#dropped', 'hello');
  const d = await checkCommittedValue(page.locator('#dropped'), 'hello');
  expect(d.shape).toBe('dropped');
  expect(d.isLoss).toBe(true);
});

test('HONESTY: the failure message names the shape + lengths, never the raw value (PII-safe)', async ({
  page,
}) => {
  await page.fill('#debounce-clear', 'sup3rs3cr3t');
  const { pass, message } = await toHaveCommittedValue(
    page.locator('#debounce-clear'),
    'sup3rs3cr3t',
  );
  expect(pass).toBe(false);
  const msg = message();
  expect(msg).toContain('never-committed');
  expect(msg).toMatch(/\d+ intended → \d+ committed chars/);
  // The raw secret must NOT appear in the message.
  expect(msg).not.toContain('sup3rs3cr3t');
});

test('HONESTY: it observes + labels, never overrides fill() and never repairs the value (DW-02/03)', async ({
  page,
}) => {
  // fill() succeeded (Playwright authoritative, DW-02); the matcher only observes + labels the outcome.
  await page.fill('#debounce-clear', 'hello');
  const r = await checkCommittedValue(page.locator('#debounce-clear'), 'hello');
  expect(r.shape).toBe('never-committed'); // DW reports the loss …
  // … and does NOT repair it: the field stays as the widget left it (cleared), never re-typed to 'hello'.
  expect(await page.locator('#debounce-clear').inputValue()).toBe('');
});
