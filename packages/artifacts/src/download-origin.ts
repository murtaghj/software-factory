// Isolated download origin (AC-49, chapter 09: "Serve uploaded HTML/SVG reports from an isolated
// download origin or force attachment with restrictive headers; never render arbitrary artifact
// scripts inside the authenticated dashboard origin"). Runs as its own server on its own origin,
// authenticates only the short-lived capability in the URL, never reads cookies or Authorization,
// and re-verifies the digest while streaming.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import type { ObjectStore } from './object-store.ts';
import type { DownloadCapability } from './capability.ts';

export const DOWNLOAD_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'private, no-store',
  'X-Frame-Options': 'DENY',
} as const;

export type DownloadOrigin = { url: string; close: () => Promise<void>; server: Server };

export async function startDownloadOrigin(store: ObjectStore, verify: (token: string) => DownloadCapability | undefined): Promise<DownloadOrigin> {
  const server = createServer((req, res) => {
    void (async () => {
      const m = /^\/d\/([A-Za-z0-9_.-]+)$/.exec(new URL(req.url ?? '/', 'http://origin').pathname);
      const cap = req.method === 'GET' && m?.[1] ? verify(m[1]) : undefined;
      if (!cap) {
        res.writeHead(403, { ...DOWNLOAD_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return;
      }
      const preview = cap.disposition === 'isolated_preview';
      res.writeHead(200, {
        ...DOWNLOAD_HEADERS,
        // Active content is never served with its own type; previews keep only allow-listed inert types.
        'Content-Type': preview ? (cap.mediaType.startsWith('text/') ? `${cap.mediaType}; charset=utf-8` : cap.mediaType) : 'application/octet-stream',
        'Content-Disposition': preview ? 'inline' : `attachment; filename="artifact-${cap.artifactId}.bin"`,
        'Content-Length': String(cap.sizeBytes),
        'Digest': `sha-256=${Buffer.from(cap.sha256, 'hex').toString('base64')}`,
      });
      const hash = createHash('sha256');
      let bytes = 0;
      try {
        for await (const chunk of store.read(cap.storageKey)) {
          hash.update(chunk);
          bytes += chunk.length;
          res.write(chunk);
        }
        if (bytes !== cap.sizeBytes || hash.digest('hex') !== cap.sha256) { res.destroy(new Error('integrity failure')); return; }
        res.end();
      } catch {
        res.destroy();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    // A distinct host from the dashboard origin (localhost vs 127.0.0.1 in local development).
    url: `http://127.0.0.1:${String(port)}`,
    server,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((e) => { if (e) reject(e); else resolve(); }); }),
  };
}
