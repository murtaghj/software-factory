// The launcher's TEST entry: the real launcher, with a log file for the assertions. The production entry is apps/supervisor/src/launcher.ts.
import { appendFileSync } from 'node:fs';
import { runLauncher } from '@factory/supervisor';

const logFile = process.env['FACTORY_TEST_LOG'];
const stop = new AbortController();
process.on('SIGTERM', () => { stop.abort(); });
const code = await runLauncher({ argv: process.argv.slice(2), term: stop.signal, ...(process.env['FACTORY_TEST_KILL_AFTER_MS'] === undefined ? {} : { killAfterMs: Number(process.env['FACTORY_TEST_KILL_AFTER_MS']) }), ...(logFile ? { log: (event: string, detail?: Record<string, unknown>) => { appendFileSync(logFile, `${JSON.stringify({ event, ...detail })}\n`); } } : {}) });
process.exit(code);
