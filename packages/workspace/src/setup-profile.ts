// Setup profile (SI-10): a local document, because the contract has none. It embeds the contract's
// own Recipe objects. Setup scripts are candidate code and run only in the sandbox
// (06-runner-workspaces.md:59, :108), so this module validates and drives an executor that the
// caller must supply; it exports no local executor.
import { posix } from 'node:path';
import type { Recipe } from '@factory/contracts';
import { WorkspaceError } from './errors.ts';

export type SetupProfile = {
  schema: 'factory-setup-profile/1';
  baseImageDigest: string;
  runtime: { name: string; version: string };
  packageManager: { name: string; version: string };
  architecture: string;
  lockfiles: string[];
  dependencySources: string[];
  recipes: Recipe[];
  // Declared only so they can be refused: W-018 supports neither.
  submodules?: boolean;
  lfs?: boolean;
};

export type SetupExecutionRequest = {
  recipeId: string; executable: string; args: readonly string[]; cwd: string;
  environment: Readonly<Record<string, string>>; timeoutMs: number; outputPaths: readonly string[];
};
export type SetupExecutionResult = { exitCode: number; timedOut?: boolean; writtenPaths: readonly string[] };
export interface SetupExecutor { run(request: SetupExecutionRequest): Promise<SetupExecutionResult> }

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'ash', 'busybox']);
// Programs that run another program (so the recipe's executable would not be what runs) ...
const WRAPPERS = new Set(['env', 'xargs', 'nice', 'nohup', 'timeout', 'command', 'exec', 'sudo', 'doas', 'stdbuf', 'setsid', 'time', 'unshare', 'chroot']);
// ... and interpreters, refused when an argument hands them inline code. This is ADVISORY: it is easy
// to get around (find -exec, awk system(), script -c, flock, unlisted shells and interpreters, ...).
// The executor's sandbox is the control (README, A-29).
const INTERPRETER = /^(node|nodejs|deno|bun|python|perl|ruby|php|lua|tclsh|osascript|pwsh)[0-9._-]*$/; // versioned names too: ruby3.3, python3.12, node22
const INLINE_CODE_FLAG = /^(--eval|--command|--print|--import|-[A-Za-z]*[ceEpr][A-Za-z]*|-command|-encodedcommand)(=.*)?$|^eval$/i; // --flag=value forms, deno eval, pwsh -Command
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;

const bad = (message: string): never => { throw new WorkspaceError('invalid_setup_profile', message); };
const str = (v: unknown, what: string): string => (typeof v === 'string' && v !== '' ? v : bad(`${what} must be a non-empty string`));
const strList = (v: unknown, what: string): string[] => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : bad(`${what} must be a list of strings`));
const versioned = (v: unknown, what: string): { name: string; version: string } => {
  const o = (typeof v === 'object' && v !== null ? v : bad(`${what} must be an object`)) as Record<string, unknown>;
  return { name: str(o['name'], `${what}.name`), version: str(o['version'], `${what}.version`) };
};
const relative = (p: string, what: string): string => {
  const n = posix.normalize(p);
  if (p.startsWith('/') || n === '..' || n.startsWith('../') || p.includes('\0')) bad(`${what} must be a relative path inside the workspace`);
  return n;
};

