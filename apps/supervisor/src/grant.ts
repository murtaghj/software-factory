// A grant: the runner's answer to a permit call, which is the only thing that lets the supervisor look at the workspace. It is minted in one place, the
// permit client (`runner-client.ts`), and a structural test fails if any other source file imports `mintGrant`. A hand-made object is not a grant.
import type { PermitGrantAnswer } from '@factory/runner-protocol';

const minted = new WeakSet<object>();
export type Grant = Readonly<PermitGrantAnswer>;
export function mintGrant(answer: PermitGrantAnswer): Grant {
  const g: Grant = Object.freeze({ ...answer });
  minted.add(g);
  return g;
}
export const isGrant = (v: unknown): v is Grant => typeof v === 'object' && v !== null && minted.has(v);
