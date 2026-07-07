# Contributing to Deltawright

Thanks for helping close the "present-but-not-actionable" gap for browser agents.
Deltawright is small and opinionated on purpose; this guide keeps it that way.

## Smoke test (prove the repo works)

```bash
npm install
npx playwright install chromium   # if Chromium isn't already cached
npm test                          # coalescer units + north-star validation (8 tests)
npm run demo                      # prints the actual delta for all three cases
```

## Checks that must pass before a PR

```bash
npm run typecheck                 # tsc --noEmit, zero errors
npm test                          # all Playwright tests green
```

CI runs both on every PR (`.github/workflows/ci.yml`). A red check blocks merge.

## Read first

1. `ideation-agent-delta-layer.md` — the binding design doc (§3 delta format, §5 architecture, §6 hard parts, §7 scope, §10 go/no-go).
2. `docs/plans/` — the current milestone plan. **No non-trivial code without a plan slice it traces to.**
3. `docs/decisions/design-watches.md` — the judgment rules every change is reviewed against (currently DW-01 settle, DW-02 actionability alignment).

## Public contracts (breaking these needs a heads-up)

- Everything exported from `src/index.ts` — `actAndObserve`, `serialize`/`render`/`tokenCount`, and the delta types (`Delta`, `DeltaNode`, `RawNode`, `GeometryRead`, `Actionability`, `Verdict`).
- The compact delta text format (§3). Downstream agents parse it.

## Conventions

- kebab-case for files/dirs; `SCREAMING_SNAKE` for constants; explicit types on exported functions.
- The injected script (`src/injected/observer.ts`) runs in the page — no Node APIs, DOM only.
- Delta membership is **mutation-derived only**. Geometry (`rect` / `elementFromPoint`) is an *annotation*; never use it to drop a node.
- Playwright's actionability verdict is authoritative and **wins** every disagreement with our geometry read.
- Every changed line traces to a plan slice; acceptance criteria are written as `should_*` test names.

## No-go zones (stop and get review)

- `src/host/actionability.ts` — do not introduce a verdict that can override Playwright.
- `src/injected/observer.ts` `coalesce` / `readGeometry` — do not turn geometry into a membership filter.

## How changes are made

Open a PR against `main`. Fill in `.github/PULL_REQUEST_TEMPLATE.md` (link the plan,
list what shipped / did not ship, complete the reviewer checklist). Tag a maintainer.
No merges without green CI and a review. Commit messages follow Conventional Commits
(`feat:`, `fix:`, `docs:`, `test:`, `chore:`), imperative mood.

## Developer Certificate of Origin (sign-off)

By contributing you certify the [DCO](https://developercertificate.org/). Sign your
commits:

```bash
git commit -s -m "feat: ..."
```

which appends `Signed-off-by: Your Name <you@example.com>`.

## Owners

- Maintainer / review lead: the repo owner (see `package.json`).

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).
