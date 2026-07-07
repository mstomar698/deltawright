import { test, expect } from '@playwright/test';
import { structuralDiff } from '../bench/structural-diff';
import { lineDiff } from '../bench/diff';

const list = (...items: string[]) =>
  ['- list:', ...items.map((i) => `  - listitem "${i}"`)].join('\n');

test('identical snapshots produce an empty diff', () => {
  const s = list('buy milk', 'write report', 'ship it');
  expect(structuralDiff(s, s)).toBe('');
});

test('a keyed-list reorder is empty structurally, but the LCS diff over-reports it', () => {
  const before = list('buy milk', 'write report', 'ship it');
  const after = list('write report', 'ship it', 'buy milk');
  // The whole point: order-insensitive matching sees no change...
  expect(structuralDiff(before, after)).toBe('');
  // ...while the line-diff churns on the move (this is what it fixes).
  expect(lineDiff(before, after).trim().length).toBeGreaterThan(0);
});

test('an inserted item shows only the added subtree', () => {
  const before = list('buy milk');
  const after = list('buy milk', 'new task');
  const d = structuralDiff(before, after);
  expect(d).toMatch(/\+ listitem "new task"/);
  expect(d).not.toMatch(/buy milk/); // the unchanged item is not re-reported
});

test('a removed item shows only the removed subtree', () => {
  const before = list('buy milk', 'write report');
  const after = list('buy milk');
  const d = structuralDiff(before, after);
  expect(d).toMatch(/- listitem "write report"/);
  expect(d).not.toMatch(/\+/);
});

test('an attribute flip on a matched node is reported as a change, not remove+add', () => {
  const before = '- checkbox "buy milk"';
  const after = '- checkbox "buy milk" [checked]';
  const d = structuralDiff(before, after);
  expect(d).toMatch(/~ checkbox "buy milk" \[checked\]/);
  expect(d).not.toMatch(/^[+-]/m);
});
