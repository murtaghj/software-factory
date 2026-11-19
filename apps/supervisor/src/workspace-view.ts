// The workspace view (section 6, 19b): the one look the supervisor takes at the workspace, and the only file that may import `node:fs` for a workspace path (a lint
// rule and a structural test say so). It can be built only from a grant. It works ONLY in `preparing`: every method asserts the supervisor's state and throws in any
// other, because its walk is `lstat` by path and then a listing by path, which is safe only while no candidate code is running. After the start a component can be
// swapped for a symlink between the two calls, and the supervisor would follow it inside its own mount namespace, where the token is. Every call is logged.
//
// The rule for everyone after (README): any read of the workspace once the harness has started uses descriptor-relative, no-follow traversal, or a helper process
// with no credential (`06:108`).
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isGrant, type Grant } from './grant.ts';
import type { State } from './state.ts';

export class ViewRefused extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) { super(message); this.reason = reason; }
}
export type ViewOptions = { grant: Grant; state: State; workspaceRoot: string; org: string; workspace: string; generation: number; log: (event: string, detail?: Record<string, unknown>) => void };

export class WorkspaceView {
  readonly #o: ViewOptions;
  constructor(o: ViewOptions) {
    // The runtime guard behind the type: a hand-made object is not a grant.
    if (!isGrant(o.grant)) throw new TypeError('a workspace view can be built only from a grant');
    this.#o = o;
  }
  #assertPreparing(what: string): void {
    if (this.#o.state.state !== 'preparing') throw new ViewRefused('wrong_state', `${what}: the workspace view works only in preparing (the state is ${this.#o.state.state})`);
  }

  // lstat each component from /workspace/factory down to g<generation>/work/main, require a real directory at each, and list work/main.
  checkout(): string[] {
    this.#assertPreparing('checkout');
    const { workspaceRoot, org, workspace, generation } = this.#o;
    let dir = workspaceRoot;
    for (const part of ['factory', org, workspace, `g${String(generation)}`, 'work', 'main']) {
      dir = join(dir, part);
      this.#o.log('workspace_view_lstat', { component: part });
      let s;
      try { s = lstatSync(dir); } catch { throw new ViewRefused('missing_component', `${part} does not exist`); }
      if (s.isSymbolicLink()) throw new ViewRefused('symlink_component', `${part} is a symbolic link`);
      if (!s.isDirectory()) throw new ViewRefused('not_a_directory', `${part} is not a directory`);
    }
    this.#assertPreparing('list');
    let entries: string[];
    try { entries = readdirSync(dir); } catch { throw new ViewRefused('unreadable', 'work/main cannot be listed'); }
    // Logged AFTER a successful listing, with the count: the line is evidence that uid 10002 could list the checkout (an EACCES logs nothing).
    this.#o.log('workspace_view_list', { entries: entries.length });
    return entries;
  }
}
