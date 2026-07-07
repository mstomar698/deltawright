# decisions

Two append-only stores capture what we decided and why, so future contributors
don't relitigate settled questions.

- **`YYYY-MM.md`** — the monthly **decision log (ADRs)**. One entry per decision,
  newest at the bottom, never edited. Supersede a past decision with a new dated
  entry that references the old one.
- **`design-watches.md`** — the small register of **judgment-only rules** that must
  gate future plans/reviews and that CI cannot mechanically enforce.

## The lesson router

When a lesson surfaces (a bug, a near-miss, a "we should always…"), route it — do
not default to writing prose:

1. **Can a linter / type-checker / CI catch it?** → Add the mechanical gate
   (a test, a `tsc` rule, a CI step). No prose. *Most enforceable lessons stop here.*
2. **Is the process/skill itself wrong?** → Write an improvement note under
   `docs/improvements/`.
3. **Is it just rationale worth re-reading?** → Record an **ADR** in the monthly log.
   *Most lessons stop here.*
4. **Must it gate every future plan/review in THIS repo, judgment-only and
   repo-specific?** → Also add a **`DW-NN`** design-watch (with a mandatory
   *retire-when*). Cap ~10–12 active; a watch with no retire-when is refused.

## ADR format

```markdown
## YYYY-MM-DD — <decision title, one sentence>

**Decision:** <what was decided>

**Context:** <what prompted this>

**Alternatives rejected:**
- <alt> — <why rejected>

**Affected areas:** <files / modules / contracts>

**Tags:** `architecture` / `security` / `contract` / `pattern` / `performance` / `tooling`
```

## Design-watch format

See the template comment at the top of `design-watches.md`.
