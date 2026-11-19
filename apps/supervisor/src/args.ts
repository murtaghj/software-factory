// The supervisor's arguments (section 6, 19b). Every value is parsed here and nowhere else; anything the supervisor refuses is exit 64.
import { isIP } from 'node:net';
import { isLoopbackOrLinkLocalOrUnspecified } from '@factory/runner-protocol';

export class ArgsRefused extends Error {}
export type GateMode = 'required' | 'disabled';
export type ServeArgs = {
  org: string; allocation: string; epoch: number; generation: number; workspace: string | undefined;
  runnerUrl: URL; caSha256: string; listen: { host: string; port: number }; gate: GateMode; denyTargets: string[];
};
export type ParseOptions = {
  // The production entry refuses a runner URL that is not https, or whose host is loopback, link-local or unspecified: inside a pod loopback belongs to the
  // harness as much as to the supervisor, and a port there can be taken after start. Only a test entry (the fake tier's loopback listener) sets this.
  allowPlainLoopbackRunner?: boolean;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A deny target: a literal IPv4 or bracketed IPv6 address and a port. A name is refused (it would be resolved from inside the pod).
export function isLiteralTarget(t: string): boolean {
  const m = /^(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9a-fA-F:.]+)\]):(\d{1,5})$/.exec(t);
  if (!m) return false;
  const addr = m[1] ?? m[2] ?? '';
  if (isIP(addr) === 0) return false;
  const port = Number(m[3]);
  return port >= 1 && port <= 65535;
}

export function parseServeArgs(argv: readonly string[], o: ParseOptions = {}): ServeArgs {
  const fail = (m: string): never => { throw new ArgsRefused(m); };
  if (argv[0] !== 'serve') fail('the first argument is `serve`');
  const single = new Map<string, string>();
  const deny: string[] = [];
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) fail(`argument ${flag ?? ''} has no value`);
    if (flag === '--deny-target') { deny.push(value as string); continue; }
    if (single.has(flag as string)) fail(`${flag as string} given twice`);
    single.set(flag as string, value as string);
  }
  const allowed = ['--org', '--allocation', '--epoch', '--generation', '--workspace', '--runner', '--runner-ca-sha256', '--listen', '--network-gate'];
  for (const k of single.keys()) if (!allowed.includes(k)) fail(`unknown argument ${k}`);
  const need = (k: string): string => single.get(k) ?? fail(`${k} is required`);
  const org = need('--org'); const allocation = need('--allocation');
  if (!UUID.test(org) || !UUID.test(allocation)) fail('--org and --allocation are UUIDs');
  const int = (k: string): number => { const v = need(k); if (!/^[1-9][0-9]{0,15}$/.test(v)) fail(`${k} is a positive integer`); return Number(v); };
  const epoch = int('--epoch'); const generation = int('--generation');
  const workspace = single.get('--workspace');
  if (workspace !== undefined && !UUID.test(workspace)) fail('--workspace is a UUID');
  let runnerUrl: URL;
  try { runnerUrl = new URL(need('--runner')); } catch { return fail('--runner is not a URL'); }
  if (o.allowPlainLoopbackRunner !== true) {
    if (runnerUrl.protocol !== 'https:') fail('the runner URL must be https');
    if (isLoopbackOrLinkLocalOrUnspecified(runnerUrl.hostname)) fail('the runner URL must not name a loopback, link-local or unspecified address');
  } else if (runnerUrl.protocol !== 'https:' && runnerUrl.protocol !== 'http:') fail('the runner URL must be http or https');
  const caSha256 = need('--runner-ca-sha256');
  if (!/^[0-9a-f]{64}$/.test(caSha256)) fail('--runner-ca-sha256 is 64 hex characters');
  const listenText = need('--listen');
  const lm = /^127\.0\.0\.1:([0-9]{1,5})$/.exec(listenText);
  if (!lm || Number(lm[1]) < 1 || Number(lm[1]) > 65535) fail('--listen is 127.0.0.1:<port>');
  const gate = single.get('--network-gate');
  if (gate !== 'required' && gate !== 'disabled') fail('--network-gate is required or disabled');
  if (deny.length > 8) fail('at most eight deny targets');
  if (gate === 'required' && deny.length === 0) fail('a required gate has at least one deny target');
  for (const t of deny) if (!isLiteralTarget(t)) fail('a deny target is a literal address and a port, never a name');
  return { org, allocation, epoch, generation, workspace, runnerUrl, caSha256, listen: { host: '127.0.0.1', port: Number((lm as RegExpExecArray)[1]) }, gate: gate as GateMode, denyTargets: deny };
}
