// Ground truth, shared by the tests (which inject the fault) and the scorer (which grades DW against it).
// A fault is injected into a test iff FAULT_PROFILE=faults AND the test title matches a group's `match`.
// Each group carries the TRUE cause category DW should name (or that it should route/abstain on), and a
// `kind`: `hard` = a deterministic defect DW should attribute; `slow` = correct-but-slow (DW must NOT
// hard-name a cause — a false-positive trap); `flaky` = intermittent timing.

export const GROUPS = [
  { id: 'covered-overlay',      match: /^modal > confirm/,        fault: 'covered-overlay',      category: 'covered-by-overlay', kind: 'hard' },
  { id: 'input-debounce-clear', match: /^record > notes/,         fault: 'input-debounce-clear', category: 'input-not-committed', kind: 'hard' },
  { id: 'input-mask-truncate',  match: /^record > card/,          fault: 'input-mask-truncate',  category: 'input-not-committed', kind: 'hard' },
  { id: 'offscreen',            match: /^settings > apply/,       fault: 'offscreen',            category: 'off-screen',         kind: 'hard' },
  { id: 'disabled-stuck',       match: /^login > enable/,         fault: 'disabled-stuck',       category: 'disabled',           kind: 'hard' },
  { id: 'app-js-error',         match: /^wizard > complete/,      fault: 'app-js-error',         category: 'app-js',             kind: 'hard' },
  { id: 'backend-500',          match: /^record > post amount/,   fault: 'backend-500',          category: 'backend',            kind: 'hard' },
  // Honesty traps + flakiness (NOT hard defects DW should attribute a DOM cause to):
  { id: 'rpc-settle',           match: /^record > slow save/,     fault: 'rpc-settle',           category: 'settle',             kind: 'slow'  },
  { id: 'flaky-appear',         match: /^dashboard > flaky load/, fault: 'flaky-appear',         category: 'flaky',              kind: 'flaky' },
];

/** The fault to inject for a given test title under the active profile ('clean' → none). */
export function faultFor(title, profile = process.env.FAULT_PROFILE ?? 'clean') {
  if (!['faults', 'flaky', 'realistic'].includes(profile)) return 'clean';
  const g = GROUPS.find((g) => g.match.test(title));
  if (!g) return 'clean';
  // 'flaky' → only the flaky group; 'faults' → the deterministic set; 'realistic' → EVERYTHING (a real
  // CI run: deterministic defects AND intermittent flakiness together).
  if (profile === 'flaky') return g.kind === 'flaky' ? g.fault : 'clean';
  if (profile === 'realistic') return g.fault;
  return g.kind === 'flaky' ? 'clean' : g.fault;
}

/** The ground-truth group for a title, or null when the title is a clean (should-pass) test. */
export function groupFor(title) {
  return GROUPS.find((g) => g.match.test(title)) ?? null;
}
