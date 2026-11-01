// Package-boundary checker (W-002, AC-260). Usage: node tools/check-boundaries.ts [rootDir]
// Exits non-zero and lists every violation; prints a summary on success.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';

type PackageRule = { allowWorkspace: string[]; denyExternal: string[] };
type RestrictedPath = { package: string; glob: string; allowPackages: string[]; allowRelativeWithin: string; reason: string };
type Rules = {
  packages: Record<string, PackageRule>;
  importableApps: Record<string, string[]>;
  restrictedPaths: RestrictedPath[];
};
type WorkspacePackage = { name: string; dir: string; isApp: boolean; deps: Set<string> };

const SOURCE_DIRS = ['src', 'test', 'scripts'];

// Every module reference in a file, found with the TypeScript parser (not a regex), so import
// forms such as `import{x}from'pg'`, `export * as n from 'm'` and template-literal `import()` are
// all seen. A dynamic import or require() whose argument is not a string literal is reported
// as unresolvable and fails the check.
export type ModuleReference = { specifier: string | undefined; line: number };

export function moduleReferences(fileName: string, text: string): ModuleReference[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: ModuleReference[] = [];
  const lineOf = (n: ts.Node): number => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
  const literal = (n: ts.Node | undefined): string | undefined =>
    n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      out.push({ specifier: literal(node.moduleSpecifier), line: lineOf(node) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      out.push({ specifier: literal(node.moduleReference.expression), line: lineOf(node) });
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isImport || isRequire) out.push({ specifier: literal(node.arguments[0]), line: lineOf(node) });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      out.push({ specifier: literal(node.argument.literal), line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function listTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'generated-fixtures') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTs(full));
    else if (/\.(ts|tsx|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

function discover(root: string): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  const groups: Array<[string, boolean]> = [['packages', false], ['apps', true], ['tests', false]];
  const dirs: Array<[string, boolean]> = [];
  for (const [group, isApp] of groups) {
    const g = join(root, group);
    if (!existsSync(g)) continue;
    for (const entry of readdirSync(g)) dirs.push([join(g, entry), isApp]);
  }
  if (existsSync(join(root, 'fixtures', 'package.json'))) dirs.push([join(root, 'fixtures'), false]);
  for (const [dir, isApp] of dirs) {
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    };
    out.push({ name: manifest.name, dir, isApp, deps: new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]) });
  }
  return out;
}

function packageOf(specifier: string): string {
  if (specifier.startsWith('node:')) return specifier;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

export function checkBoundaries(root: string): string[] {
  const rules = JSON.parse(readFileSync(join(root, 'tools', 'boundaries.json'), 'utf8')) as Rules;
  const packages = discover(root);
  const byName = new Map(packages.map((p) => [p.name, p]));
  const violations: string[] = [];
  for (const pkg of packages) {
    const rule = rules.packages[pkg.name];
    if (!rule) { violations.push(`${pkg.name}: no boundary rule declared in tools/boundaries.json`); continue; }
    for (const dep of pkg.deps) {
      if (byName.has(dep) && !rule.allowWorkspace.includes(dep)) violations.push(`${pkg.name}: package.json declares disallowed workspace dependency ${dep}`);
    }
    for (const file of SOURCE_DIRS.flatMap((d) => listTs(join(pkg.dir, d)))) {
      const rel = relative(pkg.dir, file).split(sep).join('/');
      const text = readFileSync(file, 'utf8');
      const restricted = rules.restrictedPaths.filter((r) => r.package === pkg.name && rel.startsWith(r.glob));
      for (const ref of moduleReferences(file, text)) {
        const spec = ref.specifier;
        const where = `${pkg.name}/${rel}:${String(ref.line)}`;
        if (spec === undefined) { violations.push(`${where}: module reference is not a string literal and cannot be checked`); continue; }
        for (const r of restricted) {
          if (spec.startsWith('.')) {
            const allowedDir = resolve(pkg.dir, r.allowRelativeWithin);
            if (!resolve(dirname(file), spec).startsWith(allowedDir + sep)) violations.push(`${where}: imports ${spec}, outside ${r.allowRelativeWithin} (${r.reason})`);
          } else if (!r.allowPackages.some((allowed) => spec === allowed || spec.startsWith(allowed + '/'))) {
            violations.push(`${where}: imports ${spec}, outside the allow-list for ${r.glob} (${r.reason})`);
          }
        }
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec);
          if (!target.startsWith(pkg.dir + sep)) violations.push(`${where}: relative import ${spec} escapes the package root`);
          continue;
        }
        const name = packageOf(spec);
        const target = byName.get(name);
        if (target) {
          if (target.name === pkg.name) continue;
          const appAllowed = rules.importableApps[pkg.name]?.includes(target.name) ?? false;
          if (target.isApp && !appAllowed) violations.push(`${where}: imports app ${target.name}; apps are not importable`);
          else if (!rule.allowWorkspace.includes(target.name)) violations.push(`${where}: imports ${target.name}, which is not an allowed dependency`);
          else if (!pkg.deps.has(target.name)) violations.push(`${where}: imports ${target.name} without declaring it in package.json`);
          continue;
        }
        const normalized = builtinModules.includes(packageOf(spec)) ? `node:${spec}` : spec;
        if (!rel.startsWith('src/')) continue; // denyExternal governs shipped runtime code, not tests or build scripts
        for (const denied of rule.denyExternal) {
          if (normalized === denied || normalized.startsWith(denied)) violations.push(`${where}: imports denied module ${spec}`);
        }
      }
    }
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const root = resolve(process.argv[2] ?? '.');
  const violations = checkBoundaries(root);
  if (violations.length > 0) {
    console.error(`Package boundary violations (${String(violations.length)}):`);
    for (const v of violations) console.error('  ' + v);
    process.exit(1);
  }
  console.log('Package boundaries: OK');
}
