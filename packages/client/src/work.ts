// "My work" and project boards (plan-additions P-21): client-side shapes. What to do next is no
// longer decided here: the server ranks it (P-24, `queue.ts`).

export const BOARD_COLUMNS = ['queued', 'running', 'waiting', 'paused', 'done', 'stopped'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
export const COLUMN_LABELS: Record<BoardColumn, string> = { queued: 'Queued', running: 'Running', waiting: 'Waiting on a person', paused: 'Paused', done: 'Done', stopped: 'Stopped' };

// Where a task is on its plan's line, and one station of that line (API: apps/api/src/tasks/stations.ts, A-23).
// `index` counts from 1. A gate is a stage where a person must decide.
export type Station = { nodeId: string; label: string; gate: boolean };
export type StageDescriptor = { nodeId: string; label: string; index: number; count: number; gate: boolean };

export type TaskCard = {
  taskId: string; applicationId: string; title: string; status: string; column: BoardColumn; workType: string;
  creatorId: string; ownerPrincipalId: string; currentNodeId?: string; waitingReason?: string;
  waitingOnPrincipalId?: string; decisionId?: string; decisionExpiresAt?: string; stage?: StageDescriptor; updatedAt: string;
};
export type Board = { applicationId: string; name: string; generatedAt: string; columns: Record<BoardColumn, TaskCard[]>; needsPerson: TaskCard[]; stations: Station[]; spentThisMonthMicroUsd: number; people: Record<string, string>; truncated: boolean };
export type MyWork = { principalId: string; generatedAt: string; needsYou: TaskCard[]; stopped: TaskCard[]; waitingOnOthers: TaskCard[]; inProgress: TaskCard[]; recentlyDone: TaskCard[]; applications: Record<string, string>; people: Record<string, string>; truncated: boolean };

export type Me = { principalId: string; displayName: string; roles: string[]; projects: Array<{ applicationId: string; name: string }> };
export const MY_WORK_SECTIONS: Array<{ key: 'needsYou' | 'stopped' | 'waitingOnOthers' | 'inProgress' | 'recentlyDone'; label: string }> = [
  { key: 'needsYou', label: 'Needs you' }, { key: 'stopped', label: 'Stopped and needs a look' }, { key: 'waitingOnOthers', label: 'Waiting on others' }, { key: 'inProgress', label: 'In progress' }, { key: 'recentlyDone', label: 'Recently done' },
];

// One line per card for text clients (CLI, agents).
export function cardLine(c: TaskCard, people: Record<string, string>, applications: Record<string, string> = {}): string {
  const project = applications[c.applicationId];
  const detail = c.waitingOnPrincipalId ? `waiting on ${people[c.waitingOnPrincipalId] ?? 'someone'}` : c.currentNodeId ? `stage ${c.currentNodeId}` : c.waitingReason ?? '';
  return `${c.taskId}  ${c.status.padEnd(16)} ${project ? `[${project}] ` : ''}${c.title}${detail ? ` — ${detail}` : ''}`;
}
