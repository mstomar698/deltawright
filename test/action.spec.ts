import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// The composite GitHub Action (Wave-1 #4). Two things are testable without a runner: (1) the action
// CONTRACT — action.yml is a composite action with the documented inputs, degrades to nothing, and
// uses first-party actions + the built-in token (no third-party comment action, no hardcoded secret);
// (2) the two CLI COMMANDS the action shells out to actually work against reporter side-cars.

const root = resolve(process.cwd());
const actionYml = readFileSync(resolve(root, 'action.yml'), 'utf8');
const distCli = resolve(root, 'dist/cli.js');

test.beforeAll(() => {
  if (!existsSync(distCli)) execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
});

test('action_yml_is_a_composite_action_with_the_documented_inputs', () => {
  expect(actionYml).toMatch(/using:\s*'?composite'?/);
  for (const input of ['results-dir', 'version', 'comment', 'dashboard-artifact', 'github-token'])
    expect(actionYml).toContain(`${input}:`);
  // Defaults to the workflow token, not a hardcoded secret.
  expect(actionYml).toContain('${{ github.token }}');
  expect(actionYml).not.toMatch(/secrets\./); // no bespoke secret required
});

test('action_degrades_to_nothing_and_gates_the_comment_and_artifact_on_findings', () => {
  // The no-side-cars path sets found=false and the later steps are gated on found == 'true'.
  expect(actionYml).toContain('found=false');
  expect(actionYml).toContain("steps.agg.outputs.found == 'true'");
  // The comment only fires on a real PR event.
  expect(actionYml).toContain("github.event_name == 'pull_request'");
});

test('action_uses_first_party_actions_and_gh_not_a_third_party_comment_action', () => {
  expect(actionYml).toContain('actions/upload-artifact@v7'); // first-party, pinned major
  // House rule: gh + built-in token over a third-party comment action.
  expect(actionYml).toMatch(/gh api/);
  expect(actionYml).not.toMatch(/marocchino|peter-evans|thollander/i);
  // Sticky marker so re-runs update one comment instead of spamming.
  expect(actionYml).toContain('<!-- deltawright-triage -->');
});

test('comment_renders_untrusted_report_safely_html_escaped_pre_not_a_markdown_fence', () => {
  // The report (user-controlled test IDs) must NOT be embedded in a raw ``` fence — a title with a
  // newline + ``` would break out into live Markdown. It must be HTML-escaped into <pre>.
  expect(actionYml).toContain('<pre>');
  expect(actionYml).toMatch(/sed .*s\/&\/\\&amp;\/g/); // & first
  expect(actionYml).toMatch(/s\/<\/\\&lt;\/g/);
  expect(actionYml).toMatch(/s\/>\/\\&gt;\/g/);
  // Report text is not wrapped in a literal ``` fence anymore.
  expect(actionYml).not.toMatch(/echo '```'\n\s*cat deltawright-report/);
  // Marker match is startswith (first line), not a bare contains anywhere in a body.
  expect(actionYml).toMatch(/startswith\(/);
});

// The escaping the action applies (sed &/</>) must neutralize the reproduced fence-breakout +
// marker-forgery attack: a malicious test title cannot inject Markdown or forge the sticky marker.
function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

test('a_malicious_test_title_cannot_break_out_of_the_comment_or_forge_the_marker', () => {
  const runs = mkdtempSync(resolve(tmpdir(), 'dw-action-evil-'));
  const runDir = resolve(runs, 'run-1');
  mkdirSync(runDir, { recursive: true });
  // A title that closes a ``` fence, forges the marker, and injects Markdown.
  const evilTitle = 'pay\n```\n<!-- deltawright-triage -->\n## Injected: safe to merge\n```';
  writeFileSync(
    resolve(runDir, 'evil.deltawright-sidecar.json'),
    JSON.stringify({
      test: evilTitle,
      status: 'failed',
      source: 'error-text',
      cause: 'unknown',
      confidence: 'unknown',
      detail: '',
      detached: false,
      lateWave: false,
      staleRect: false,
      diagnoses: [],
    }) + '\n',
  );
  const report = execFileSync('node', [distCli, 'aggregate', '--report', runs], {
    encoding: 'utf8',
  });
  // The raw report DOES carry the attacker's payload (that's the vector) …
  expect(report).toContain('<!-- deltawright-triage -->');
  // … but after the action's HTML-escape it can neither inject markup nor forge the marker.
  const escaped = htmlEscape(report);
  expect(escaped).not.toContain('<!-- deltawright-triage -->'); // marker forgery neutralized
  expect(escaped).not.toContain('<'); // no raw markup survives
  expect(escaped).toContain('&lt;!-- deltawright-triage --&gt;'); // it's inert escaped text
});

test('the_report_and_html_commands_the_action_runs_produce_correct_output', () => {
  // Build a reporter-shaped side-car dir (one run) and run the exact two commands action.yml shells.
  const runs = mkdtempSync(resolve(tmpdir(), 'dw-action-'));
  const runDir = resolve(runs, 'run-1');
  mkdirSync(runDir, { recursive: true });
  const sidecar = {
    test: 'checkout > applies promo',
    status: 'failed',
    source: 'error-text',
    cause: 'covered-by-overlay',
    confidence: 'confirmed',
    detail: 'overlay intercepts',
    detached: false,
    lateWave: false,
    staleRect: false,
    diagnoses: [{ code: 'covered-by-overlay', confidence: 'confirmed', scope: 'node', detail: '' }],
  };
  writeFileSync(
    resolve(runDir, 'a.deltawright-sidecar.json'),
    JSON.stringify(sidecar, null, 2) + '\n',
  );

  const report = execFileSync('node', [distCli, 'aggregate', '--report', runs], {
    encoding: 'utf8',
  });
  expect(report).toContain('applies promo');
  expect(report).toContain('actionability-blocking'); // dominant category label

  const html = execFileSync('node', [distCli, 'aggregate', '--html', runs], { encoding: 'utf8' });
  expect(html.startsWith('<!doctype html>')).toBe(true);
  expect(html).toContain('Deltawright — Flake Triage');
  expect(html).toContain('applies promo');
});
