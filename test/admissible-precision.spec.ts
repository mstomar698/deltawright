import { test, expect } from '@playwright/test';
import { INTERACTIONS } from '../bench/run-admissible';
import type { DeltaNode } from '../src/index';

// The admissible benchmark (#25) scores PRECISION against hand-labeled `expected` predicates
// (the ground truth for "is this reported node a legitimate consequence of the action?").
// These tests prove the predicates DISCRIMINATE — a vacuous `() => true` would also report
// 100% precision on the quiet corpus and look fine, so we verify each predicate accepts the
// real change nodes AND rejects unrelated churn.

// Minimal node factory — the predicates only read kind/tag/role/name.
const n = (p: Partial<DeltaNode>): DeltaNode => p as DeltaNode;
const ix = (name: string) => {
  const found = INTERACTIONS.find((i) => i.name === name);
  if (!found) throw new Error(`no interaction "${name}"`);
  return found;
};

test('add: the added subtree + the item-count are expected; unrelated changes are not', () => {
  const e = ix('add').expected;
  expect(e(n({ kind: 'added', tag: 'li' }))).toBe(true);
  expect(e(n({ kind: 'added', tag: 'input', role: 'checkbox' }))).toBe(true);
  expect(e(n({ kind: 'added', tag: 'button', role: 'button', name: 'Delete todo' }))).toBe(true);
  expect(e(n({ kind: 'textChanged', tag: 'span' }))).toBe(true); // role-less footer count
  // discrimination:
  expect(e(n({ kind: 'attrChanged', tag: 'header', role: 'banner' }))).toBe(false);
  expect(e(n({ kind: 'removed', tag: 'li' }))).toBe(false);
});

test('toggle: the flip + revealed control + count are expected; a stray add/button is not', () => {
  const e = ix('toggle').expected;
  expect(e(n({ kind: 'attrChanged', tag: 'li' }))).toBe(true);
  expect(e(n({ kind: 'attrChanged', tag: 'input', role: 'checkbox' }))).toBe(true);
  expect(
    e(n({ kind: 'attrChanged', tag: 'button', role: 'button', name: 'Clear completed' })),
  ).toBe(true);
  expect(e(n({ kind: 'textChanged', tag: 'strong' }))).toBe(true);
  // discrimination:
  expect(
    e(n({ kind: 'attrChanged', tag: 'button', role: 'button', name: 'Some Other Button' })),
  ).toBe(false);
  expect(e(n({ kind: 'added', tag: 'li' }))).toBe(false);
});

test('delete: the removed li + count are expected; a stray removed dialog is not', () => {
  const e = ix('delete').expected;
  expect(e(n({ kind: 'removed', tag: 'li' }))).toBe(true);
  expect(e(n({ kind: 'textChanged', tag: 'span' }))).toBe(true);
  // discrimination:
  expect(e(n({ kind: 'removed', tag: 'div', role: 'dialog' }))).toBe(false);
  expect(e(n({ kind: 'added', tag: 'li' }))).toBe(false);
});

test('filter-nav: filtered-out items + nav-link flips are expected; a button change is not', () => {
  const e = ix('filter-nav').expected;
  expect(e(n({ kind: 'removed', tag: 'li' }))).toBe(true);
  expect(e(n({ kind: 'attrChanged', tag: 'a', role: 'link', name: 'Active' }))).toBe(true);
  // discrimination:
  expect(e(n({ kind: 'attrChanged', tag: 'button', role: 'button' }))).toBe(false);
  expect(e(n({ kind: 'added', tag: 'li' }))).toBe(false);
});

test('no precision predicate is vacuous — each rejects an unrelated background node', () => {
  const noise = n({ kind: 'attrChanged', tag: 'div', role: 'banner', name: 'ad' });
  for (const i of INTERACTIONS) {
    expect(i.expected(noise), `${i.name} must reject unrelated background churn`).toBe(false);
  }
});
