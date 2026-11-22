// The import closure of a set of files: every module that they load, through relative paths and through the workspace packages, stopping at node: modules
// and external packages, which are listed. A type-only import is erased and not followed. Used by the reader's structure test.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dirname, '..', '..', '..');

function packageEntry(name: string): string | undefined {
  const dir = join(ROOT, 'packages', name.slice('@factory/'.length));
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { exports?: Record<string, string> | string };
    const entry = typeof manifest.exports === 'string' ? manifest.exports : manifest.exports?.['.'];
    return entry === undefined ? undefined : join(dir, entry);
  } catch { return undefined; }
}

export function importClosure(entries: readonly string[]): { modules: Map<string, string[]>; external: Map<string, string[]> } {
  const modules = new Map<string, string[]>(); // file -> the files that import it
  const external = new Map<string, string[]>(); // a bare specifier or node: module -> the files that import it
  const queue = [...entries];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    modules.set(file, modules.get(file) ?? []);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const specs: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
        const typeOnly = ts.isImportDeclaration(node)
          ? clause?.phaseModifier === ts.SyntaxKind.TypeKeyword || (clause?.name === undefined && clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly))
          : node.isTypeOnly;
        if (!typeOnly && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0])) specs.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const spec of specs) {
      let target: string | undefined;
      if (spec.startsWith('.')) target = join(dirname(file), spec);
      else if (spec.startsWith('@factory/')) target = packageEntry(spec.split('/').slice(0, 2).join('/'));
      if (target !== undefined) { modules.set(target, [...(modules.get(target) ?? []), file]); queue.push(target); } else external.set(spec, [...(external.get(spec) ?? []), file]);
    }
  }
  return { modules, external };
}

