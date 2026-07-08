import { test, expect } from '@playwright/test';
import { actAndObserve, diagnose, serialize, checksum } from '../src/index';
import type { Delta } from '../src/index';
import { fixtureUrl } from './helpers';

// Gap-E (#49): a two-wave render whose second wave lands after settle is today silently
// under-reported. The opt-in lateWatchMs moves it from SILENT to FLAGGED — detected, never
// captured — while the default path stays byte-unchanged.

test('should_flag_late_wave_suspected_when_a_structural_mutation_lands_after_settle_within_lateWatchMs', async ({
  page,
}) => {
  await page.goto(fixtureUrl('late-wave.html'));
  const delta = await actAndObserve(page, (p) => p.click('#open'), {
    label: 'open',
    lateWatchMs: 1200,
  });

  // FLAGGED: the late structural wave is recorded in stats and diagnosed.
  expect(delta.stats.lateStructural).toBe(true);
  const diag = diagnose(delta).diagnoses.find((d) => d.code === 'late-wave-suspected');
  expect(diag).toBeDefined();
  expect(diag?.confidence).toBe('suspected');
  expect(diag?.scope).toBe('delta');

  // NOT CAPTURED: wave 1 is in the delta, wave 2 is not (it landed after the frozen point).
  const names = delta.nodes.map((n) => n.name);
  expect(names).toContain('Wave One');
  expect(names).not.toContain('Wave Two');
});

test('should_keep_default_settle_path_byte_unchanged_when_lateWatchMs_is_zero', async ({
  page,
}) => {
  await page.goto(fixtureUrl('late-wave.html'));
  const delta = await actAndObserve(page, (p) => p.click('#open'), { label: 'open' });

  // The gap-E field is ABSENT (not merely false) on the default path, so nothing that reads
  // stats sees a new key, and no late-wave diagnosis is produced.
  expect('lateStructural' in delta.stats).toBe(false);
  expect(diagnose(delta).diagnoses.some((d) => d.code === 'late-wave-suspected')).toBe(false);
  // Default capture is unchanged: wave 1 present, wave 2 (still after settle) absent.
  const names = delta.nodes.map((n) => n.name);
  expect(names).toContain('Wave One');
  expect(names).not.toContain('Wave Two');
});

test('should_pass_full_suite_as_regression_guard', () => {
  // The new stats field is purely additive: with it set, the serialized bytes and the
  // checksum are identical to a delta without it — so it can never move the default output.
  const base: Delta = {
    action: 'open',
    nodes: [],
    stats: {
      rawRecords: 2,
      settleMs: 130,
      hitMaxWait: false,
      animationsAwaited: 0,
      droppedBackground: 0,
    },
  };
  const withLate: Delta = { ...base, stats: { ...base.stats, lateStructural: true } };
  expect(serialize(withLate)).toBe(serialize(base));
  expect(checksum(withLate)).toBe(checksum(base));
});
