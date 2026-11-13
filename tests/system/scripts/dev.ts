// Local single-pane demo: `pnpm dev` (after `pnpm services:up`).
// Starts the real stack on this machine — API, workflow worker, dispatcher, artifact store, a
// throwaway database and the local test issuer — builds the dashboard and serves it on
// http://localhost:4173 with three sample people and a few sample tasks. The runner is the M1 fake:
// stage output is canned. Everything is discarded when the process stops.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { DASHBOARD_CLIENT_ID, createSystemHarness } from '../src/index.ts';

const PORT = Number(process.env.FACTORY_DASHBOARD_PORT ?? 4173);
const origin = `http://localhost:${String(PORT)}`;
const log = (line: string): void => { process.stdout.write(`${line}\n`); };

log('Starting the factory (database, API, Temporal test server, worker)…');
const h = await createSystemHarness('dev', { dashboardOrigin: origin, temporal: { fakeStage: { delayMs: (n) => (n === 'investigate' ? 20_000 : 1500) } } });
const billing = randomUUID();
await h.tx(async (t) => {
  await t.query("UPDATE factory.application SET name = 'Orders API' WHERE id = $1", [h.applicationId]);
  await t.query("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle) VALUES ($1,$2,'billing','Billing API','[]','production')", [h.orgId, billing]);
});
const both = [h.applicationId, billing];
const dana = await h.user([{ role: 'contributor', scope: both }], 'Dana (developer)');
const riley = await h.user([{ role: 'reviewer', scope: both }, { role: 'contributor', scope: [billing] }], 'Riley (reviewer)');
const sam = await h.user([{ role: 'operator', scope: both }, { role: 'organization_admin', scope: ['*'] }, { role: 'reviewer', scope: [billing] }], 'Sam (operator and admin)');

// The dispatcher normally runs as its own process; here it is a loop.
const run = { stopping: false };
const dispatching = (async () => { while (!run.stopping) { try { await h.temporal?.dispatch(); } catch { /* next tick retries */ } await new Promise((r) => setTimeout(r, 300)); } })();

const task = (applicationId: string, title: string, budgetUsd = 25) => ({
  schemaVersion: '2.0', title, intent: 'Explain the behaviour with evidence and limitations.', applicationIds: [applicationId], workType: 'investigation',
  acceptanceCriteria: ['The report distinguishes observations, inference and open questions.', 'Competing explanations are compared with evidence.'], assurance: 'standard', deliveryScope: 'report',
  budget: { maxMicroUsd: budgetUsd * 1_000_000, maxActiveSeconds: 3600, maxCalendarSeconds: 86_400, maxAuthoringInvocations: 4, maxSemanticAttemptsPerNode: 3, maxDesignReturns: 2, invocationMode: 'bounded' },
  targetContext: { kind: 'existing_application', applicationId },
});
const submit = async (user: typeof dana, body: unknown): Promise<void> => {
  const r = await h.call(user, 'POST', '/v2/tasks', body, { 'idempotency-key': randomUUID() });
  if (r.status !== 202) log(`  (sample task not accepted: ${JSON.stringify(r.body)})`);
};
await h.call(sam, 'POST', `/v2/principals/${dana.principalId}/allowance`, { monthlyLimitMicroUsd: 60_000_000 });
await submit(dana, task(h.applicationId, 'Why do some orders fail after a retry?'));
await submit(dana, task(billing, 'Are duplicate invoices caused by the webhook retry?'));
await submit(dana, task(billing, 'Trace the slow month-end report', 1.5)); // stops: its own budget runs out
await submit(riley, task(billing, 'Why does proration round differently in March?'));

log('Building the dashboard…');
const dist = mkdtempSync(join(tmpdir(), 'factory-dashboard-'));
execFileSync(process.execPath, [resolve(import.meta.dirname, '..', '..', '..', 'apps', 'dashboard', 'scripts', 'build.ts'), dist], { stdio: 'inherit' });

const config = JSON.stringify({ apiUrl: h.apiUrl, auth: { issuer: h.issuer.issuer, clientId: DASHBOARD_CLIENT_ID, redirectUri: `${origin}/` } });
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', origin).pathname;
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
  if (path === '/config.json') { res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end(config); return; }
  const file = normalize(join(dist, path === '/' ? 'index.html' : path));
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, headers); res.end('not found'); return; }
  res.writeHead(200, { ...headers, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));

log('');
log(`  Dashboard   ${origin}`);
log(`  API         ${h.apiUrl}`);
log('  Sign in as  Dana (developer) · Riley (reviewer) · Sam (operator and admin)');
log('');
log('  Try: sign in as Riley and answer the inbox; sign in as Dana and watch "My work".');
log('  Stage output is the fake runner\'s; nothing here calls a model. Ctrl+C stops and discards it.');

const stop = async (): Promise<void> => {
  if (run.stopping) return;
  run.stopping = true;
  log('\nStopping…');
  server.closeAllConnections();
  server.close();
  await dispatching;
  await h.close();
  rmSync(dist, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
