// Commands and receipts: the applyCommand Update, the state query and the pure receipt decisions.
// Receipts keyed by commandId are carried across Continue-As-New, so a redelivered command is
// answered, not re-applied (AC-08). A command whose expectedRevision is not the current control
// revision is rejected with a reason (AC-07). Under authority-v1 an Update first awaits an authority
// check Activity, so decisions are chained: each command is decided only after the one that arrived
// before it, in arrival order. Earlier builds decide synchronously and never chain.
import { ActivityFailure, condition, defineQuery, defineUpdate, setHandler } from '@temporalio/workflow';
import { CANCELLABLE, PAUSABLE, persist } from './config.ts';
import type { RunControl } from './run-context.ts';
import { TERMINAL, type Checkpoint, type CommandPayload, type LaunchPayload, type Receipt, type WorkflowView } from './types.ts';

export const applyCommand = defineUpdate<Receipt, [CommandPayload]>('applyCommand');
export const stateQuery = defineQuery<WorkflowView>('state');

export const viewOf = (st: Checkpoint): WorkflowView => ({ status: st.status, controlRevision: st.controlRevision, specVersion: st.specVersion, planVersion: st.plan.version, projectionSequence: st.projectionSequence, nodes: st.nodes, supersededResults: st.supersededResults, receiptCount: Object.keys(st.receipts).length });

// A human decision applies only to the exact pending request and subject, from the required
// peer, with full reviewed scope, through the response endpoint (AC-07, AC-44, INV-21).
const applyDecisionResponse = (st: Checkpoint, cmd: CommandPayload): Receipt => {
  const d = st.decision;
  if (!d || d.requestId !== cmd.decisionId) return { state: 'rejected', reason: 'unknown_or_closed_decision' };
  if (d.state === 'expired') return { state: 'rejected', reason: 'decision_expired' };
  if (d.state === 'superseded') return { state: 'rejected', reason: 'stale_subject: the decision was superseded' };
  if (d.state !== 'pending') return { state: 'rejected', reason: 'decision_already_resolved' };
  if (cmd.channel !== 'decision_response_endpoint') return { state: 'rejected', reason: 'decision_requires_response_endpoint' };
  if (cmd.subjectHash !== d.subjectHash) return { state: 'rejected', reason: 'stale_subject: response names a different subject' };
  if (cmd.deciderPrincipalId === undefined || cmd.deciderPrincipalId !== d.requiredPrincipalId) return { state: 'rejected', reason: 'not_the_required_peer' };
  if (d.authorPrincipalIds.includes(cmd.deciderPrincipalId)) return { state: 'rejected', reason: 'author_cannot_approve' };
  if (cmd.outcome !== 'approve' && cmd.outcome !== 'reject' && cmd.outcome !== 'request_changes') return { state: 'rejected', reason: 'invalid_outcome' };
  const reviewed = cmd.reviewedSectionIds ?? [];
  if (cmd.outcome === 'approve' && !d.sectionIds.every((sid) => reviewed.includes(sid))) return { state: 'rejected', reason: 'reviewed_scope_incomplete' };
  st.controlRevision += 1;
  st.decision = { ...d, state: cmd.outcome, commandId: cmd.commandId, deciderPrincipalId: cmd.deciderPrincipalId, reviewedSectionIds: reviewed, reason: typeof cmd.reason === 'string' ? cmd.reason : cmd.outcome };
  return { state: 'applied', resultingRevision: st.controlRevision };
};

// Commands whose issuer is authorized at ingress and again when applied (authority-v1): pause,
// resume, cancel, change_budget, respond_decision and amend_spec in the form the API produces (naming
// a spec artifact). amend_spec with a bare specVersion is the pre-commands-v1 form, which the API
// never sends.
const needsAuthorityRecheck = (cmd: CommandPayload): boolean => ['pause', 'resume', 'cancel', 'change_budget', 'respond_decision'].includes(cmd.kind) || (cmd.kind === 'amend_spec' && cmd.specRef !== undefined);

