# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Real-app benchmark harness (`bench/`, `npm run bench`): compares the delta vs
  before+after+diff vs full re-snapshot on a real React SPA, with info-parity,
  noise-floor (null-action), settle, and timing metrics. First directional findings
  in `docs/summaries/v0.5-real-app-benchmark-findings.md` (issue #23): the token win
  holds (delta 0.01× a large re-snapshot; 0.15–0.87× the diff at info-parity), and
  noise/settle/time weaknesses are confirmed and quantified (feeding #13/#15/#18).
- Admissible benchmark (`npm run bench:admissible`, issue #25): runs on a **real,
  unmodified, third-party** app (TodoMVC React, pinned; `bench/corpus/CORPUS.md`) with
  pre-registered interactions incl. a navigation, a **structure-aware order-insensitive
  diff** (`bench/structural-diff.ts`, unit-tested), primary-change recall, and N=30 reps.
  Findings (`docs/summaries/v0.5-admissible-benchmark-findings.md`): the token win holds
  on code we didn't write (0.19–0.45× re-snapshot; 0.27–1.03× a structure-aware diff at
  info-parity), recall 30/30 and settle 0/30-capped on all interactions, and the O(nodes)
  actionability time cost is confirmed (hover-reveal controls pay the full trial timeout).

### Fixed

- Pin the token encoding to `cl100k_base`: the `gpt-tokenizer` 3.x bump had silently
  switched the default `encode` to o200k, invalidating every "cl100k" label. Counts
  are an OpenAI proxy; ratios are the tokenizer-robust signal.

## [0.1.0] - 2026-07-07

### Added

- Core primitive `actAndObserve(page, action)`: arms a MutationObserver, runs the
  action through Playwright, waits for settle, coalesces a net delta of changed
  nodes, reads geometry + `elementFromPoint`, and reconciles each node's
  actionability against Playwright's authoritative `click({ trial: true })` —
  Playwright wins disagreements, which are surfaced as `[geom:…]`.
- Compact text serializer for the delta format, with a cl100k token count.
- Controlled north-star fixture (popup / covered / off-screen / disabled) and a
  12-test suite including verdict-matches-reality checks.
- Developer tooling (ESLint, Prettier, EditorConfig, `.nvmrc`), version-controlled
  git hooks, and CI across Node 20/22.
- OSS + SDLC docs: plan, spec, context, decisions + design-watches, verification
  review, and the go/no-go summary.

### Known limitations

See `docs/summaries/v0.1-milestone.md`. In short: the verdict is
pointer/click-actionability (role-aware probes are v0.5); settle is a simple labeled
heuristic; mutation-noise filtering is untested; and the token win is unproven on the
tiny controlled fixture.

[Unreleased]: https://github.com/mstomar698/deltawright/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mstomar698/deltawright/releases/tag/v0.1.0
