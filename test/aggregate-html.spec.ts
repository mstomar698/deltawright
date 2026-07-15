import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { aggregate, renderHtml, type FlakeRecord } from '../src/aggregate';

// The flake HTML dashboard (Wave-1 #2). renderHtml is a pure view over the SAME FlakeReport the
// aggregator already produces — these assert on the returned document string (it writes nothing).

function rec(over: Partial<FlakeRecord> = {}): FlakeRecord {
  return {
    testId: 'suite > a test',
    runId: 'run-1',
    code: 'disabled',
    confidence: 'confirmed',
    category: 'actionability-blocking',
    hitMaxWait: false,
    disagreement: false,
    detached: false,
    lateWave: false,
    staleRect: false,
    detail: 'the target <button> is disabled',
    source: 'error-text',
    diagnoses: [
      {
        code: 'disabled',
        confidence: 'confirmed',
        scope: 'node',
        detail: 'element is not enabled',
      },
    ],
    ...over,
  };
}

test('should_render_a_self_contained_theme_aware_dashboard_from_a_report', () => {
  // Test A: 2 failures, 1 hit the settle cap, 1 disagreed → 50% each. Test B: a single unsure record.
  const report = aggregate([
    rec({ testId: 'suite > flaky A', runId: 'run-1', hitMaxWait: true }),
    rec({ testId: 'suite > flaky A', runId: 'run-2', disagreement: true }),
    rec({ testId: 'suite > sometimes B', runId: 'run-1', code: 'unsure', category: null }),
  ]);
  const html = renderHtml(report);

  // Self-contained + valid document, offline-safe — no external asset of ANY kind.
  expect(html.startsWith('<!doctype html>')).toBe(true);
  expect(html).toContain('<title>Deltawright — Flake Triage</title>');
  expect(html).not.toContain('://'); // no protocol reference (http/https/ws/...) anywhere
  expect(html).not.toMatch(/@import|url\(/i); // no external CSS import / url()
  expect(html).not.toMatch(/<(img|iframe|link|source|video|audio|embed|object)\b/i); // no asset tags
  expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i); // the only <script> is inline (no src)
  // Theme-aware: prefers-color-scheme default + a forced-theme override + a persistence toggle.
  expect(html).toContain('@media (prefers-color-scheme: dark)');
  expect(html).toContain('[data-theme="dark"]');
  expect(html).toContain("getElementById('theme-toggle')");

  // Renders the ranked tests (most-flaky first: A with 2 failures before B with 1).
  expect(html.indexOf('flaky A')).toBeLessThan(html.indexOf('sometimes B'));
  expect(html).toContain('Actionability blocking'); // dominant category chip
  // Settle-cap 50% and disagreement 50% for test A appear.
  expect(html).toContain('50%');
  // The unsure bucket has its own panel and is not folded into a category count.
  expect(html).toContain('Unsure / untaxonomized');
  expect(html).toContain('By category');
});

test('should_html_escape_test_ids_so_a_malicious_test_name_cannot_inject_markup', () => {
  const evil = '<img src=x onerror=alert(1)> & "quoted" \'apos\'';
  const html = renderHtml(aggregate([rec({ testId: evil })]));

  // The raw payload must NOT appear verbatim — it must be entity-escaped.
  expect(html).not.toContain('<img src=x onerror=alert(1)>');
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(html).toContain('&amp;');
  expect(html).toContain('&quot;');
  expect(html).toContain('&#39;');
});

test('should_render_an_expandable_per_test_explanation_panel_with_detail_and_diagnoses', () => {
  const html = renderHtml(
    aggregate([
      rec({
        testId: 'suite > flaky A',
        runId: 'run-7',
        detail: 'the target <button> is disabled',
        diagnoses: [
          {
            code: 'disabled',
            confidence: 'confirmed',
            scope: 'node',
            detail: 'element is not enabled',
          },
        ],
      }),
    ]),
  );

  // The row carries an accessible toggle button wired to a hidden detail row (aria-controls target).
  expect(html).toMatch(
    /<button class="toggle"[^>]*aria-expanded="false"[^>]*aria-controls="dw-detail-1"/,
  );
  expect(html).toContain('id="dw-detail-1"');
  expect(html).toContain('hidden'); // the detail row is collapsed by default
  // The panel renders the retained explanation: the run, the cause, the detail text …
  expect(html).toContain('run-7');
  expect(html).toContain('the target &lt;button&gt; is disabled'); // detail (escaped, see below)
  // … and a per-diagnosis line `[scope] code (confidence) — detail`.
  expect(html).toContain('[node]');
  expect(html).toContain('element is not enabled');
  expect(html).toContain('(confirmed)');
  expect(html).toContain('source: error-text');
  // The toggle JS is present and self-contained (no external asset).
  expect(html).toContain("querySelectorAll('button.toggle')");
});

test('should_render_the_honest_detail_for_an_unsure_record', () => {
  const honest =
    'the failure was not a recognized Playwright actionability error — no cause inferred';
  const html = renderHtml(
    aggregate([
      rec({
        testId: 'suite > murky C',
        code: 'unsure',
        confidence: 'unknown',
        category: null,
        detail: honest,
        diagnoses: [],
      }),
    ]),
  );
  // The unsure cause is surfaced honestly in its OWN panel, with the honest detail text — not folded
  // into a taxonomy category and not fabricated.
  expect(html).toContain('>unsure<');
  expect(html).toContain(honest); // no HTML-special chars → appears verbatim
});

test('should_escape_a_malicious_detail_and_diagnosis_string_they_are_user_data', () => {
  const evil = '<script>alert(1)</script> & "x" \'y\'';
  const html = renderHtml(
    aggregate([
      rec({
        detail: evil,
        diagnoses: [{ code: 'disabled', confidence: 'confirmed', scope: 'node', detail: evil }],
      }),
    ]),
  );
  // The raw payload never appears verbatim in EITHER the detail paragraph or the diagnosis line.
  expect(html).not.toContain('<script>alert(1)</script>');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).toContain('&quot;');
  expect(html).toContain('&#39;');
});

test('should_render_an_empty_state_without_crashing_when_there_are_no_records', () => {
  const html = renderHtml(aggregate([]));
  expect(html.startsWith('<!doctype html>')).toBe(true);
  expect(html).toContain('No flake records');
  expect(html).toContain('0 failure records across 0 tests · 0 unsure');
  // No table body rows when empty.
  expect(html).not.toContain('<tbody>');
});

test('should_be_read_only_the_html_renderer_writes_nothing', () => {
  // Mirror the aggregator invariant: the dashboard module must not touch the filesystem.
  const src = readFileSync(resolve(process.cwd(), 'src/aggregate/html.ts'), 'utf8');
  expect(src).not.toMatch(
    /\b(write|writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|truncate|truncateSync|open|openSync|createWriteStream|cp|cpSync|copyFile|copyFileSync|chmod|chmodSync|symlink|symlinkSync|link|linkSync|utimes|utimesSync)\s*\(/,
  );
});
