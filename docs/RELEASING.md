# Releasing Deltawright

**One version bump = one full release.** A bump to `package.json` ships as: a git tag `vX.Y.Z`, an
npm publish, and a matching GitHub release — kept in lock-step so `npm` == git tag == changelog never
drift. This is automated: **pushing a `vX.Y.Z` tag** triggers
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which builds, runs the full
suite **and the three accuracy floors**, publishes to npm, and cuts the GitHub release.

The accuracy floors are the release gate. Nothing publishes if
[`npm run bench:accuracy`](../bench/run-accuracy.ts) fails (DW-02 live-verdict 100%,
confirmed-precision ≥ 95%, silent-miss ≤ 5%). Accuracy is the primary correctness bar for this
project; a bump that regresses it does not ship.

## One-time setup (owner) — npm OIDC trusted publishing

The workflow authenticates to npm with **OIDC trusted publishing**: no long-lived `NPM_TOKEN` secret,
no OTP prompt, and npm attaches build **provenance** automatically. This must be configured once on
npmjs.com before the first automated publish:

1. Sign in to <https://www.npmjs.com> as the `deltawright` package owner.
2. Go to the package → **Settings** → **Trusted Publisher**.
3. Add a **GitHub Actions** publisher:
   - Repository: `mstomar698/deltawright`
   - Workflow filename: `release.yml`
   - (Environment: leave blank — the workflow uses none.)
4. Save. Trusted publishing requires 2FA on the account (which the owner already has), but it is
   **not** prompted during CI — the OIDC exchange replaces it.

Once configured, every tag push publishes with zero secret handling. This directly retires the manual
2FA/OTP pain from cutting `0.6.0` and `0.7.0` by hand (a plain `npm login` token is OTP-gated and kept
401-ing; the workaround was an automation token in `~/.npmrc`).

## One-time setup (owner) — make the accuracy floors a merge gate

CI runs the `accuracy` job (the three floors) on every PR, but **defining the job does not by itself
block a merge**. GitHub only blocks a merge when the check name is listed in the `main` branch
ruleset's required status checks. Until that is done, an accuracy regression shows a red check but the
PR is still mergeable — so this step is what turns "runs in CI" into "cannot merge a regression."

The repo already has an active branch ruleset (`delta-main`) enforcing linear history / no
force-push. Add the required status checks to it once (owner, needs admin):

```bash
# Names must match the CI job `name:` fields EXACTLY.
gh api --method PUT repos/mstomar698/deltawright/rulesets/18763432 \
  -f name='delta-main' -f target='branch' -f enforcement='active' \
  --input - <<'JSON'
{
  "name": "delta-main",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "exclude": [], "include": ["~DEFAULT_BRANCH"] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "required_deployments", "parameters": { "required_deployment_environments": [] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": true,
        "required_status_checks": [
          { "context": "build (node 20)" },
          { "context": "build (node 22)" },
          { "context": "accuracy floors (DW-02 / precision / silent-miss)" }
        ] } }
  ]
}
JSON
```

Verify with `gh api repos/mstomar698/deltawright/rulesets/18763432 --jq '.rules[].type'` (expect a
`required_status_checks` entry). After this, a PR that reddens the accuracy job cannot be merged.

## Cutting a release

From a clean `main` with the work already merged:

```bash
# 1. Bump the version (patch = fix, minor = feature, major = breaking — SemVer).
npm version patch --no-git-tag-version        # or minor / major / 0.7.1 etc.

# 2. Roll the changelog: move [Unreleased] entries into a new ## [X.Y.Z] - <date> section.
#    (Edit CHANGELOG.md by hand — the release workflow reads this section for the GitHub notes.)

# 3. Commit, open a PR, merge to main as usual.

# 4. Tag the merge commit and push the tag — this fires the release workflow.
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The workflow then, on the tag:

1. Verifies the tag matches `package.json` version (refuses to release on drift).
2. Builds `dist/`, runs `npm run check` (typecheck + lint + format + test).
3. Runs the **accuracy gate** — publish is blocked on any floor breach.
4. Publishes to npm via OIDC (idempotent: skips if the version is already on the registry).
5. Creates the GitHub release with the changelog section as notes (idempotent: skips if it exists).
   Hyphenated versions (`0.8.0-rc.1`) publish to the `next` dist-tag and are marked pre-release.

## Manual fallback (before OIDC is configured, or if CI is down)

Both automated steps are **idempotent**, so a manual publish is safe — a later workflow run over the
same tag detects the published version / existing release and skips them.

```bash
# Requires an npm automation/granular access token in ~/.npmrc (bypasses 2FA/OTP).
npm run build
npm run bench:accuracy          # do NOT publish if this fails
npm publish                     # prepack rebuilds; unscoped name, no --access needed
gh release create vX.Y.Z --title vX.Y.Z --notes "…"   # owner must name the public surface
```

Notes:

- `prepack` runs a ~10s clean build; if ever forced back to interactive OTP, prebuild and
  `npm publish --ignore-scripts` so the upload is instant and the OTP window can't expire.
- The npm-11 `bin` `./`-prefix "invalid and removed" warning is **benign** — the bins install and
  run correctly.
