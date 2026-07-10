// The `deltawright` CLI. Intentionally small in v0.6: it exposes the MCP server as a
// subcommand and reports version/help. Capability-specific commands (reporter,
// aggregate, …) are added by the tickets that ship those capabilities.
import { readFile } from 'node:fs/promises';

const USAGE = `deltawright — a delta-and-actionability layer for Playwright agents

Usage:
  deltawright mcp                        Start the MCP server on stdio (same as deltawright-mcp)
  deltawright checksum --update -- <cmd> Run <cmd> with delta-checksum baselines set to UPDATE
                                         (e.g. deltawright checksum --update -- npx playwright test)
  deltawright aggregate [--report] <dir> Read-only: rank flaky tests from triage side-cars (#55) —
                                         JSONL by default, --report for a ranked summary
  deltawright --version, -v              Print the installed version
  deltawright --help, -h                 Show this help

Docs: https://github.com/mstomar698/deltawright`;

async function version(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  switch (cmd) {
    case 'mcp': {
      // Delegate to the same stdio server as the `deltawright-mcp` bin. The module only
      // self-runs when it IS the entry point, so start it explicitly here.
      const { startServer } = await import(new URL('./mcp/server.js', import.meta.url).href);
      await startServer();
      return 0;
    }
    case 'checksum': {
      // `checksum --update -- <cmd...>` runs <cmd> with DW_UPDATE_CHECKSUMS=1 so the delta-checksum
      // matchers (#54) rewrite their baselines instead of asserting. A thin, explicit convenience
      // over exporting the env yourself; the matchers also honor Playwright's `--update-snapshots`.
      const rest = argv.slice(1);
      if (rest[0] !== '--update') {
        console.error('deltawright checksum: expected --update\n\n' + USAGE);
        return 1;
      }
      const sep = rest.indexOf('--');
      const cmd = sep >= 0 ? rest.slice(sep + 1) : rest.slice(1);
      if (cmd.length === 0) {
        console.error('usage: deltawright checksum --update -- <test command>\n');
        console.error('e.g.   deltawright checksum --update -- npx playwright test');
        return 1;
      }
      const { spawnSync } = await import('node:child_process');
      const res = spawnSync(cmd[0]!, cmd.slice(1), {
        stdio: 'inherit',
        env: { ...process.env, DW_UPDATE_CHECKSUMS: '1' },
        // Windows launches npm/npx via .cmd shims, which need a shell to resolve.
        shell: process.platform === 'win32',
      });
      if (res.error) {
        console.error(
          `deltawright checksum: failed to run "${cmd.join(' ')}": ${res.error.message}`,
        );
        return 1;
      }
      return res.status ?? 1;
    }
    case 'aggregate': {
      // Read-only flake aggregation (#59) over the reporter's triage side-cars. JSONL by default; a
      // ranked human summary with --report. Writes nothing.
      const rest = argv.slice(1);
      const report = rest.includes('--report');
      const dirs = rest.filter((a) => !a.startsWith('--'));
      if (dirs.length === 0) {
        console.error('usage: deltawright aggregate [--report] <dir> [<dir> ...]\n');
        console.error(
          '  (each <dir> is scanned for *.deltawright-sidecar.json; one run = one dir)',
        );
        return 1;
      }
      const { readSidecars, aggregate, toJSONL, renderReport } = await import(
        new URL('./aggregate/index.js', import.meta.url).href
      );
      const records = readSidecars(dirs);
      console.log(report ? renderReport(aggregate(records)) : toJSONL(records));
      return 0;
    }
    case '-v':
    case '--version':
      console.log(await version());
      return 0;
    case undefined:
    case '-h':
    case '--help':
      console.log(USAGE);
      return 0;
    default:
      console.error(`deltawright: unknown command "${cmd}"\n`);
      console.error(USAGE);
      return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
