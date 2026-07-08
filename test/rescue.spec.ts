import { test, expect } from '@playwright/test';
import { actAndObserve } from '../src/index';
import { fixtureUrl } from './helpers';

// Anchor-aware background rescue (#30). The pre-arm baseline (from #15/#30-slice) drops
// element-insertion signatures that were already recurring before the action. That drop
// is all-or-nothing per signature, so it also eats the action's OWN instance of a
// background-looking signature (e.g. a confirmation reusing a toast class). The #30
// trusted-event anchor makes the drop per-root: the action-local instance is RESCUED
// (kept) while the far background instances are still dropped. It is KEEP-ONLY — it can
// never cause a drop — so enabling it strictly reduces false-drops, and the default
// (flag off) path is byte-identical to the shipped slice.

const savedNode = (nodes: { name: string | null }[]) => nodes.some((n) => n.name === 'Saved');

test('with the anchor on, the action-local instance of a background signature is rescued; far background is dropped', async ({
  page,
}) => {
  await page.goto(fixtureUrl('rescue.html'));
  const delta = await actAndObserve(page, (p) => p.click('#open'), {
    label: 'save',
    inWindowRecurrence: true,
  });

  // The confirmation (same "div>div.toast" signature as the background toasts, but
  // rendered inside the clicked control) is KEPT.
  expect(savedNode(delta.nodes), 'action-local confirmation should be rescued').toBe(true);
  // The far background toasts of the same signature are still dropped, so the delta
  // stays tiny (~just the confirmation) instead of leaking ~30 toasts.
  expect(delta.nodes.length).toBeLessThanOrEqual(3);
  expect(delta.stats.droppedBackground, 'far background toasts still dropped').toBeGreaterThan(0);
});

test('additivity: with the anchor OFF (default), the shipped slice drops the action-local instance too', async ({
  page,
}) => {
  await page.goto(fixtureUrl('rescue.html'));
  const delta = await actAndObserve(page, (p) => p.click('#open'), { label: 'save' });

  // Shipped behavior: the confirmation shares the background signature and there is no
  // anchor to spare it, so it is dropped along with the far toasts. This is the latent
  // false-drop the #30 anchor fixes — and proves the feature is purely additive.
  expect(savedNode(delta.nodes), 'without the anchor the confirmation is dropped').toBe(false);
  expect(delta.stats.droppedBackground).toBeGreaterThan(0);
});

test('parity: an untrusted (script-dispatched) action latches no anchor, so behavior matches the shipped slice', async ({
  page,
}) => {
  await page.goto(fixtureUrl('rescue.html'));
  // A scripted .click() fires an isTrusted=false event, so the anchor never latches even
  // with the flag on — the rescue is unreachable and we fall back to the shipped drop.
  const delta = await actAndObserve(
    page,
    (p) => p.evaluate(() => (document.getElementById('open') as HTMLElement).click()),
    { label: 'save', inWindowRecurrence: true },
  );

  expect(savedNode(delta.nodes), 'no trusted anchor => no rescue (shipped parity)').toBe(false);
  expect(delta.stats.droppedBackground).toBeGreaterThan(0);
});

test('rescuing a root folds its mutating descendants into the added subtree (fixing the flag-off orphan)', async ({
  page,
}) => {
  await page.goto(fixtureUrl('rescue-nested.html'));

  // Flag ON: the confirmation root is rescued, so its non-interactive descendant's text
  // change is folded into the added subtree — reported as part of the added root, not as
  // a standalone textChanged node. Keep-only operates on added ROOTS; a rescued root
  // correctly re-scopes its descendants (as every added subtree does).
  const on = await actAndObserve(page, (p) => p.click('#open'), {
    label: 'save',
    inWindowRecurrence: true,
  });
  expect(savedNode(on.nodes), 'confirmation root rescued').toBe(true);
  expect(
    on.nodes.filter((n) => n.kind === 'textChanged'),
    'the descendant text change is folded into the added subtree, not double-reported',
  ).toHaveLength(0);

  // Flag OFF (shipped): the root is dropped as background, orphaning the descendant —
  // its text change surfaces as a standalone textChanged with no reported parent root.
  // The rescue is therefore MORE correct, not merely additive at the node level.
  await page.goto(fixtureUrl('rescue-nested.html'));
  const off = await actAndObserve(page, (p) => p.click('#open'), { label: 'save' });
  expect(savedNode(off.nodes), 'without rescue the root is dropped').toBe(false);
  expect(
    off.nodes.filter((n) => n.kind === 'textChanged').length,
    'the orphaned descendant surfaces standalone when its root is dropped',
  ).toBeGreaterThan(0);
});

test('no-drop: a streamed same-signature payload with an empty baseline is never dropped', async ({
  page,
}) => {
  await page.goto(fixtureUrl('stream.html'));
  // The action streams 10 <li.row> siblings (a real causal payload). The baseline is
  // empty, so the signature is not background and nothing may be dropped — the anchor
  // never independently condemns an in-window signature.
  const delta = await actAndObserve(page, (p) => p.click('#load'), {
    label: 'load',
    inWindowRecurrence: true,
  });

  const rows = delta.nodes.filter((n) => n.tag === 'li');
  expect(rows.length, 'every streamed row is kept').toBe(10);
  expect(delta.stats.droppedBackground, 'nothing dropped with an empty baseline').toBe(0);
});