export function validateSetupProfile(value: unknown): SetupProfile {
  const o = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : bad('a setup profile must be an object')) as Record<string, unknown>;
  if (o['schema'] !== 'factory-setup-profile/1') bad('unknown setup profile schema');
  if (o['submodules'] === true) throw new WorkspaceError('unsupported_setup_feature', 'submodules are not supported in W-018');
  if (o['lfs'] === true) throw new WorkspaceError('unsupported_setup_feature', 'Git LFS is not supported in W-018');
  const baseImageDigest = str(o['baseImageDigest'], 'baseImageDigest');
  if (!IMAGE.test(baseImageDigest)) bad('baseImageDigest must be sha256:<64 hex>');
  const recipesRaw = Array.isArray(o['recipes']) ? (o['recipes'] as unknown[]) : bad('recipes must be a list');
  const recipes = recipesRaw.map((r, i): Recipe => {
    const x = (typeof r === 'object' && r !== null ? r : bad(`recipes[${String(i)}] must be an object`)) as Record<string, unknown>;
    const executable = str(x['executable'], 'executable');
    const program = posix.basename(executable);
    if (SHELLS.has(program)) throw new WorkspaceError('unsupported_setup_feature', `recipe ${String(x['id'])} runs a shell (${executable}); shell recipes need review and are not supported in W-018`);
    if (WRAPPERS.has(program)) throw new WorkspaceError('unsupported_setup_feature', `recipe ${String(x['id'])} runs ${program}, which runs another program; name that program as the executable`);
    const argList = strList(x['args'], 'args');
    if (INTERPRETER.test(program) && argList.some((a) => INLINE_CODE_FLAG.test(a))) {
      throw new WorkspaceError('unsupported_setup_feature', `recipe ${String(x['id'])} passes inline code to ${program}; run a script file instead`);
    }
    const secretRefs = strList(x['secretRefs'], 'secretRefs');
    if (secretRefs.length > 0) throw new WorkspaceError('unsupported_setup_feature', 'secret references are not supported in W-018');
    const env = (typeof x['environment'] === 'object' && x['environment'] !== null ? x['environment'] : bad('environment must be an object')) as Record<string, unknown>;
    const environment: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (!ENV_NAME.test(k) || k.startsWith('GIT_') || typeof v !== 'string') bad(`environment variable ${k} is not allowed`);
      environment[k] = v as string;
    }
    const timeoutSeconds = x['timeoutSeconds'];
    if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) bad('timeoutSeconds must be an integer from 1 to 3600');
    const image = str(x['imageDigest'], 'imageDigest');
    return {
      id: str(x['id'], 'id'), imageDigest: image, executable, args: strList(x['args'], 'args'), cwd: relative(str(x['cwd'], 'cwd'), 'cwd'), environment, secretRefs,
      timeoutSeconds: timeoutSeconds as number, outputPaths: strList(x['outputPaths'], 'outputPaths').map((p) => relative(p, 'outputPaths')), networkProfile: str(x['networkProfile'], 'networkProfile'),
    };
  });
  return {
    schema: 'factory-setup-profile/1', baseImageDigest, runtime: versioned(o['runtime'], 'runtime'), packageManager: versioned(o['packageManager'], 'packageManager'),
    architecture: str(o['architecture'], 'architecture'), lockfiles: strList(o['lockfiles'], 'lockfiles'), dependencySources: strList(o['dependencySources'], 'dependencySources'), recipes,
  };
}

const within = (path: string, allowed: readonly string[]): boolean => {
  const n = posix.normalize(path);
  if (n === '..' || n.startsWith('../') || n.startsWith('/')) return false;
  return allowed.some((a) => n === a || n.startsWith(`${a}/`));
};

// The executor is a required argument: there is no default, because the only safe place to run a
// recipe is the sandbox, and W-018 does not build one.
export async function runSetup(profile: SetupProfile, executor: SetupExecutor): Promise<Array<{ recipeId: string; exitCode: number; writtenPaths: readonly string[] }>> {
  if (typeof (executor as Partial<SetupExecutor> | undefined)?.run !== 'function') throw new WorkspaceError('executor_required', 'runSetup needs an executor');
  const valid = validateSetupProfile(profile);
  const out: Array<{ recipeId: string; exitCode: number; writtenPaths: readonly string[] }> = [];
  for (const r of valid.recipes) {
    const result = await executor.run({ recipeId: r.id, executable: r.executable, args: r.args, cwd: r.cwd, environment: { ...r.environment }, timeoutMs: r.timeoutSeconds * 1000, outputPaths: r.outputPaths });
    if (result.timedOut === true) throw new WorkspaceError('setup_timeout', `recipe ${r.id} exceeded ${String(r.timeoutSeconds)}s`);
    if (result.exitCode !== 0) throw new WorkspaceError('setup_failed', `recipe ${r.id} exited ${String(result.exitCode)}`);
    const stray = result.writtenPaths.filter((p) => !within(p, r.outputPaths));
    if (stray.length > 0) throw new WorkspaceError('output_outside_allowed_paths', `recipe ${r.id} wrote outside its allowed paths`, { stray });
    out.push({ recipeId: r.id, exitCode: result.exitCode, writtenPaths: result.writtenPaths });
  }
  return out;
}
