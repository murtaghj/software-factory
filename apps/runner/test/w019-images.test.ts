// The two new images' build contexts and the script's certificate (W-019, 19b): only named source files, none under test/, no test entry, and an ECDSA P-256 listener certificate.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
let out: string;
const sh = (...a: string[]): string => execFileSync('sh', [join(ROOT, 'scripts', 'k3s.sh'), ...a], { env: { ...process.env, K3S_OUT: out }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const files = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name).slice(dir.length + 1)).sort();
beforeAll(() => { out = mkdtempSync(join(tmpdir(), 'w019-images-')); sh('stage'); sh('pki'); });
afterAll(() => { rmSync(out, { recursive: true, force: true }); });

describe('W-019 images and the local tier\'s files', () => {
  it('the supervisor\'s context lists only named source files: no test directory, no test entry, no script, no launcher', () => {
    const ctx = join(out, 'ctx', 'supervisor');
    const list = files(ctx);
    expect(list).toEqual(['Containerfile', 'app/apps/supervisor/package.json', ...['args', 'grant', 'group', 'heartbeat', 'local-endpoint', 'main', 'network-gate', 'runner-client', 'state', 'supervisor', 'token-file', 'workspace-view'].map((f) => `app/apps/supervisor/src/${f}.ts`),
      'app/packages/runner-protocol/package.json', ...['exit-codes', 'index', 'pod-api'].map((f) => `app/packages/runner-protocol/src/${f}.ts`)].sort());
    expect(list.filter((f) => /(^|\/)test(\/|$)|\.test\.ts$|test-entry|\/scripts\//.test(f))).toEqual([]);
    expect(list.some((f) => f.endsWith('launcher.ts'))).toBe(false); // control for the filter above: named files only
  });

  it('every relative import in every staged context resolves inside that context, so an image cannot ship a module whose import is missing (W-019b shipped materializer.ts without internal/pod-mode.ts)', () => {
    const ctxRoot = join(out, 'ctx');
    const contexts = readdirSync(ctxRoot).sort();
    expect(contexts).toContain('materializer'); // control: the walk sees the context that broke
    // A context built FROM another image sees that image's files too, at the paths its Containerfile copies to.
    const layered: Record<string, { base: string; from: string; to: string }> = { 'materializer-test': { base: 'materializer', from: 'test-app', to: 'app/apps/runner/test' } };
    const missing: string[] = [];
    let checked = 0;
    for (const name of contexts) {
      const ctx = join(ctxRoot, name);
      const layer = layered[name];
      const inImage = (rel: string): string => (layer !== undefined && (rel === layer.from || rel.startsWith(layer.from + '/')) ? layer.to + rel.slice(layer.from.length) : rel);
      const present = (rel: string): boolean => existsSync(join(ctx, rel)) || (layer !== undefined && (existsSync(join(ctxRoot, layer.base, rel)) || files(ctx).some((x) => inImage(x) === rel)));
      // Source files only (not node_modules), and runtime imports only: `import type` is erased when Node strips types, so it needs no file.
      for (const f of files(ctx).filter((x) => x.endsWith('.ts') && !x.endsWith('.d.ts') && !x.includes('node_modules/'))) {
        const text = readFileSync(join(ctx, f), 'utf8');
        for (const m of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]|^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
          const spec = (m[1] ?? m[2] ?? m[3]) as string;
          checked += 1;
          const target = join(dirname(inImage(f)), spec); // a path inside the image, relative to its root
          if (target.startsWith('..') || target.startsWith('/') || !present(target)) missing.push(`${name}: ${f} -> ${spec}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('each scripted harness image has its own context: the launcher, its group helper and ONE script, no program chooser and no test entry; the Containerfile labels it a test harness and bakes the script in', () => {
    const scripts = ['idle', 'exit0', 'write-file', 'spawn-tree', 'ignore-term', 'hint-flood'];
    for (const sc of scripts) {
      const list = files(join(out, 'ctx', `harness-scripted-${sc}`));
      expect(list, sc).toEqual(['Containerfile', 'app/apps/supervisor/package.json', 'app/apps/supervisor/src/group.ts', 'app/apps/supervisor/src/launcher.ts', `app/apps/supervisor/src/scripts/${sc}.ts`].sort());
      expect(list.filter((f) => /(^|\/)test(\/|$)|\.test\.ts$|test-entry|supervisor\.ts$|runner-client|program\.ts$/.test(f)), sc).toEqual([]);
    }
    const containerfile = readFileSync(join(ROOT, 'deploy', 'images', 'harness-scripted', 'Containerfile'), 'utf8');
    expect(containerfile).toMatch(/LABEL factory\.harness="scripted" factory\.harness\.script="\$\{SCRIPT\}"/);
    expect(containerfile).not.toMatch(/FACTORY_SCRIPT|\bENV\b/); // nothing in a running image can pick another script
    expect(existsSync(join(ROOT, 'apps', 'supervisor', 'src', 'scripts', 'program.ts'))).toBe(false); // the chooser is gone
    // the existing contexts did not grow a test entry in the production image
    expect(files(join(out, 'ctx', 'materializer')).some((f) => /test/.test(f))).toBe(false);
    expect(files(join(out, 'ctx', 'materializer-test')).some((f) => f.includes('materialize-test-entry'))).toBe(true); // control: the TEST image is where the test entry is
  });

  it('no image ships a package manager: apk, npm, npx, yarn and corepack are removed in the same layer as the install, in the supervisor, harness and materializer Containerfiles', () => {
    for (const name of ['supervisor', 'harness-scripted', 'materializer']) {
      const text = readFileSync(join(ROOT, 'deploy', 'images', name, 'Containerfile'), 'utf8');
      const run = text.split('\n').find((l) => l.startsWith('RUN apk add')) ?? '';
      expect(run, name).toContain('rm -rf /sbin/apk');
      for (const gone of ['/usr/local/lib/node_modules/npm', '/usr/local/lib/node_modules/corepack', '/usr/local/bin/npm', '/usr/local/bin/npx', '/usr/local/bin/corepack', '/opt/yarn-*', '/usr/local/bin/yarn', '/usr/local/bin/yarnpkg']) expect(run, `${name}: ${gone}`).toContain(gone);
    }
  });

  it('the listener\'s key is ECDSA P-256, its certificate is named for the gateway address and signed by the throwaway CA, the CA\'s key is gone, and every file is 0600', () => {
    const pki = join(out, 'pki');
    expect(files(pki)).toEqual(['ca.crt', 'ca.sha256', 'listener.crt', 'listener.key']);
    // the leaf is a server certificate and not a CA
    const text = execFileSync('openssl', ['x509', '-in', join(pki, 'listener.crt'), '-noout', '-text'], { encoding: 'utf8' });
    expect(text).toContain('CA:FALSE');
    expect(text).toContain('TLS Web Server Authentication');
    expect(readFileSync(join(ROOT, 'scripts', 'k3s.sh'), 'utf8')).toMatch(/delete configmap "\$CA_CONFIGMAP" --ignore-not-found/); // a second `up` replaces the immutable CA ConfigMap
    for (const f of files(pki)) expect(statSync(join(pki, f)).mode & 0o777).toBe(0o600);
    expect(execFileSync('openssl', ['ec', '-in', join(pki, 'listener.key'), '-noout', '-text'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toContain('prime256v1');
    expect(execFileSync('openssl', ['x509', '-in', join(pki, 'listener.crt'), '-noout', '-text'], { encoding: 'utf8' })).toContain('IP Address:192.168.127.254');
    execFileSync('openssl', ['verify', '-CAfile', join(pki, 'ca.crt'), join(pki, 'listener.crt')], { stdio: 'pipe' });
    expect(readFileSync(join(pki, 'ca.sha256'), 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(out, 'pki', 'ca.key'))).toBe(false);
    // keys are outside the build contexts
    expect(files(join(out, 'ctx')).some((f) => /\.(key|crt)$/.test(f))).toBe(false);
    // and the script asks for the same curve in its own text
    expect(readFileSync(join(ROOT, 'scripts', 'k3s.sh'), 'utf8').match(/ecparam -name prime256v1/g)?.length).toBe(2);
  });

  it('the local egress policy is default-deny with one allow rule for the listener\'s address and port, applied on every `up`; the runner may get one node and one Service, nothing else', () => {
    const policy = readFileSync(join(ROOT, 'deploy', 'k8s', 'local', 'egress-listener-only.yaml'), 'utf8');
    expect(policy).toContain('podSelector: {}');
    expect(policy).toContain('policyTypes: [Egress]');
    expect(policy).toMatch(/cidr: __LISTENER_ADDRESS__\/32/);
    expect(policy).toMatch(/port: __LISTENER_PORT__/);
    expect(policy.match(/ipBlock/g)).toHaveLength(1);
    const script = readFileSync(join(ROOT, 'scripts', 'k3s.sh'), 'utf8');
    expect(script).toContain('egress-listener-only.yaml');
    expect(script).toMatch(/immutable: true/);
    const rbac = readFileSync(join(ROOT, 'deploy', 'k8s', 'runner-rbac.yaml'), 'utf8');
    expect(rbac).toMatch(/resources: \["nodes"\]\n\s+verbs: \["get"\]/);
    expect(rbac).toMatch(/resourceNames: \["kubernetes"\]/);
    expect(rbac).not.toMatch(/resources:.*configmaps/i); // the runner gains no right on ConfigMaps
  });
});
