// Deltawright — a delta-and-actionability layer for Playwright agents.
// It tells the agent what changed after an action and whether it can act on it.

export { actAndObserve, DEFAULT_SETTLE, DEFAULT_BASELINE } from './host/actAndObserve';
export type { Action, ActAndObserveOptions } from './host/actAndObserve';
export { serialize, render, tokenCount } from './host/serialize';
export { annotateActionability, geometryVerdict } from './host/actionability';
export { ensureInjected, injectedSource } from './host/inject';
export type {
  Delta,
  DeltaNode,
  DeltaStats,
  RawDelta,
  RawNode,
  GeometryRead,
  Rect,
  Verdict,
  Actionability,
  ChangeKind,
  SettleOptions,
  SettleResult,
  CollectResult,
  BaselineOptions,
} from './host/types';
