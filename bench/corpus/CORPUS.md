# Benchmark corpus (Tier-1: third-party apps)

These are **unmodified, third-party** applications vendored **verbatim** for a
reproducible, offline, author-bias-free benchmark (issue #25). We do not author or
tune them — that is the point: the delta must earn its keep on code we did not write.

## todomvc-react

- **Source:** [tastejs/todomvc](https://github.com/tastejs/todomvc) — the canonical
  cross-framework reference app ("TodoMVC").
- **Pinned commit (gh-pages):** `07f3c4bcbd38e2a10c996493e9a541755f042f1b`
- **Path:** `examples/react/dist/` (a production React build).
- **License:** MIT (TodoMVC). Copyright © the TodoMVC authors.
- **Vendored files + sha256 (integrity):**
  - `index.html` — `23b40a8b71f26e44f3e72e682188a3ab238d17fd375ff0ec06295af9971fa959`
  - `app.bundle.js` — `6197ad9358985fb3f745aef3fca9abbe2fc7f0cd35cd4525cb8570107ae6b78a`
  - `app.css` — `a0ccea8c39f22bcad35a2821b1e1009a05e028e51884649d0cd1552776b0fdef`
  - `base.js` — `8cfbaa8d2bc03e2e52a8b7788e041efda231a17e2a25c8bc4bfe2659adc5bb90`

Re-fetch (pinned):
`curl -sSL "https://cdn.jsdelivr.net/gh/tastejs/todomvc@07f3c4bcbd38e2a10c996493e9a541755f042f1b/examples/react/dist/<file>"`

## Why vendored (not fetched at runtime)
The red-team required the DOM to be **frozen and re-runnable offline** ("captured once,
replayed offline"). Committing the pinned snapshot makes the benchmark independent of
network/CDN availability and immune to upstream drift. These files are excluded from
lint/format (they are third-party build artifacts).

## Not yet in the corpus (tracked in #25)
- A second framework (Vue TodoMVC — uses ES modules, needs an HTTP origin, so a static
  server rather than `file://`).
- Tier-2 production sites captured to HAR/WARC and replayed offline.
