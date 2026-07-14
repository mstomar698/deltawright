// v0.9 Move 1 — the OFFLINE input-integrity arm (#81). The live arm (actAndObserve) reads a field's
// committed `el.value` after settle and classifies it against the intended value; this reconstructs the
// SAME finding from a Playwright trace, with no live browser. It is a COMPLEMENT to the live arm, never a
// replacement — see the honest limits below.
//
// PURE, browser-free (mirrors `deriveRouting` in routing.ts): given a parsed trace it returns findings,
// so it is unit-testable without a zip. The trace-parsing (extracting the intended value from the action
// and the committed value from the after-snapshot) is kept OUT of `classifyInput` — we IMPORT that one
// FP-guarded classifier from the host so the offline and live arms name the same shape and can't drift.
//
// The reconstruction:
//  • INTENDED  = a value action's `params.value`/`params.text` (read by the trace reader onto
//    `TraceAction.value`).
//  • COMMITTED = the target field's `__playwright_value_` in the frame-snapshot named `after@<callId>`
//    (the DOM state Playwright captured right after the action) — matched to the target by the
//    snapshotter's `__playwright_target__` stamp, falling back to the action selector's id/name key.
//  • classify → a LOSS shape (never-committed / truncated / dropped) emits a `suspected`
//    `input-not-committed` finding; `clean` and `transformed` (a mask) emit NOTHING.
//
// HONEST LIMITS (documented in the report + the ADR, so an agent never over-trusts this):
//  (a) The `after@` snapshot is captured immediately after the action returns, so it can PREDATE a
//      deferred async drop (the debounce-then-clear SuggestBox pathology) — offline can MISS what the
//      LIVE arm, which reads AFTER the settle window, catches. This arm sees only drift already visible
//      in the snapshot.
//  (b) Low yield on timeout-dominated corpora, where the failure is not a value-assertion at all.
//  It is "typed X, the after-snapshot shows Y — suspected input-drop," NEVER "Playwright's fill failed"
//  (Playwright's fill/type succeeded; the field mutated the value after — DW-02/03).

import { classifyInput, LOSS_SHAPES } from '../host/input-integrity';
import type { TraceInfo, SnapshotField, TraceAction } from './read-trace';

/** The LOSS shapes the offline arm reports (a `transformed` mask and `clean` are never flagged). */
export type InputLossShape = 'never-committed' | 'truncated' | 'dropped';

/**
 * One reconstructed input-integrity finding (v0.9 Move 1 offline arm). Always `suspected` — it was not
 * live-probed. PRIVACY: it carries the shape + the two LENGTHS only, never the raw intended/committed
 * strings (which can be a password / PII), mirroring the live arm's `InputIntegrityStat`.
 */
export interface InputIntegrityFinding {
  /** The value action's callId. */
  callId: string;
  /** fill / type / pressSequentially — the value-bearing method. */
  method: string;
  /** The action's target selector, when it had one (for the human line). */
  selector?: string;
  /** never-committed / truncated / dropped — the named loss shape. */
  shape: InputLossShape;
  /** Length (code points) of the value the caller intended to enter. */
  intendedLen: number;
  /** Length (code points) of the value the after-snapshot shows the field committed. */
  committedLen: number;
}

/** The value-bearing methods whose intended value we reconstruct (case-insensitive match). */
const VALUE_METHODS: ReadonlySet<string> = new Set(['fill', 'type', 'presssequentially']);

/**
 * The identifying `{id?, name?}` key of an action's target, parsed from its (css) selector — enough to
 * match the field in the snapshot when the target stamp is absent. A role/label/text selector yields no
 * key (→ no match → honest silence), which is correct: we never guess which field an opaque selector hit.
 */
function selectorKey(selector: string | undefined): { id?: string; name?: string } {
  if (!selector) return {};
  const key: { id?: string; name?: string } = {};
  // `[id="x"]` / `[id='x']` / `[id=x]` (last wins), then a bare `#id` (last wins) — either names the id.
  const attrId = [...selector.matchAll(/\[\s*id\s*=\s*["']?([^"'\]\s]+)["']?\s*\]/g)].pop();
  const hashId = [...selector.matchAll(/#([A-Za-z_][\w-]*)/g)].pop();
  if (attrId) key.id = attrId[1];
  else if (hashId) key.id = hashId[1];
  const attrName = [...selector.matchAll(/\[\s*name\s*=\s*["']?([^"'\]]+?)["']?\s*\]/g)].pop();
  if (attrName) key.name = attrName[1];
  return key;
}

/**
 * Resolve the committed value of the action's target among the snapshot's value-bearing fields, or
 * `undefined` when it cannot be confidently identified (→ emit nothing, never fabricate). Precedence:
 *  1. the UNIQUE field the snapshotter stamped `__playwright_target__` (the action's own target);
 *  2. the UNIQUE field whose `id` matches the selector key;
 *  3. the UNIQUE field whose `name` matches the selector key.
 * Any ambiguity (0 or >1 candidates at every tier) → undefined (honest silence).
 */
function resolveCommitted(
  fields: SnapshotField[],
  key: { id?: string; name?: string },
): string | undefined {
  const uniq = (cands: SnapshotField[]): string | undefined =>
    cands.length === 1 ? cands[0]!.value : undefined;

  const stamped = fields.filter((f) => f.isTarget);
  const byStamp = uniq(stamped);
  if (byStamp !== undefined) return byStamp;

  if (key.id) {
    const byId = uniq(fields.filter((f) => f.id === key.id));
    if (byId !== undefined) return byId;
  }
  if (key.name) {
    const byName = uniq(fields.filter((f) => f.name === key.name));
    if (byName !== undefined) return byName;
  }
  return undefined;
}

/** The intended value of a value-bearing action, or undefined when it is not one / carried none. */
function intendedFor(action: TraceAction): string | undefined {
  if (!VALUE_METHODS.has(action.method.toLowerCase())) return undefined;
  return action.value;
}

/**
 * Reconstruct offline input-integrity findings from a parsed trace (v0.9 Move 1). PURE. For each value
 * action with a known intended value AND an `after@<callId>` snapshot whose target field we can resolve,
 * it runs the shared `classifyInput` and emits a finding ONLY for a real LOSS shape — a `clean` or
 * `transformed` (mask) value, an unresolved target, or a missing snapshot all emit NOTHING.
 */
export function deriveInputIntegrity(info: TraceInfo): InputIntegrityFinding[] {
  const out: InputIntegrityFinding[] = [];
  for (const action of info.actions) {
    const intended = intendedFor(action);
    if (intended === undefined) continue;
    // The snapshot Playwright captured for THIS action's after-phase — the committed DOM state.
    const snap = info.frameSnapshots.find((s) => s.snapshotName === `after@${action.callId}`);
    if (!snap || snap.fields.length === 0) continue;
    const committed = resolveCommitted(snap.fields, selectorKey(action.selector));
    if (committed === undefined) continue; // could not identify the field → never fabricate
    const shape = classifyInput(intended, committed);
    if (!LOSS_SHAPES.has(shape)) continue; // clean OR transformed (a mask) → not flagged (DW-03)
    out.push({
      callId: action.callId,
      method: action.method,
      selector: action.selector,
      shape: shape as InputLossShape,
      intendedLen: Array.from(intended).length,
      committedLen: Array.from(committed).length,
    });
  }
  return out;
}
