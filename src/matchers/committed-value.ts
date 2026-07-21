import type { Locator } from '@playwright/test';
import { classifyInput, LOSS_SHAPES } from '../host/input-integrity';
import type { InputShape } from '../host/types';

// Input-commit integrity matcher (hardening H1) — `expect(locator).toHaveCommittedValue(intended)`.
//
// A LOUD, LOCATED post-fill gate for a flake class Playwright has no primitive for: an async
// debounce / autocomplete / input-mask / framework listener silently CLEARS, TRUNCATES, or DROPS the
// value AFTER fill()/type() returned success, so a later submit intermittently fails while the fill
// site looks green. This matcher waits for the field's value to STOP CHANGING (catching the async
// debounce-then-clear a synchronous read misses), then names the loss shape via the SAME
// `classifyInput` the live + offline arms use — so all three can't drift.
//
// It is NOT `toHaveValue` reskinned: `toHaveValue` retries toward a value you must SPECIFY and cannot
// tell a benign reformat mask from real loss — asserting `toHaveValue('4111 1111')` FALSE-fails when
// the field intentionally strips the space to `41111111`. This matcher classifies against the value
// you INTENDED to type: a subtractive separator/whitespace mask or a case/reorder reformat is
// `transformed` and PASSES; only real character loss (`never-committed`/`truncated`/`dropped`) fails.
//
// HONESTY (load-bearing): DW-02 — a SEPARATE assertion, it never overrides fill()'s success or
// auto-retypes/repairs the value. DW-03 — it names WHAT happened to the value (the shape), never WHY
// (co-occurrence, not causation: the widget MAY have a debounce; DW does not claim it caused the
// loss); `transformed` → abstain (pass), never flag an intended mask. DW-04 — the closed `LOSS_SHAPES`
// set. PRIVACY — the result + message carry only the shape and the two LENGTHS, never the raw
// intended/committed strings (which can be a password or PII), mirroring `InputIntegrityStat`.

export interface CommittedValueOptions {
  /** Hard cap (ms) on waiting for the field's value to settle before reading it. Default 700. */
  settleMs?: number;
  /** The value is taken as SETTLED once it has not changed for this long (ms). Default 300. This MUST
   *  exceed the widget's async debounce/clear delay: a value-property write fires no event to wait on,
   *  so the only signal is "it stopped changing" — if `quietMs` is shorter than the debounce, the
   *  pre-clear value looks stable and is read as clean. Raise it for a slower widget; a cleanly-committed
   *  field still returns in ~`quietMs`, not the full `settleMs`. */
  quietMs?: number;
  /** How often to re-read the value while waiting for it to settle (ms). Default 25. */
  pollMs?: number;
}

export interface CommittedValueResult {
  /** The committed-vs-intended shape from `classifyInput` (Playwright-independent string comparison). */
  shape: InputShape;
  /** Code-point length of the intended value (never the raw string — PII-safe). */
  intendedLen: number;
  /** Code-point length of the value the field committed after settle (never the raw string — PII-safe). */
  committedLen: number;
  /** True iff `shape` is a real character-loss shape (`never-committed`/`truncated`/`dropped`). */
  isLoss: boolean;
}

const DEFAULT_SETTLE_MS = 700;
const DEFAULT_QUIET_MS = 300;
const DEFAULT_POLL_MS = 25;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const cpLen = (s: string) => Array.from(s).length;

/**
 * Read the locator's value once it has stopped changing (bounded by `settleMs`), so an async
 * debounce-then-clear is observed at its SETTLED value rather than mid-flight. Value changes on an
 * input are `.value`-property writes that a MutationObserver never sees, so this polls the value
 * directly (also CSP-safe — no injection). Returns the settled value.
 */
async function readSettledValue(
  locator: Locator,
  o: Required<CommittedValueOptions>,
): Promise<string> {
  let value = await locator.inputValue();
  const deadline = Date.now() + o.settleMs;
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    await sleep(o.pollMs);
    const v = await locator.inputValue();
    if (v !== value) {
      value = v;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= o.quietMs) {
      break; // the value has been stable for quietMs — treat it as committed
    }
  }
  return value;
}

/**
 * Read the locator's settled committed value and classify it against `intended`. Programmatic core of
 * {@link toHaveCommittedValue}. Throws Playwright's own error if the locator is not an
 * `<input>`/`<textarea>`/`<select>` (a usage error the caller should see).
 */
export async function checkCommittedValue(
  locator: Locator,
  intended: string,
  opts: CommittedValueOptions = {},
): Promise<CommittedValueResult> {
  const o: Required<CommittedValueOptions> = {
    settleMs: opts.settleMs ?? DEFAULT_SETTLE_MS,
    quietMs: opts.quietMs ?? DEFAULT_QUIET_MS,
    pollMs: opts.pollMs ?? DEFAULT_POLL_MS,
  };
  const committed = await readSettledValue(locator, o);
  const shape = classifyInput(intended, committed);
  return {
    shape,
    intendedLen: cpLen(intended),
    committedLen: cpLen(committed),
    isLoss: LOSS_SHAPES.has(shape),
  };
}

/**
 * The Playwright matcher: `expect(locator).toHaveCommittedValue(intended)` passes UNLESS the field's
 * settled value shows real character loss (`never-committed`/`truncated`/`dropped`). A benign reformat
 * mask (`transformed`) passes. Register with `expect.extend(dwMatchers)`. The failure message names the
 * loss shape and the two lengths — never the raw values.
 */
export async function toHaveCommittedValue(
  locator: Locator,
  intended: string,
  opts?: CommittedValueOptions,
): Promise<{ pass: boolean; message: () => string }> {
  const r = await checkCommittedValue(locator, intended, opts);
  const pass = !r.isLoss;
  const lens = `${r.intendedLen} intended → ${r.committedLen} committed chars`;
  const message = () =>
    pass
      ? `expected the field NOT to commit the intended value, but it committed \`${r.shape}\` (${lens})`
      : `expected the field to commit the intended value, but it was \`${r.shape}\` — real character loss after the async settle, not a formatting mask (${lens})`;
  return { pass, message };
}
