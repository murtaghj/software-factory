// Shared harness (not exported from the package): a migrated database with two tenants, an artifact
// service on a temporary object store, a workspace manager, and a real-Git fixture builder that
// runs Git with its own clean environment.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ArtifactService, FileObjectStore, type AuthContext } from '@factory/artifacts';
import type { ArtifactRef } from '@factory/contracts';
import { Database, createMigratedDatabase, provisionOrganization, transitionWorkspace, type MigratedDatabase } from '@factory/database';
import { GitRunner, LocalMaterializer, LocalWorkspaceHost, computeTreeDigest, createWorkspaceManager, type GitRunnerOptions, type TreeBlob, type WorkspaceManagerService, type MaterializeLimits } from '../src/index.ts';

// A GitRunner that may use the file transport: the tests' remotes are local bare repositories.
export const fileGit = (extra: GitRunnerOptions = {}): GitRunner => new GitRunner({ allowFileTransport: true, ...extra });
// A GitRunner whose `git push` is slow: the push runs as a child of a wrapper script, after `delaySeconds`, in
// the wrapper's process group. If only the direct child were killed on a deadline, the sleeping child would
// survive and apply the push afterwards. `pidFile` receives that child's pid once the push has started.
export function slowPushGit(dir: string, delaySeconds: number, extra: GitRunnerOptions = {}): { git: GitRunner; pidFile: string } {
  const pidFile = join(dir, 'push.pid');
  const script = join(dir, 'slow-git.sh');
  writeFileSync(script, `#!/bin/sh\ncase " $* " in\n *" push "*) ( sleep ${String(delaySeconds)}; exec /usr/bin/git "$@" ) & echo $! > "${pidFile}"; wait ;;\n *) exec /usr/bin/git "$@" ;;\nesac\n`);
  chmodSync(script, 0o755);
  return { git: fileGit({ binary: script, ...extra }), pidFile };
}
export const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const RUNNER = 'runner:factory';
export const PUBLISHER = 'service:git-publisher';
const hex = (c: string): string => c.repeat(64);
export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

export type Tenant = {
  orgId: string; principalId: string; applicationId: string; repositoryId: string; taskId: string;
  stages: Record<'implementer' | 'verifier' | 'reviewer', string>;
};

export type Fixtures = ReturnType<typeof makeFixtures>;
export type Repo = ReturnType<Fixtures['makeRepo']>;
export type FileSpec = string | { content?: string; mode?: number; symlink?: string };
export const DEFAULT_FILES: Record<string, FileSpec> = { 'README.md': 'hello\n', 'src/app.txt': 'app\n', 'bin/run.sh': { content: '#!/bin/sh\n', mode: 0o755 }, 'link': { symlink: 'README.md' } };

