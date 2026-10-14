/**
 * [PLT-04] Tiny static file server for e2e specs that need control over what is served (not a spec):
 * - `only`: serve just these files (e.g. ['index.html'] = "dist/index.html with nothing beside it"); everything else
 *   is a plain 404 (no SPA fallback, unlike vite preview).
 * - stop(): closes the server and every open connection, so the page sees the network as unreachable (offline).
 * - throttle: optional bytes per second for responses (startup timing).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.css': 'text/css',
};

export interface StaticServer {
  readonly url: string;
  readonly port: number;
  /** Paths requested so far (decoded, without query). */
  readonly requests: string[];
  stop(): Promise<void>;
}

export async function startStaticServer(dir: string, opts: { only?: string[]; port?: number } = {}): Promise<StaticServer> {
  const root = resolve(dir);
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    requests.push(path);
    let rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    rel = normalize(rel);
    const file = join(root, rel);
    const allowed = !opts.only || opts.only.includes(rel.split('\\').join('/'));
    if (!allowed || !file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': String(statSync(file).size),
      'cache-control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  });
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((ok) => server.listen(opts.port ?? 0, '127.0.0.1', () => ok()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    requests,
    stop: () => new Promise<void>((ok) => {
      for (const s of sockets) s.destroy();
      server.close(() => ok());
    }),
  };
}
