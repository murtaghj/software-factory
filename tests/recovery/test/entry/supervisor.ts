// The supervisor's TEST entry (fake tier only): it takes its paths, its port and its runner URL from the environment, which the production entry (apps/supervisor/src/main.ts)
// never does, and it lets the runner URL be a loopback address (the production argument parser refuses one). It is in no image.
import { appendFileSync } from 'node:fs';
import { runSupervisorWith } from '@factory/supervisor/testing';

const need = (n: string): string => { const v = process.env[n]; if (v === undefined) throw new Error(`${n} is required`); return v; };
const logFile = process.env['FACTORY_TEST_LOG'];
const stop = new AbortController();
process.on('SIGTERM', () => { stop.abort(); });
const code = await runSupervisorWith({
  argv: process.argv.slice(2), paths: { token: need('FACTORY_TEST_TOKEN'), ca: need('FACTORY_TEST_CA'), workspace: need('FACTORY_TEST_WORKSPACE') }, term: stop.signal,
  ...(logFile ? { log: (event, detail) => { appendFileSync(logFile, `${JSON.stringify({ event, ...detail })}\n`); } } : {}),
}, { allowPlainLoopbackRunner: true, ...(process.env['FACTORY_TEST_NO_COALESCE'] === '1' ? { coalesceHints: false } : {}) });
process.exit(code);
