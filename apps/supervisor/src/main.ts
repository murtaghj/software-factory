// The production entry (the supervisor container's entrypoint, behind tini). Paths are fixed here and read from nothing: the projected token and, beside it, the
// runner's CA, and the workspace mount. No environment variable changes any of them (the test entry in tests/recovery passes its own).
import { runSupervisor } from './supervisor.ts';

const IDENTITY = '/var/run/factory-identity';
const stop = new AbortController();
process.on('SIGTERM', () => { stop.abort(); });
process.on('SIGINT', () => { stop.abort(); });
const code = await runSupervisor({
  argv: process.argv.slice(2), paths: { token: `${IDENTITY}/token`, ca: `${IDENTITY}/runner-ca.crt`, workspace: '/workspace' }, term: stop.signal,
  log: (event, detail) => { process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`); },
});
process.exit(code);
