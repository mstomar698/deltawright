import { test, expect } from '@playwright/test';
import { ensureInjected } from '../src/host/inject';
import type { CollectResult, SettleOptions } from '../src/host/types';

// Unit tests for the injected coalescer: drive controlled DOM mutations and
// assert the NET delta, independent of the north-star fixture.

const SETTLE: SettleOptions = { quietMs: 60, maxWaitMs: 1000, animMaxMs: 200 };

async function armMutateCollect(
  page: import('@playwright/test').Page,
  mutate: () => void,
): Promise<CollectResult> {
  await page.evaluate(() => window.__deltawright!.arm());
  await page.evaluate(mutate);
  await page.evaluate((o) => window.__deltawright!.waitForSettle(o), SETTLE);
  return page.evaluate<CollectResult, SettleOptions>(
    (o) => window.__deltawright!.collect(o),
    SETTLE,
  );
}

test.beforeEach(async ({ page }) => {
  await page.setContent('<!doctype html><html><body><div id="root">seed</div></body></html>');
  await ensureInjected(page);
});

test('add-then-remove within the window nets to nothing', async ({ page }) => {
  const res = await armMutateCollect(page, () => {
    const d = document.createElement('div');
    d.id = 'ephemeral';
    document.body.appendChild(d);
    d.remove();
  });
  expect(res.nodes).toHaveLength(0);
});

test('an added subtree is reported as one ROOT plus its interactive descendants', async ({
  page,
}) => {
  const res = await armMutateCollect(page, () => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<span>label</span><button class="go">Go</button>';
    document.body.appendChild(card);
  });
  // 1 childList record for the whole subtree.
  expect(res.rawRecords).toBe(1);
  // Reported: the card (root) + the button (interactive). The <span> is noise.
  expect(res.nodes).toHaveLength(2);
  const card = res.nodes.find((n) => n.tag === 'div');
  const button = res.nodes.find((n) => n.tag === 'button');
  expect(card?.kind).toBe('added');
  expect(card?.parentRef).toBeNull(); // it is a root
  expect(button?.kind).toBe('added');
  expect(button?.parentRef).toBe(card?.ref); // nested under the card
  expect(button?.name).toBe('Go');
});

test('attribute churn on a surviving element coalesces to one attrChanged node', async ({
  page,
}) => {
  const res = await armMutateCollect(page, () => {
    const root = document.getElementById('root')!;
    root.className = 'a';
    root.className = 'b';
    root.setAttribute('data-x', '1');
  });
  const changed = res.nodes.find((n) => n.kind === 'attrChanged');
  expect(changed).toBeTruthy();
  expect(new Set(changed!.changedAttrs)).toEqual(new Set(['class', 'data-x']));
});

test('a text change on a surviving element is reported as textChanged', async ({ page }) => {
  const res = await armMutateCollect(page, () => {
    document.getElementById('root')!.firstChild!.textContent = 'updated';
  });
  const changed = res.nodes.find((n) => n.kind === 'textChanged');
  expect(changed).toBeTruthy();
  expect(changed!.tag).toBe('div');
});

test('a pre-existing element that is removed is reported as removed', async ({ page }) => {
  const res = await armMutateCollect(page, () => {
    document.getElementById('root')!.remove();
  });
  const removed = res.nodes.filter((n) => n.kind === 'removed');
  expect(removed).toHaveLength(1);
  expect(removed[0]!.tag).toBe('div');
});

test('a pre-existing element moved then removed still nets to removed (not dropped)', async ({
  page,
}) => {
  // The Bug-2 scenario: the moved element appears in addedNodes during the window,
  // but its FIRST touch is a removal, so it pre-existed and must be reported.
  const res = await armMutateCollect(page, () => {
    const root = document.getElementById('root')!;
    const dest = document.createElement('section');
    document.body.appendChild(dest);
    dest.appendChild(root); // move: removed from body, then added to dest
    root.remove(); // then removed for real
  });
  const removed = res.nodes.filter((n) => n.kind === 'removed');
  expect(removed.some((n) => n.tag === 'div')).toBe(true);
});

test('attribute churn that reverts to the original value is NOT reported', async ({ page }) => {
  const res = await armMutateCollect(page, () => {
    const root = document.getElementById('root')!;
    root.setAttribute('data-x', '1');
    root.setAttribute('data-x', '2');
    root.removeAttribute('data-x'); // net: back to the original (absent)
  });
  expect(res.nodes.filter((n) => n.kind === 'attrChanged')).toHaveLength(0);
});

test('a moved node stays "added" (still connected), never "removed"', async ({ page }) => {
  const res = await armMutateCollect(page, () => {
    const d = document.createElement('div');
    d.id = 'mover';
    document.getElementById('root')!.appendChild(d);
    document.body.appendChild(d); // reparent
  });
  const removed = res.nodes.filter((n) => n.kind === 'removed');
  const added = res.nodes.filter((n) => n.kind === 'added');
  expect(removed).toHaveLength(0);
  expect(added.some((n) => n.tag === 'div')).toBe(true);
});
