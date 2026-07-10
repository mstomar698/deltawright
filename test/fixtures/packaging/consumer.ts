// A by-name consumer of the published package. It is typechecked against the built
// dist/ types the way an installed consumer resolves them (package self-reference via
// the `exports` map, nodenext resolution) — see test/fixtures/packaging/tsconfig.json.
// It never runs; it exists purely to prove the shipped types are importable and usable.
import {
  actAndObserve,
  serialize,
  render,
  checksum,
  suggest,
  type Delta,
  type DeltaNode,
  type ActAndObserveOptions,
  type SuggestResult,
} from 'deltawright';
// The second declared entry point must resolve to a real module with usable types too.
import { DeltawrightSession, startServer } from 'deltawright/mcp';
// …as must the matchers subpath (#53/#54): the preflight fn, the checksum matcher + its pure core,
// the matcher bag, and the option/result types.
import {
  preflight,
  matchDeltaChecksum,
  dwMatchers,
  type PreflightOptions,
  type PreflightResult,
  type ChecksumMatchResult,
} from 'deltawright/matchers';

// …and the reporter subpath (#55): the default Reporter class + the pure triage core + types.
import DeltawrightReporter, {
  triageFailure,
  DELTA_ATTACHMENT_NAME,
  type Sidecar,
  type TriageInput,
} from 'deltawright/reporter';
// …and the wait subpath (#58): the settle-signal fn + its observation type.
import {
  observeConsequences,
  type ConsequenceObservation,
} from 'deltawright/wait';

export const primitive = actAndObserve;
export const mcp = { DeltawrightSession, startServer };
export const matchers = { preflight, matchDeltaChecksum, dwMatchers };
export const reporter = { DeltawrightReporter, triageFailure, DELTA_ATTACHMENT_NAME };
export type Triage = { input: TriageInput; sidecar: Sidecar };
export const wait = { observeConsequences };
export type Consequence = ConsequenceObservation;
export const opts: ActAndObserveOptions = { label: 'demo' };
export const suggestFn = suggest;
export type Suggestions = SuggestResult;
export const preflightOpts: PreflightOptions = { trialTimeoutMs: 800 };
export type Preflight = PreflightResult;
export type Checksum = ChecksumMatchResult;

export function summarize(delta: Delta): { line: string; tokens: number; sum: string } {
  const first: DeltaNode | undefined = delta.nodes[0];
  const text = serialize(delta);
  const out = render(delta);
  return {
    line: `${first?.ref ?? '-'}:${text.length}`,
    tokens: out.tokens,
    sum: checksum(delta),
  };
}
