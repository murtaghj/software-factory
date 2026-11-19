// The local endpoint: loopback only, eight connections, three routes. None of the three grants anything.
import http from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { startLocalEndpoint, type LocalEndpoint } from '../src/local-endpoint.ts';
import { State } from '../src/state.ts';

const open: LocalEndpoint[] = [];
afterEach(async () => { for (const e of open.splice(0)) await e.close(); });
async function up(state = new State(), hints: { n: number } = { n: 0 }) {
  const e = await startLocalEndpoint({ state, port: 0, pollMs: 5000, onHint: () => { hints.n += 1; } });
  open.push(e);
  return { e, state, hints };
}
const call = (port: number, method: string, path: string, body?: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, method, path, agent: false }, (res) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: Buffer.concat(c).toString('utf8') }); }); });
  req.on('error', reject);
  req.end(body);
});

describe('W-019 the local endpoint', () => {
  it('/v1/start holds until the state is running, then answers; after a fence it answers start false; control: the held poll is not answered early', async () => {
    const { e, state } = await up();
    state.set('preparing');
    let answered = false;
    const held = call(e.port, 'GET', '/v1/start').then((r) => { answered = true; return r; });
    await new Promise((r) => setTimeout(r, 150));
    expect(answered).toBe(false);
    state.set('running');
    expect(JSON.parse((await held).body)).toEqual({ start: true });
    const f = new State();
    const second = await up(f);
    f.fence('workspace');
    expect(JSON.parse((await call(second.e.port, 'GET', '/v1/start')).body)).toEqual({ start: false, reason: 'workspace' });
  });

  it('/v1/stop answers when the stop flag is set, and not before', async () => {
    const { e, state } = await up();
    state.set('running');
    let answered = false;
    const held = call(e.port, 'GET', '/v1/stop').then((r) => { answered = true; return r; });
    await new Promise((r) => setTimeout(r, 150));
    expect(answered).toBe(false);
    state.setStop();
    expect(JSON.parse((await held).body)).toEqual({ stop: true });
  });

  it('a ninth connection, an unknown route and a 1 KiB exit hint are refused; a small hint is accepted and changes no state', async () => {
    const { e, state, hints } = await up();
    state.set('running');
    expect((await call(e.port, 'GET', '/v1/other')).status).toBe(404);
    expect((await call(e.port, 'POST', '/v1/start', '{}')).status).toBe(404);
    expect((await call(e.port, 'POST', '/v1/exit', 'x'.repeat(1024))).status).toBe(413);
    expect(hints.n).toBe(0);
    expect((await call(e.port, 'POST', '/v1/exit', '{}')).status).toBe(204); // control
    expect(hints.n).toBe(1);
    expect(state.state).toBe('running'); // a hint changes no state
    expect(state.stopFlag).toBe(false);
    const held: net.Socket[] = [];
    for (let i = 0; i < 8; i += 1) held.push(await new Promise<net.Socket>((resolve, reject) => { const s = net.connect({ host: '127.0.0.1', port: e.port }, () => { resolve(s); }); s.on('error', reject); }));
    const ninth = await new Promise<string>((resolve) => { const s = net.connect({ host: '127.0.0.1', port: e.port }); s.once('close', () => { resolve('closed'); }); s.once('error', () => { resolve('closed'); }); setTimeout(() => { resolve('open'); s.destroy(); }, 800); });
    expect(ninth).toBe('closed');
    for (const s of held) s.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect((await call(e.port, 'POST', '/v1/exit', '{}')).status).toBe(204); // control: with the eight gone a new one is served
  });

  it('a non-loopback peer is refused; control: a loopback peer is served', async () => {
    const lan = Object.values(networkInterfaces()).flat().find((i) => i?.family === 'IPv4' && !i.internal)?.address;
    const { e } = await up();
    expect((await call(e.port, 'POST', '/v1/exit', '{}')).status).toBe(204);
    if (lan === undefined) return; // no second interface on this host: the control above is all there is
    const viaLan = await new Promise<string>((resolve) => {
      const req = http.request({ hostname: '127.0.0.1', port: e.port, method: 'POST', path: '/v1/exit', localAddress: lan, agent: false }, (res) => { res.resume(); resolve(String(res.statusCode)); });
      req.on('error', () => { resolve('refused'); });
      req.end('{}');
    });
    expect(viaLan).toBe('refused');
  });
});
