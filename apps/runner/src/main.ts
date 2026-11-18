// The process entry that runs the reconcile loop. Not part of `pnpm dev` (D9). It needs a configured
// cluster client (17b wires the k3s tier); until then it refuses to start rather than run against nothing.
import { RunnerError } from './errors.ts';

export function main(): never {
  throw new RunnerError('not_supported', 'the runner process needs a cluster configuration; the k3s tier wires it in 17b');
}
if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  try { main(); } catch (e) { console.error((e as Error).message); process.exit(1); }
}
