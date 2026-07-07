import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';

// Minimal static server. Needed because ES-module apps (Vue TodoMVC) can't load over
// file://, and because same-origin iframe tests need a real HTTP origin. Serves a
// directory read-only on a random port.

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export interface StaticServer {
  origin: string;
  close: () => Promise<void>;
}

export async function startStaticServer(rootDir: string): Promise<StaticServer> {
  const root = normalize(rootDir);
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        let pathname = decodeURIComponent(url.pathname);
        if (pathname.endsWith('/')) pathname += 'index.html';
        const filePath = normalize(join(root, pathname));
        if (!filePath.startsWith(root)) {
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

/** The benchmark corpus server (bench/corpus). */
export function startCorpusServer(): Promise<StaticServer> {
  return startStaticServer(fileURLToPath(new URL('./corpus', import.meta.url)));
}
