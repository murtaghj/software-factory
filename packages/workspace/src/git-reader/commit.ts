// A commit as the reader needs it (W-020a, 7.3): the first line is `tree <oid>`, followed only by
// `parent <oid>` lines before any other header, at most 64 of them. Other headers are not parsed.
import { refuse } from './errors.ts';
import { OID } from './loose.ts';

export const MAX_PARENTS = 64;
export type ParsedCommit = { tree: string; parents: string[] };

export function parseCommit(body: Buffer, file: string): ParsedCommit {
  // Only the header block is looked at; it ends at the first blank line.
  const end = body.indexOf('\n\n');
  const header = body.subarray(0, end === -1 ? body.length : end).toString('latin1');
  const lines = header.split('\n');
  const first = lines[0] ?? '';
  if (!first.startsWith('tree ') || !OID.test(first.slice(5))) throw refuse('object_corrupt', 'a commit does not start with `tree <oid>`', file);
  const parents: string[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith('parent ')) break;
    const oid = line.slice(7);
    if (!OID.test(oid)) throw refuse('object_corrupt', 'a parent line is not `parent <oid>`', file);
    parents.push(oid);
    if (parents.length > MAX_PARENTS) throw refuse('object_corrupt', 'a commit has more than 64 parents', file);
  }
  return { tree: first.slice(5), parents };
}
