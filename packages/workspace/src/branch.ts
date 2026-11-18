// Task branch names: factory/{taskId}/{name}, nothing else (chapter 06: "branch names outside the
// task namespace" are refused).
import { WorkspaceError } from './errors.ts';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function taskBranchPrefix(taskId: string): string {
  return `factory/${taskId}/`;
}

export function assertTaskBranch(taskId: string, branch: string): void {
  const prefix = taskBranchPrefix(taskId);
  const name = branch.startsWith(prefix) ? branch.slice(prefix.length) : undefined;
  if (name === undefined || !NAME.test(name) || name.includes('..') || name.endsWith('.') || name.endsWith('.lock')) {
    throw new WorkspaceError('branch_outside_namespace', `branch must be ${prefix}<name>`, { branch });
  }
}
