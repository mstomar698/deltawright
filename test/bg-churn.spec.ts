import { test, expect } from '@playwright/test';
import { actAndObserve, diagnose } from '../src/index';
import type { Delta, DeltaNode } from '../src/index';
import { fixtureUrl } from './helpers';

// Background-churn detection (#7). Detects a container that STARTS churning AFTER the action (a
// polling feed) — invisible to the pre-arm baseline — and flags it as `background-churn` (SUSPECTED).
// It is NON-BEHAVIORAL: settle timing and delta membership are unchanged (per #30, in-window signal
// must flag, never drop). The `hitMaxWait` gate keeps a bounded list that quiesces from being flagged
// (a slow/large payload that also caps is an acknowledged suspected-only residual — see the ADR).

const SHORT = { maxWaitMs: 400, quietMs: 100 };

test('detects post-action feed churn as background-churn (suspected) without changing settle or membership', async ({
  page,
}) => {
  await page.goto(fixtureUrl('post-action-churn.html'));
  const delta = await actAndObserve(page, (p) => p.click('#start-feed'), {
    label: 'start feed',
    ...SHORT,
  });

  // The recurrence is detected and surfaced as a suspected background-churn diagnosis.
  expect(delta.stats.recurringInsert).toBeGreaterThanOrEqual(4);
  expect(delta.stats.hitMaxWait).toBe(true); // the feed is unbounded → settle hit the cap
  const d = diagnose(delta);
  const churn = d.diagnoses.find((x) => x.code === 'background-churn');
  expect(churn, 'background-churn should be diagnosed').toBeTruthy();
  expect(churn!.confidence).toBe('suspected');

  // NON-BEHAVIORAL (per #30): the feed rows are KEPT in the delta (flag, don't drop) — they were not
  // in the pre-arm baseline, so nothing is dropped as background here.
  expect(delta.stats.droppedBackground).toBe(0);
  expect(delta.nodes.some((n) => n.kind === 'added' && n.tag === 'div')).toBe(true);
});

test('a bounded reveal (recurs then stops) is NOT flagged as background churn', async ({
  page,
}) => {
  await page.goto(fixtureUrl('post-action-churn.html'));
  const delta = await actAndObserve(page, (p) => p.click('#reveal-few'), {
    label: 'reveal few',
    ...SHORT,
  });

  // Same-signature inserts, but the page goes quiet (bounded) → settle quiesces, no churn flag.
  expect(delta.stats.hitMaxWait).toBe(false);
  expect(delta.stats.recurringInsert).toBeUndefined(); // below-threshold OR quiesced → field absent
  const d = diagnose(delta);
  expect(d.diagnoses.some((x) => x.code === 'background-churn')).toBe(false);
  // The revealed cards are captured (they are the action's real effect).
  expect(delta.nodes.some((n) => n.kind === 'added' && n.tag === 'div')).toBe(true);
});

// --- diagnose unit (hand-built deltas) ------------------------------------------------------------

function delta(over: Partial<Delta['stats']> = {}, nodes: DeltaNode[] = []): Delta {
  return {
    action: 'x',
    nodes,
    stats: {
      rawRecords: 1,
      settleMs: 400,
      hitMaxWait: true,
      animationsAwaited: 0,
      droppedBackground: 0,
      ...over,
    },
  };
}
const hasChurn = (d: Delta) => diagnose(d).diagnoses.some((x) => x.code === 'background-churn');

test('diagnose: recurringInsert grounds background-churn only when at threshold AND settle hit the cap', () => {
  // At/above threshold + hitMaxWait → suspected background-churn.
  expect(hasChurn(delta({ recurringInsert: 8, hitMaxWait: true }))).toBe(true);
  // At threshold but settle quiesced (bounded) → NOT flagged.
  expect(hasChurn(delta({ recurringInsert: 8, hitMaxWait: false }))).toBe(false);
  // Below threshold → NOT flagged (conservative).
  expect(hasChurn(delta({ recurringInsert: 3, hitMaxWait: true }))).toBe(false);
  // The pre-arm baseline path is unaffected (dropped churn still fires).
  expect(hasChurn(delta({ droppedBackground: 12, hitMaxWait: false }))).toBe(true);
});