// Decides the receipt for a command that has no prior receipt, mutating the checkpoint when the
// command applies.
const decideReceipt = (st: Checkpoint, cmd: CommandPayload, commandsV1: boolean, control: RunControl): Receipt => {
  let receipt: Receipt;
  if (TERMINAL.includes(st.status)) {
    receipt = { state: 'rejected', reason: `task is ${st.status}` };
  } else if (cmd.expectedRevision !== st.controlRevision) {
    receipt = { state: 'rejected', reason: `stale_revision: expected ${String(cmd.expectedRevision)}, current ${String(st.controlRevision)}` };
  } else if (commandsV1 && cmd.kind === 'cancel') {
    // A repeat in cancelling is an idempotent no-op; terminal states were rejected above.
    if (st.cancelRequested === true || st.status === 'cancelling') receipt = { state: 'applied', reason: 'already cancelling', resultingRevision: st.controlRevision };
    else if (!CANCELLABLE.includes(st.status)) receipt = { state: 'rejected', reason: `cannot cancel while ${st.status}` };
    else { st.controlRevision += 1; st.cancelRequested = true; control.inflight?.cancel(); receipt = { state: 'applied', resultingRevision: st.controlRevision }; }
  } else if (commandsV1 && cmd.kind === 'pause') {
    if (st.cancelRequested === true || st.status === 'cancelling') receipt = { state: 'applied', reason: 'already cancelling', resultingRevision: st.controlRevision };
    else if (!PAUSABLE.includes(st.status)) receipt = { state: 'rejected', reason: `cannot pause while ${st.status}` };
    else { st.controlRevision += 1; st.pausedFrom = st.status; st.status = 'paused'; receipt = { state: 'applied', resultingRevision: st.controlRevision }; }
  } else if (commandsV1 && cmd.kind === 'resume') {
    if (st.status !== 'paused') receipt = { state: 'rejected', reason: `cannot resume while ${st.status}` };
    else { st.controlRevision += 1; st.status = st.pausedFrom ?? 'running'; delete st.pausedFrom; receipt = { state: 'applied', resultingRevision: st.controlRevision }; }
  } else if (commandsV1 && cmd.kind === 'change_budget' && typeof cmd.budgetMicroUsd === 'number' && Number.isSafeInteger(cmd.budgetMicroUsd) && cmd.budgetMicroUsd >= 0) {
    st.controlRevision += 1; st.pendingBudgetMicroUsd = cmd.budgetMicroUsd; receipt = { state: 'applied', resultingRevision: st.controlRevision };
  } else if (commandsV1 && cmd.kind === 'amend_spec' && cmd.specRef !== undefined && st.pendingAmendSpecVersion === undefined && st.pendingAmendSpecRef === undefined) {
    st.controlRevision += 1; st.pendingAmendSpecRef = cmd.specRef; st.pendingAmendSpecVersion = st.specVersion + 1; st.pendingAmendCommandId = cmd.commandId;
    receipt = { state: 'applied', resultingRevision: st.controlRevision };
  } else if (commandsV1 && cmd.kind === 'respond_decision') {
    receipt = applyDecisionResponse(st, cmd);
  } else if (cmd.kind === 'amend_spec' && typeof cmd.specVersion === 'number' && cmd.specVersion === st.specVersion + 1 && st.pendingAmendSpecVersion === undefined) {
    st.controlRevision += 1;
    st.pendingAmendSpecVersion = cmd.specVersion;
    receipt = { state: 'applied', resultingRevision: st.controlRevision };
  } else if (cmd.kind === 'amend_spec') {
    receipt = { state: 'rejected', reason: 'amend_spec requires the next spec version and no pending amendment' };
  } else {
    receipt = { state: 'rejected', reason: `unsupported_command: ${cmd.kind}` };
  }
  return receipt;
};

// Registered before the first await, so a command or query that arrives while the task is still
// being loaded is held until initialization instead of being refused.
export function registerHandlers(launch: LaunchPayload, commandsV1: boolean, control: RunControl, getState: () => Checkpoint | undefined): void {
  setHandler(stateQuery, () => { const st = getState(); return st ? viewOf(st) : { status: 'accepted', controlRevision: 0, specVersion: launch.specVersion, planVersion: 0, projectionSequence: 0, nodes: {}, supersededResults: 0, receiptCount: 0 }; });
  // Decides one command and records its receipt. `fresh` is false when the receipt already existed.
  const decide = async (st: Checkpoint, cmd: CommandPayload): Promise<{ receipt: Receipt; fresh: boolean }> => {
    const prior = st.receipts[cmd.commandId];
    if (prior) return { receipt: prior, fresh: false }; // durable receipt lookup: a redelivered command is never applied twice
    // authority-v1: the API authorized the principal at ingress; authority can be lost before the
    // command is applied, so it is checked again here. A refused response leaves its decision
    // pending. The specific reason is in the audit trail; the receipt says only authority_revoked.
    if (control.authorityV1 && needsAuthorityRecheck(cmd) && !TERMINAL.includes(st.status) && cmd.expectedRevision === st.controlRevision) {
      let authority: { ok: true } | { ok: false; reason: string };
      try {
        authority = await persist.checkCommandAuthority({ orgId: launch.orgId, taskId: launch.taskId, commandId: cmd.commandId, ...(st.pendingBudgetMicroUsd === undefined ? {} : { pendingBudgetMicroUsd: st.pendingBudgetMicroUsd }) });
      } catch (e) {
        if (!(e instanceof ActivityFailure)) throw e;
        // The check could not be made (its retries are exhausted): refuse, never treat as authorized.
        const unavailable: Receipt = { state: 'rejected', reason: 'authority_check_unavailable' };
        st.receipts[cmd.commandId] = unavailable;
        return { receipt: unavailable, fresh: true };
      }
      if (!authority.ok) {
        const refused: Receipt = { state: 'rejected', reason: 'authority_revoked' };
        st.receipts[cmd.commandId] = refused;
        return { receipt: refused, fresh: true };
      }
    }
    const receipt = decideReceipt(st, cmd, commandsV1, control);
    st.receipts[cmd.commandId] = receipt;
    return { receipt, fresh: true };
  };
  setHandler(applyCommand, async (cmd: CommandPayload): Promise<Receipt> => {
    await condition(() => getState() !== undefined);
    const st = getState();
    if (!st) return { state: 'rejected', reason: 'task not initialized' };
    let outcome: { receipt: Receipt; fresh: boolean };
    if (control.authorityV1) {
      // authority-v1: the check above awaits an Activity, so commands are decided one at a time in
      // arrival order; a later command can never overtake an earlier one whose check is slower.
      const previous = control.commandChain;
      let release: () => void = () => undefined;
      control.commandChain = new Promise<void>((r) => { release = r; });
      await previous;
      try { outcome = await decide(st, cmd); } finally { release(); }
    } else {
      outcome = await decide(st, cmd);
    }
    const { receipt, fresh } = outcome;
    if (fresh && control.resilienceV1 && receipt.state === 'applied' && control.inflight !== undefined && control.projectInFlight) await control.projectInFlight();
    return receipt;
  }, { validator: (cmd: CommandPayload) => { if (typeof cmd.commandId !== 'string' || typeof cmd.kind !== 'string' || typeof cmd.expectedRevision !== 'number') throw new Error('malformed command'); } });
}
