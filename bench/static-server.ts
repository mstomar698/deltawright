import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';

// Minimal static server for the vendored corpus. Needed because ES-module apps (Vue
// TodoMVC) can't load over file://. Serves bench/corpus/ read-only on a random port.

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const corpusDir = fileURLToPath(new URL('./corpus', import.meta.url));

export interface CorpusServer {
  origin: string;
  close: () => Promise<void>;
}

export async function startCorpusServer(): Promise<CorpusServer> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        let pathname = decodeURIComponent(url.pathname);
        if (pathname.endsWith('/')) pathname += 'index.html';
        const filePath = normalize(join(corpusDir, pathname));
        if (!filePath.startsWith(corpusDir)) {
          res.writeHead(403).end('forbidden');
          return;
        }
        const data = await readFile(filePath);
        res.writeHead(200, {
          'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
        });
        res.end(data);
      } catch {
        res.writeHead(404).end('not found');
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
