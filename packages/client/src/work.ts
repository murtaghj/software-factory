// "My work" and project boards (plan-additions P-21): client-side shapes and the one-line answer to
// "what should I do next?". The order is fixed: answer what others are blocked on, then look at
// your own stopped work, and only then is there nothing for you to do but let work run.
export const BOARD_COLUMNS = ['queued', 'running', 'waiting', 'paused', 'done', 'stopped'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
export const COLUMN_LABELS: Record<BoardColumn, string> = { queued: 'Queued', running: 'Running', waiting: 'Waiting on a person', paused: 'Paused', done: 'Done', stopped: 'Stopped' };

export type TaskCard = {
  taskId: string; applicationId: string; title: string; status: string; column: BoardColumn; workType: string;
  creatorId: string; ownerPrincipalId: string; currentNodeId?: string; waitingReason?: string;
  waitingOnPrincipalId?: string; decisionId?: string; decisionExpiresAt?: string; updatedAt: string;
};
export type Board = { applicationId: string; name: string; generatedAt: string; columns: Record<BoardColumn, TaskCard[]>; needsPerson: TaskCard[]; spentThisMonthMicroUsd: number; people: Record<string, string>; truncated: boolean };
export type MyWork = { principalId: string; generatedAt: string; needsYou: TaskCard[]; stopped: TaskCard[]; waitingOnOthers: TaskCard[]; inProgress: TaskCard[]; recentlyDone: TaskCard[]; applications: Record<string, string>; people: Record<string, string>; truncated: boolean };

export type Focus = { kind: 'answer' | 'look' | 'running' | 'waiting' | 'clear'; text: string; taskId?: string; decisionId?: string };
const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;
const who = (work: MyWork, id: string | undefined): string => (id === undefined ? 'someone' : work.people[id] ?? 'someone');

// The single next thing for the signed-in developer.
export function focusOf(work: MyWork): Focus {
  const ask = work.needsYou[0];
  if (ask) return { kind: 'answer', taskId: ask.taskId, ...(ask.decisionId ? { decisionId: ask.decisionId } : {}), text: `${plural(work.needsYou.length, 'decision is', 'decisions are')} waiting on you. Start with "${ask.title}"${ask.decisionExpiresAt ? ` (expires ${ask.decisionExpiresAt})` : ''}.` };
  const stopped = work.stopped[0];
  if (stopped) return { kind: 'look', taskId: stopped.taskId, text: `${plural(work.stopped.length, 'of your tasks', 'of your tasks')} stopped without finishing. Look at "${stopped.title}" (${stopped.status}${stopped.waitingReason ? `: ${stopped.waitingReason}` : ''}).` };
  if (work.inProgress.length > 0) return { kind: 'running', text: `Nothing needs you. ${plural(work.inProgress.length, 'task is', 'tasks are')} in progress.` };
  const waiting = work.waitingOnOthers[0];
  if (waiting) return { kind: 'waiting', taskId: waiting.taskId, text: `Nothing needs you. "${waiting.title}" is waiting on ${who(work, waiting.waitingOnPrincipalId)}.` };
  return { kind: 'clear', text: 'Nothing needs you and nothing is running.' };
}

export const MY_WORK_SECTIONS: Array<{ key: 'needsYou' | 'stopped' | 'waitingOnOthers' | 'inProgress' | 'recentlyDone'; label: string }> = [
  { key: 'needsYou', label: 'Needs you' }, { key: 'stopped', label: 'Stopped — needs a look' }, { key: 'waitingOnOthers', label: 'Waiting on others' }, { key: 'inProgress', label: 'In progress' }, { key: 'recentlyDone', label: 'Recently done' },
];

// One line per card for text clients (CLI, agents).
export function cardLine(c: TaskCard, people: Record<string, string>, applications: Record<string, string> = {}): string {
  const project = applications[c.applicationId];
  const detail = c.waitingOnPrincipalId ? `waiting on ${people[c.waitingOnPrincipalId] ?? 'someone'}` : c.currentNodeId ? `stage ${c.currentNodeId}` : c.waitingReason ?? '';
  return `${c.taskId}  ${c.status.padEnd(16)} ${project ? `[${project}] ` : ''}${c.title}${detail ? ` — ${detail}` : ''}`;
}
