// Test-only stand-in for TaskWorkflow (the real one is apps/worker, W-011). It exposes the
// dispatcher-facing contract: the applyCommand Update keyed by commandId, a receipt set carried
// across Continue-As-New, and a query for how many times commands took effect.
import { condition, continueAsNew, defineQuery, defineSignal, defineUpdate, setHandler } from '@temporalio/workflow';

type Command = { commandId: string; kind: string; rollover?: boolean };
type Result = { state: 'accepted' | 'applied' | 'rejected'; reason?: string; resultingRevision?: number };
type Carried = { applied: string[]; effects: number };

export const applyCommand = defineUpdate<Result, [Command]>('applyCommand');
export const effectsQuery = defineQuery<number>('effects');
export const finish = defineSignal('finish');

export async function TaskWorkflow(_launch: unknown, carried?: Carried): Promise<number> {
  const applied = new Set(carried?.applied ?? []);
  let effects = carried?.effects ?? 0;
  const state = { done: false, rollover: false };
  setHandler(effectsQuery, () => effects);
  setHandler(finish, () => { state.done = true; });
  setHandler(applyCommand, (cmd) => {
    if (applied.has(cmd.commandId)) return { state: 'applied', reason: 'duplicate delivery', resultingRevision: effects };
    if (cmd.kind === 'reject_me') return { state: 'rejected', reason: 'stale subject' };
    applied.add(cmd.commandId);
    effects += 1;
    if (cmd.rollover === true) state.rollover = true;
    return { state: 'applied', resultingRevision: effects };
  });
  await condition(() => state.done || state.rollover);
  if (state.rollover) await continueAsNew<typeof TaskWorkflow>(_launch, { applied: [...applied], effects });
  return effects;
}
