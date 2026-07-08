// The `deltawright` CLI. Intentionally small in v0.6: it exposes the MCP server as a
// subcommand and reports version/help. Capability-specific commands (reporter,
// aggregate, …) are added by the tickets that ship those capabilities.
import { readFile } from 'node:fs/promises';

const USAGE = `deltawright — a delta-and-actionability layer for Playwright agents

Usage:
  deltawright mcp             Start the MCP server on stdio (same as the deltawright-mcp bin)
  deltawright --version, -v   Print the installed version
  deltawright --help, -h      Show this help

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
    case 'mcp':
      // Delegate to the same stdio server as the `deltawright-mcp` bin. Importing it
      // starts the server (top-level connect) and runs until the transport closes.
      await import(new URL('./mcp/server.js', import.meta.url).href);
      return 0;
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
