// A throwaway CA, an ECDSA P-256 listener certificate, and a raw HTTP/1.1 client over one socket, for the listener tests. Sources are named by
// the client's local port (one block of 1,000 ports per source), because on this host every client is 127.0.0.1.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

export type Pki = { dir: string; ca: Buffer; cert: string; key: string; cleanup: () => void };
export function makePki(): Pki {
  const dir = mkdtempSync(join(tmpdir(), 'w019-pki-'));
  const run = (...a: string[]): void => { execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' }); };
  writeFileSync(join(dir, 'ca.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ca\n[dn]\nCN=w019-test-ca\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  writeFileSync(join(dir, 'leaf.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=w019-test-listener\n[san]\nsubjectAltName=IP:127.0.0.1\n');
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key');
  run('req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', '2', '-config', 'ca.cnf', '-out', 'ca.crt');
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key');
  run('req', '-new', '-key', 'leaf.key', '-config', 'leaf.cnf', '-out', 'leaf.csr');
  run('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-sha256', '-days', '2', '-extfile', 'leaf.cnf', '-extensions', 'san', '-out', 'leaf.crt');
  const ca = readFileSync(join(dir, 'ca.crt'));
  const cert = readFileSync(join(dir, 'leaf.crt'), 'utf8');
  const key = readFileSync(join(dir, 'leaf.key'), 'utf8');
  rmSync(join(dir, 'ca.key')); // the CA's key goes as soon as the certificate is signed
  return { dir, ca, cert, key, cleanup: () => { rmSync(dir, { recursive: true, force: true }); } };
}

export const sourceByPortBlock = ({ remotePort }: { remoteAddress: string | undefined; remotePort: number | undefined }): string => `src${String(Math.floor((remotePort ?? 0) / 1000))}`;

export async function connectAs(l: { port: number; host: string }, block: number, o: { tls: boolean; ca?: Buffer } = { tls: true }): Promise<net.Socket> {
  for (let i = 0; i < 50; i += 1) {
    const localPort = (20 + block) * 1000 + Math.floor(Math.random() * 1000);
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const raw = net.connect({ host: l.host, port: l.port, localPort });
        raw.once('error', reject);
        raw.once('connect', () => {
          if (!o.tls) { raw.off('error', reject); resolve(raw); return; }
          const t = tls.connect({ socket: raw, host: l.host, ca: o.ca });
          t.once('secureConnect', () => { raw.off('error', reject); t.off('error', reject); resolve(t); });
          t.once('error', reject);
        });
      });
    } catch (e) { if ((e as { code?: string }).code !== 'EADDRINUSE') throw e; }
  }
  throw new Error('no free local port in the block');
}
// A connection that the server may refuse before a handshake: resolves with how it ended instead of throwing.
export function tryConnectAs(l: { port: number; host: string }, block: number, o: { tls: boolean; ca?: Buffer }): Promise<{ socket?: net.Socket; refused: boolean }> {
  return connectAs(l, block, o).then((socket) => ({ socket, refused: false }), () => ({ refused: true }));
}

export type Reply = { status: number; body: string; closed: boolean };
export function request(s: net.Socket, r: { path: string; method?: string; headers?: Record<string, string>; body?: string; contentType?: string | null }): Promise<Reply> {
  return new Promise((resolve) => {
    const body = r.body ?? '';
    const headers: Record<string, string> = { Host: 'listener', 'Content-Length': String(Buffer.byteLength(body)), ...(r.contentType === null ? {} : { 'Content-Type': r.contentType ?? 'application/json' }), ...r.headers };
    s.write(`${r.method ?? 'POST'} ${r.path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`);
    let buf = Buffer.alloc(0);
    const done = (closed: boolean): void => {
      s.off('data', onData); s.off('close', onClose);
      const text = buf.toString('utf8');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(text);
      resolve({ status: m ? Number(m[1]) : 0, body: text.slice(text.indexOf('\r\n\r\n') + 4), closed });
    };
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const len = Number(/content-length: (\d+)/i.exec(buf.subarray(0, end).toString())?.[1] ?? '0');
      if (buf.length >= end + 4 + len) done(/connection: close/i.test(buf.subarray(0, end).toString()));
    };
    const onClose = (): void => { done(true); };
    s.on('data', onData); s.on('close', onClose);
  });
}
export const json = (r: Reply): Record<string, unknown> => { try { return JSON.parse(r.body) as Record<string, unknown>; } catch { return {}; } };
export const closedWithin = (s: net.Socket, ms: number): Promise<boolean> => new Promise((resolve) => {
  if (s.destroyed) { resolve(true); return; }
  const t = setTimeout(() => { resolve(false); }, ms);
  s.once('close', () => { clearTimeout(t); resolve(true); });
});