// ---------------------------------------------------------------- Git fixtures (test side)
export function makeFixtures() {
  const base = mkdtempSync(join(tmpdir(), 'w018-'));
  const home = join(base, 'home');
  mkdirSync(home);
  const env = {
    PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', LC_ALL: 'C',
  };
  let n = 0;
  const dir = (name: string): string => { const d = join(base, `${name}-${String(++n)}`); mkdirSync(d, { recursive: true }); return d; };
  const git = (cwd: string, args: string[], input?: Buffer | string): string =>
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8', ...(input === undefined ? {} : { input }), stdio: ['pipe', 'pipe', 'pipe'] });
  // Plain Git with the fixture environment and nothing else: no hardening flags, so repository hooks run.
  const gitPlain = (cwd: string, args: string[]): string => execFileSync('/usr/bin/git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const gitRaw = (cwd: string, args: string[]): Buffer => execFileSync('/usr/bin/git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

  function writeFiles(work: string, files: Record<string, FileSpec>): void {
    for (const [path, spec] of Object.entries(files)) {
      const full = join(work, path);
      mkdirSync(dirname(full), { recursive: true });
      rmSync(full, { force: true });
      if (typeof spec === 'object' && spec.symlink !== undefined) { symlinkSync(spec.symlink, full); continue; }
      writeFileSync(full, typeof spec === 'string' ? spec : (spec.content ?? ''));
      if (typeof spec === 'object' && spec.mode !== undefined) chmodSync(full, spec.mode);
    }
  }

  // A working repository plus a bare remote it has been pushed to.
  function makeRepo(files: Record<string, FileSpec>) {
    const work = dir('work');
    const bare = join(dir('remote'), 'origin.git');
    git(work, ['init', '--quiet', '--initial-branch=main']);
    writeFiles(work, files);
    git(work, ['add', '-A']);
    git(work, ['commit', '--quiet', '-m', 'base']);
    git(dirname(bare), ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
    git(work, ['push', '--quiet', bare, 'main']);
    const head = (): string => git(work, ['rev-parse', 'HEAD']).trim();
    return {
      work, bare, base: head(), head,
      commit(more: Record<string, FileSpec>, message = 'change'): string {
        writeFiles(work, more); git(work, ['add', '-A']); git(work, ['commit', '--quiet', '-m', message]); return head();
      },
      remoteRef: (ref: string): string | null => { try { return git(bare, ['rev-parse', '--verify', '--quiet', ref]).trim(); } catch { return null; } },
      bundle(): Buffer { const f = join(dir('bundle'), 'full.bundle'); git(work, ['bundle', 'create', f, '--all']); return readFileSync(f); },
      thinBundle(): Buffer { const f = join(dir('bundle'), 'thin.bundle'); git(work, ['bundle', 'create', f, 'HEAD~1..HEAD']); return readFileSync(f); },
    };
  }

  // A one-off pack: a tree commit made with plumbing so a path or mode can be arbitrary bytes.
  function plumbingCommit(entries: Array<{ mode: string; path: Buffer; content: Buffer | 'commit'; oid?: string }>): { repo: string; commit: string } {
    const repo = dir('plumb');
    git(repo, ['init', '--quiet', '--initial-branch=main']);
    const chunks: Buffer[] = [];
    const written = new Map<string, string>(); // one hash-object per distinct content
    for (const e of entries) {
      const key = e.content === 'commit' ? '' : sha256(e.content);
      const oid = e.content === 'commit' ? (e.oid ?? 'a'.repeat(40))
        : (written.get(key) ?? execFileSync('/usr/bin/git', ['hash-object', '-w', '--stdin'], { cwd: repo, env, input: e.content, maxBuffer: 1 << 30 }).toString().trim());
      if (e.content !== 'commit') written.set(key, oid);
      chunks.push(Buffer.concat([Buffer.from(`${e.mode} ${oid}\t`), e.path, Buffer.from([0])]));
    }
    execFileSync('/usr/bin/git', ['update-index', '--add', '-z', '--index-info'], { cwd: repo, env, input: Buffer.concat(chunks) });
    const tree = git(repo, ['write-tree']).trim();
    const commit = git(repo, ['commit-tree', '-m', 'plumbing', tree]).trim();
    git(repo, ['update-ref', 'refs/heads/main', commit]);
    return { repo, commit };
  }

  return { base, dir, git, gitPlain, gitRaw, makeRepo, plumbingCommit, writeFiles, cleanup: (): void => { rmSync(base, { recursive: true, force: true }); } };
}

// ---------------------------------------------------------------- database and services
export type Env = {
  m: MigratedDatabase; db: Database; artifacts: ArtifactService; store: FileObjectStore; fx: Fixtures; repoA: Repo; repoB: Repo;
  root: string; scratch: string; manager: WorkspaceManagerService;
  materializer: LocalMaterializer; host: LocalWorkspaceHost; a: Tenant; b: Tenant;
  runner: (t: Tenant) => AuthContext; publisher: (t: Tenant) => AuthContext; ctxFor: (t: Tenant, actorId: string, kind?: 'service' | 'human') => AuthContext;
  seedTenant: (orgId: string, cloneUrl: string, subpath?: string) => Promise<Tenant>;
  newManager: (extra?: { git?: GitRunner; limits?: Partial<MaterializeLimits>; foldPaths?: boolean }) => { materializer: LocalMaterializer; manager: WorkspaceManagerService; host: LocalWorkspaceHost };
  putArtifact: (t: Tenant, body: Buffer, mediaType: string, purpose: string) => Promise<ArtifactRef>;
  setupRef: (t: Tenant) => Promise<ArtifactRef>;
  close: () => Promise<void>;
};

export async function createEnv(prefix: string, opts: { pool?: number; files?: Record<string, FileSpec>; subpath?: string } = {}): Promise<Env> {
  const m = await createMigratedDatabase(prefix);
  const orgA = randomUUID();
  const orgB = randomUUID();
  await provisionOrganization(m.migratorUrl, { id: orgA, name: 'A' });
  await provisionOrganization(m.migratorUrl, { id: orgB, name: 'B' });
  const db = Database.connect(m.runtimeUrl, opts.pool ?? 40);
  const fx = makeFixtures();
  const storeRoot = join(fx.base, 'store');
  const store = new FileObjectStore(storeRoot);
  const artifacts = new ArtifactService({ db, store, signingKey: Buffer.alloc(32, 7), downloadOrigin: 'http://127.0.0.1:1' });
  const root = join(fx.base, 'workspaces');
  const scratch = join(fx.base, 'publish-scratch');

  async function seedTenant(orgId: string, cloneUrl: string, subpath = ''): Promise<Tenant> {
    const t: Tenant = { orgId, principalId: randomUUID(), applicationId: randomUUID(), repositoryId: randomUUID(), taskId: randomUUID(), stages: { implementer: '', verifier: '', reviewer: '' } };
    await db.withTenant({ orgId }, async (tx) => {
      await tx.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,'https://issuer.test',$3,'User')", [orgId, t.principalId, `u-${t.principalId}`]);
      await tx.query("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle, data_classification) VALUES ($1,$2,$3,'Orders','[]','production','internal')", [orgId, t.applicationId, `orders-${t.applicationId.slice(0, 8)}`]);
      await tx.query("INSERT INTO factory.repository (org_id, id, provider, installation_ref, external_id, clone_url, default_branch, policy_ref) VALUES ($1,$2,'local','inst',$3,$4,'main','{}')", [orgId, t.repositoryId, `repo-${t.repositoryId}`, cloneUrl]);
      await tx.query("INSERT INTO factory.application_repository (org_id, id, application_id, repository_id, subpath, purpose) VALUES ($1,$2,$3,$4,$5,'primary')", [orgId, randomUUID(), t.applicationId, t.repositoryId, subpath]);
      await tx.query("INSERT INTO factory.task (org_id, id, creator_id, primary_application_id, target_kind, target_context, work_type, change_class, delivery_scope, status) VALUES ($1,$2,$3,$4,'existing_application',$5,'feature','feature','pr','running')",
        [orgId, t.taskId, t.principalId, t.applicationId, JSON.stringify({ kind: 'existing_application', applicationId: t.applicationId })]);
      await tx.query("INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1,$2,$3,1,'{}',$4,$5)", [orgId, randomUUID(), t.taskId, hex('a'), t.principalId]);
      await tx.query("INSERT INTO factory.execution_plan (org_id, id, task_id, version, spec_version, plan_ref, policy_ref, plan_hash, template_id, template_version, template_ref) VALUES ($1,$2,$3,1,1,'{}','{}',$4,'existing_feature','3.0.0','{}')", [orgId, randomUUID(), t.taskId, hex('b')]);
      for (const [role, node] of [['implementer', 'implement'], ['verifier', 'verify'], ['reviewer', 'review']] as const) {
        const logical = `task-${t.taskId}/plan-1/${node}/attempt-1`;
        t.stages[role] = logical;
        await tx.query("INSERT INTO factory.stage_run (org_id, id, task_id, plan_version, node_id, semantic_attempt, logical_id, input_hash, input_ref, role, status, limits) VALUES ($1,$2,$3,1,$4,1,$5,$6,'{}',$7,'running','{}')",
          [orgId, randomUUID(), t.taskId, node, logical, hex('c'), role]);
      }
    });
    return t;
  }

  const ctxFor = (t: Tenant, actorId: string, kind: 'service' | 'human' = 'service'): AuthContext => ({ orgId: t.orgId, actorId, actorKind: kind, taskId: t.taskId, grantIds: [], correlationId: randomUUID() });
  const newManager = (extra: { git?: GitRunner; limits?: Partial<MaterializeLimits>; foldPaths?: boolean } = {}) => {
    const materializer = new LocalMaterializer({ root, git: extra.git ?? fileGit(), ...(extra.limits ? { limits: extra.limits } : {}), ...(extra.foldPaths === undefined ? {} : { foldPaths: extra.foldPaths }) });
    const manager = createWorkspaceManager({ db, artifacts, runnerIdentity: RUNNER, materializer });
    return { materializer, manager, host: new LocalWorkspaceHost({ db, manager, materializer }) };
  };
  const { materializer, manager, host } = newManager();

  async function putArtifact(t: Tenant, body: Buffer, mediaType: string, purpose: string): Promise<ArtifactRef> {
    const object = await artifacts.putControllerObject(t.orgId, body);
    return db.withTenant({ orgId: t.orgId }, (tx) => artifacts.registerControllerArtifact(tx, { orgId: t.orgId, taskId: t.taskId, producerId: 'test', object, mediaType, schemaVersion: '1.0', classification: 'ordinary', purpose }));
  }
  const setupRef = (t: Tenant): Promise<ArtifactRef> => putArtifact(t, Buffer.from('{"schema":"factory-setup-profile/1","fixture":true}'), 'application/json', 'setup_profile');

  const repoA = fx.makeRepo(opts.files ?? DEFAULT_FILES);
  const repoB = fx.makeRepo(opts.files ?? DEFAULT_FILES);
  const a = await seedTenant(orgA, repoA.bare, opts.subpath ?? '');
  const b = await seedTenant(orgB, repoB.bare, opts.subpath ?? '');
  return {
    m, db, artifacts, store, fx, repoA, repoB, root, scratch, manager, materializer, host, a, b, seedTenant, newManager, putArtifact, setupRef, ctxFor,
    runner: (t) => ctxFor(t, RUNNER), publisher: (t) => ctxFor(t, PUBLISHER),
    close: async () => { await db.close(); await m.drop(); fx.cleanup(); },
  };
}

export const specFor = (t: Tenant, setupProfileRef: ArtifactRef, baseCommit: string, over: Record<string, unknown> = {}) => ({
  repositoryId: t.repositoryId, baseCommit, branch: `factory/${t.taskId}/main`, role: 'implementer' as const,
  stageRunId: t.stages.implementer, setupProfileRef, specHash: hex('e'), ...over,
});

export const generationDir = (e: Env, t: Tenant, workspaceId: string, generation: number): string => join(e.root, t.orgId, workspaceId, `g${String(generation)}`);
export const pathExists = (p: string): boolean => existsSync(p);

// Registers a candidate (manifest and its bundle as artifacts) for the task, as the freeze step would.
export async function registerCandidate(e: Env, t: Tenant, repo: { bundle: () => Buffer; base: string; head: () => string }, treeDigest: string, createdByStageRunId: string, bundle?: Buffer) {
  const sourceRef = await e.putArtifact(t, bundle ?? repo.bundle(), 'application/x-git-bundle', 'candidate_source');
  const candidateId = randomUUID();
  const manifest = { schemaVersion: '2.0', candidateId, taskId: t.taskId, repositories: [{ repositoryId: t.repositoryId, baseCommit: repo.base, candidateCommit: repo.head(), treeDigest, changedPaths: [], sourceRef }],
    artifactRefs: [], profileRefs: [], createdByStageRunId, createdAt: '2026-01-01T00:00:00.000Z' };
  const manifestRef = await e.putArtifact(t, Buffer.from(JSON.stringify(manifest)), 'application/json', 'candidate_manifest');
  const authorStage = await e.db.withTenant({ orgId: t.orgId }, (tx) => tx.query<{ id: string }>('SELECT id FROM factory.stage_run WHERE logical_id = $1', [createdByStageRunId]));
  await e.db.withTenant({ orgId: t.orgId }, (tx) => tx.query('INSERT INTO factory.candidate (org_id, id, task_id, manifest_ref, candidate_hash, created_by_stage_run_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [t.orgId, candidateId, t.taskId, JSON.stringify(manifestRef), sha256(candidateId), authorStage.rows[0]?.id]));
  return { candidateId, manifestRef, sourceRef, manifest };
}

export const readText = (p: string): string => readFileSync(p, 'utf8');

// The treeDigest of a commit, computed here with plain Git and the pure digest function, independent of the materializer.
export function treeDigestOf(fx: Fixtures, repoDir: string, commit: string): string {
  const listing = fx.gitRaw(repoDir, ['ls-tree', '-r', '-z', '--full-tree', commit]);
  const items: TreeBlob[] = [];
  for (const row of listing.toString('latin1').split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    const [mode = '', , oid = ''] = row.slice(0, tab).split(' ');
    items.push({ pathBytes: Buffer.from(row.slice(tab + 1), 'latin1'), mode, blob: fx.gitRaw(repoDir, ['cat-file', 'blob', oid]) });
  }
  return computeTreeDigest(items);
}

// An implementer workspace driven to `checkpointed` with a frozen candidate commit and its bundle,
// the way W-019/W-020 will leave it (here through the guarded transition).
export async function checkpointedWorkspace(e: Env, t: Tenant, repo: Repo, name: string, opts: { accepted?: boolean } = {}) {
  const id = randomUUID();
  const spec = specFor(t, await e.setupRef(t), repo.base, { branch: `factory/${t.taskId}/${name}` });
  await e.manager.allocateOrAttach(e.runner(t), id, spec);
  await e.host.ensureMaterialized(e.runner(t), id);
  await e.manager.markWriterStarted(e.runner(t), id, 1, `pod-${name}`);
  const commit = repo.commit({ [`${name}.txt`]: name }, `candidate ${name}`);
  const sourceRef = await e.putArtifact(t, repo.bundle(), 'application/x-git-bundle', `candidate_source/${name}`);
  // `accepted` adds the checkpoint_ref W-020 will record: a registered, retained artifact. Release needs it; replaceWriter then answers restore_required.
  const checkpointRef = opts.accepted ? await e.putArtifact(t, Buffer.from(`{"checkpoint":"${name}"}`), 'application/json', `checkpoint/${name}`) : undefined;
  await e.db.withTenant({ orgId: t.orgId }, (tx) => transitionWorkspace(tx, { orgId: t.orgId, id, expectedEpoch: 1, from: ['active'], patch: { state: 'checkpointed', candidateCommit: commit, ...(checkpointRef ? { checkpointRef } : {}) } }));
  return { id, spec, commit, sourceRef, branch: `factory/${t.taskId}/${name}` };
}

// Every file under a directory with its mode and a content hash, for "byte-for-byte untouched".
export function snapshotTree(dir: string): string {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const s = lstatSync(p);
      const r = `${rel}/${name}`;
      if (s.isSymbolicLink()) out.push(`L ${r} ${readlinkSync(p)}`);
      else if (s.isDirectory()) { out.push(`D ${r} ${(s.mode & 0o777).toString(8)}`); walk(p, r); }
      else out.push(`F ${r} ${(s.mode & 0o777).toString(8)} ${s.size} ${sha256(readFileSync(p))}`);
    }
  };
  walk(dir, '');
  return out.join('\n');
}
