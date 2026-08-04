// Fixture app + mock backend for the DW-usefulness experiment. Zero deps (node:http). Faults are
// driven per-navigation by `?fault=<id>&seed=<n>` on the page URL (client-side faults) and by the same
// `fault` echoed to the API (server-side faults) — so every run is reproducible and each test can pick
// exactly one injected fault. `flaky-appear` is the ONLY randomized fault (that is the point).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5300);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function faultOf(url) {
  return new URL(url, 'http://x').searchParams.get('fault') ?? 'clean';
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const path = u.pathname;

  // --- Mock API ---
  if (path.startsWith('/api/')) {
    const fault = faultOf(req.url);
    res.setHeader('content-type', 'application/json');

    if (path === '/api/poll') {
      // The background poller — always fast, but keeps the network non-idle for `rpc-settle`.
      res.end(JSON.stringify({ ts: Date.now() }));
      return;
    }
    if (path === '/api/list') {
      const rows = Array.from({ length: 40 }, (_, i) => ({
        id: i + 1,
        name: `Item ${String(i + 1).padStart(3, '0')}`,
        status: ['active', 'pending', 'closed'][i % 3],
        amount: 100 + i * 7,
      }));
      res.end(JSON.stringify({ rows }));
      return;
    }
    if (path === '/api/validate') {
      if (fault === 'rpc-settle') await sleep(500);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === '/api/save') {
      if (fault === 'backend-500') {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'internal error' }));
        return;
      }
      if (fault === 'rpc-settle') await sleep(600);
      res.end(JSON.stringify({ ok: true, saved: true }));
      return;
    }
    if (path === '/api/detail') {
      // `backend-slow-500`: the 5xx arrives ~500ms AFTER the click returns — i.e. INSIDE the failing
      // assertion's window — so diagnose-trace's network channel can window-correlate it (fair test).
      if (fault === 'backend-slow-500') {
        await sleep(500);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'internal error' }));
        return;
      }
      res.end(JSON.stringify({ ok: true, detail: 'record #42 — active' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'no such endpoint' }));
    return;
  }

  // --- Static app ---
  let file = path === '/' ? '/index.html' : path;
  try {
    const buf = await readFile(join(HERE, 'app', file));
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fixture app on http://127.0.0.1:${PORT}`);
});
