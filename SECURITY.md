# Security Policy

## Supported versions

Deltawright is pre-1.0; only the latest `main` receives fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's private
vulnerability reporting on the repository's **Security → Report a vulnerability** tab:
<https://github.com/mstomar698/deltawright/security/advisories/new>.

We'll acknowledge within a few days and keep you posted on the fix. Because
Deltawright drives a real browser via Playwright, please include the page/HTML and the
action that triggers the issue where possible.

## Suspicious comments, attachments, and "patches"

Deltawright is a public repository, so drive-by spam and social-engineering happen.
Treat any of the following as hostile until proven otherwise:

- An **unsolicited attachment** — a `.zip`/`.tar.gz`, a "patch", "fix", or "script"
  archive — posted in an issue or PR comment, **especially** from an account created
  recently or with little/no history. Do **not** download, extract, or run it.
- A comment that appears within seconds of a new issue, mirrors the issue text back at
  you, and offers a ready-made script. That is an automated bot pattern engineered to
  get a maintainer to execute untrusted code.

**Policy:** maintainers will **never** ask you to download and run an archive, and will
not run attachments themselves. Legitimate changes arrive only as **reviewable pull
requests** (inspectable diffs) — never as opaque binaries. If you spot such a comment,
report it via the Security tab or flag a maintainer; we hide it as abuse and block the
account.

**Hardening already in place:** new-account interactions on this repo are rate-limited;
the `GITHUB_TOKEN` default is read-only; and CI runs on `pull_request` (never
`pull_request_target`) with `permissions: contents: read`, so a fork PR cannot reach
repository secrets. Dependencies and GitHub Actions are kept patched by Dependabot.
