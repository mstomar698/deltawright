// The shared error→synthetic-Delta primitive (extracted from #55 triage so #9 offline
// `diagnose-trace` and the reporter's passive path build a one-node delta the SAME way from an
// error string, and classify it with the SAME guards — one shared classification, not two
// dialects). (The offline path first distils the trace's call-log to the concrete cause line, so
// for a target whose resolved-element HTML carries a stray keyword it can key a DIFFERENT — and
// arguably more precise — cause than the live path that reads the whole message; see read-trace's
// `buildErrorText`.) PURE + browser-free: given a Playwright actionability error it produces a
// minimal Delta the shared `diagnose()` engine can read; the two guards classify a raw error string
// so neither surface fabricates a cause for a non-actionability failure or a gone element.

import type { Delta, DeltaNode } from './types';

/**
 * A locator/timeout that never resolved to an element — degrade to detached, never fabricate.
 * Matches the structured Playwright phrasings for a gone / closed / never-matched target.
 */
export function looksDetached(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('not attached to the dom') ||
    m.includes('element is not attached') ||
    m.includes('was detached from the dom') || // auto-waiting locator retry (a re-render swap)
    m.includes('no element matching') ||
    m.includes('has been closed') // target page / context / browser closed
  );
}

/**
 * Is this a genuine Playwright ACTIONABILITY / timeout failure whose error names a real cause — as
 * opposed to an assertion diff, an app error, or a stack trace that merely CONTAINS a taxonomy word?
 * Only these are diagnosed; everything else stays `unsure` (never fabricate). Matches the structured
 * Playwright phrasings (which appear in the action's error string and its retry call-log), not a bare
 * keyword anywhere in the text.
 */
export function isActionabilityError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /element is not (visible|enabled|stable|editable|attached)/.test(m) ||
    m.includes('intercepts pointer events') ||
    m.includes('outside of the viewport') ||
    looksDetached(m)
  );
}

/** A minimal synthetic Delta carrying the failure's Playwright error, for diagnose() (passive). */
export function syntheticDelta(errorMessage: string): Delta {
  const node: DeltaNode = {
    ref: 'e1',
    kind: 'attrChanged',
    tag: 'element',
    role: null,
    name: null,
    interactive: true,
    parentRef: null,
    geometry: null,
    actionability: {
      verdict: 'NOT-actionable',
      reason: null,
      geometryVerdict: 'n/a',
      // The failed action's own Playwright error IS an authoritative actionability signal, the same
      // source diagnose() treats as authoritative from a trial probe — pass it through verbatim.
      playwright: { actionable: false, error: errorMessage },
      agreed: true,
    },
  };
  return {
    action: 'failed action',
    nodes: [node],
    stats: {
      rawRecords: 0,
      settleMs: 0,
      hitMaxWait: false,
      animationsAwaited: 0,
      droppedBackground: 0,
    },
  };
}
