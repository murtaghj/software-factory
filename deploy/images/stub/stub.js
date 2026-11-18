// Stub for the supervisor and harness containers (A-27, until W-019 and W-077). Behaviour comes from /stub-mode, written at build time.
import { readFileSync, writeFileSync } from 'node:fs';

const mode = readFileSync('/stub-mode', 'utf8');
const arg = process.argv[2] ?? '';
switch (mode) {
  case 'run': process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000); break;
  case 'ignore-term': process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); break;
  case 'exit0': process.exit(0); break;
  case 'exit1': process.exit(1); break;
  case 'message': writeFileSync('/dev/termination-log', arg); break;
  case 'stderr-fail': process.stderr.write(arg); process.exit(1); break;
  default: process.stderr.write(`unknown stub mode ${mode}`); process.exit(2);
}
