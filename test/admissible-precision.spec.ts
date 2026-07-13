import { test, expect } from '@playwright/test';
import { INTERACTIONS } from '../bench/run-admissible';
import type { DeltaNode } from '../src/index';

// The admissible benchmark (#25) scores PRECISION against hand-labeled `expected` predicates
// (the ground truth for "is this reported node a legitimate consequence of the action?").
// These tests prove the predicates DISCRIMINATE — a vacuous `() => true` would also report
// 100% precision on the quiet corpus and look fine, so we verify each predicate accepts the
// real change nodes AND rejects unrelated churn (including unrelated ADDED nodes).

// Minimal node factory — the predicates read kind/tag/role/name and (for inserts) ref/parentRef.
const node = (p: Partial<DeltaNode>): DeltaNode => p as DeltaNode;
const ix = (name: string) => {
  const found = INTERACTIONS.find((i) => i.name === name);
  if (!found) throw new Error(`no interaction "${name}"`);
  return found;
};
// Evaluate a precision predicate; `nodes` defaults to just the node under test (enough for
// every predicate except the insert's ancestry clause, which is given an explicit subtree).
const ok = (name: string, n: DeltaNode, nodes: DeltaNode[] = [n]) => ix(name).expected(n, nodes);

test('add: the added SUBTREE (by ancestry) + the count are expected; an added node OUTSIDE it is not', () => {
  const li = node({ kind: 'added', tag: 'li', ref: 'e1' });
  const input = node({ kind: 'added', tag: 'input', role: 'checkbox', ref: 'e2', parentRef: 'e1' });
  const button = node({
    kind: 'added',
    tag: 'button',
    role: 'button',
    name: 'Delete todo',
    ref: 'e3',
    parentRef: 'e1',
  });
  const subtree = [li, input, button];
  expect(ok('add', li, subtree)).toBe(true);
  expect(ok('add', input, subtree)).toBe(true);
  expect(ok('add', button, subtree)).toBe(true);
  expect(ok('add', node({ kind: 'textChanged', tag: 'span', ref: 'e4' }))).toBe(true); // role-less count
  // discrimination — an added node OUTSIDE the new <li> (injected banner/portal/toast) is over-report:
  expect(
    ok('add', node({ kind: 'added', tag: 'div', role: 'banner', name: 'ad', ref: 'x1' })),
  ).toBe(false);
  expect(ok('add', node({ kind: 'attrChanged', tag: 'header', role: 'banner', ref: 'x2' }))).toBe(
    false,
  );
  expect(ok('add', node({ kind: 'removed', tag: 'li', ref: 'x3' }))).toBe(false);
});

test('toggle: the flip + revealed control + count are expected; a stray add/button is not', () => {
  expect(ok('toggle', node({ kind: 'attrChanged', tag: 'li' }))).toBe(true);
  expect(ok('toggle', node({ kind: 'attrChanged', tag: 'input', role: 'checkbox' }))).toBe(true);
  expect(
    ok(
      'toggle',
      node({ kind: 'attrChanged', tag: 'button', role: 'button', name: 'Clear completed' }),
    ),
  ).toBe(true);
  expect(ok('toggle', node({ kind: 'textChanged', tag: 'strong' }))).toBe(true);
  // discrimination:
  expect(
    ok(
      'toggle',
      node({ kind: 'attrChanged', tag: 'button', role: 'button', name: 'Some Other Button' }),
    ),
  ).toBe(false);
  expect(ok('toggle', node({ kind: 'added', tag: 'li' }))).toBe(false);
});

test('delete: the removed li + count are expected; a stray removed dialog is not', () => {
  expect(ok('delete', node({ kind: 'removed', tag: 'li' }))).toBe(true);
  expect(ok('delete', node({ kind: 'textChanged', tag: 'span' }))).toBe(true);
  // discrimination:
  expect(ok('delete', node({ kind: 'removed', tag: 'div', role: 'dialog' }))).toBe(false);
  expect(ok('delete', node({ kind: 'added', tag: 'li' }))).toBe(false);
});

test('filter-nav: filtered-out items + nav-link flips are expected; a button change is not', () => {
  expect(ok('filter-nav', node({ kind: 'removed', tag: 'li' }))).toBe(true);
  expect(
    ok('filter-nav', node({ kind: 'attrChanged', tag: 'a', role: 'link', name: 'Active' })),
  ).toBe(true);
  // discrimination:
  expect(ok('filter-nav', node({ kind: 'attrChanged', tag: 'button', role: 'button' }))).toBe(
    false,
  );
  expect(ok('filter-nav', node({ kind: 'added', tag: 'li' }))).toBe(false);
});

test('no precision predicate is vacuous — each rejects unrelated churn, attrChanged AND added', () => {
  const attrNoise = node({
    kind: 'attrChanged',
    tag: 'div',
    role: 'banner',
    name: 'ad',
    ref: 'z1',
  });
  const addedNoise = node({ kind: 'added', tag: 'div', role: 'banner', name: 'ad', ref: 'z2' });
  for (const i of INTERACTIONS) {
    expect(i.expected(attrNoise, [attrNoise]), `${i.name} must reject unrelated attr churn`).toBe(
      false,
    );
    expect(
      i.expected(addedNoise, [addedNoise]),
      `${i.name} must reject an unrelated ADDED node`,
    ).toBe(false);
  }
});
