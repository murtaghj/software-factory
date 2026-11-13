// The single pane's frame and its simpler pages. These are pure views: given data, they render.
// Loading, polling and sign-in live in app.tsx.
import type { DecisionView, PlanSectionId, TaskView } from '@factory/contracts';
import type { InboxItem, Me } from '@factory/client';
import type { ReactNode } from 'react';
import { NAV, href, type Route } from './routes.ts';

export function Shell({ me, route, inboxCount, onSignOut, children }: { me: Me; route: Route; inboxCount: number; onSignOut: () => void; children: ReactNode }) {
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <span className="brand">Software factory</span>
        <nav aria-label="Main">
          <ul>
            {NAV.map((n) => (
              <li key={n.href}>
                <a href={n.href} aria-current={n.pages.includes(route.page) ? 'page' : undefined}>
                  {n.label}{n.href === href.inbox && inboxCount > 0 ? <span className="count" aria-label={`${String(inboxCount)} waiting on you`}>{inboxCount}</span> : null}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="who">
          <span>{me.displayName || 'Signed in'}</span>
          <button type="button" onClick={onSignOut}>Sign out</button>
        </div>
      </header>
      <div id="main" className="content" tabIndex={-1}>{children}</div>
    </div>
  );
}

export function SignedOut({ message, onSignIn }: { message?: string | undefined; onSignIn: () => void }) {
  return (
    <main className="signed-out" aria-labelledby="signin-title">
      <h1 id="signin-title">Software factory</h1>
      <p>Sign in to see your work, your projects and what is waiting on you.</p>
      {message ? <p role="alert">{message}</p> : null}
      <button type="button" className="primary" onClick={onSignIn}>Sign in</button>
    </main>
  );
}

export function Notice({ kind, children }: { kind: 'loading' | 'error' | 'empty'; children: ReactNode }) {
  return <p className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</p>;
}

export function ProjectsView({ me }: { me: Me }) {
  return (
    <main aria-labelledby="projects-title">
      <h1 id="projects-title">Projects</h1>
      {me.projects.length === 0 ? <Notice kind="empty">You have no role on any project yet. Ask a project owner or an organization admin.</Notice> : (
        <ul className="projects">{me.projects.map((p) => <li key={p.applicationId}><a href={href.project(p.applicationId)}>{p.name}</a></li>)}</ul>
      )}
    </main>
  );
}

export type AllowanceData = { enrolled: boolean; periodEnd?: string; limitMicroUsd?: number; reservedMicroUsd?: number; chargedMicroUsd?: number; remainingMicroUsd?: number };
const usd = (micro: number | undefined): string => `$${((micro ?? 0) / 1_000_000).toFixed(2)}`;
export function BudgetView({ allowance }: { allowance: AllowanceData }) {
  return (
    <main aria-labelledby="budget-title">
      <h1 id="budget-title">Budget</h1>
      {allowance.enrolled ? (
        <>
          <p className="headline"><strong>{usd(allowance.remainingMicroUsd)}</strong> left of {usd(allowance.limitMicroUsd)} until {allowance.periodEnd}</p>
          <dl>
            <dt>Spent</dt><dd>{usd(allowance.chargedMicroUsd)}</dd>
            <dt>Reserved by running work</dt><dd>{usd(allowance.reservedMicroUsd)}</dd>
          </dl>
          {allowance.remainingMicroUsd === 0 ? <Notice kind="error">Your allowance is used up. Running tasks stop at their next stage and new tasks are refused until it is raised or the period ends.</Notice> : null}
        </>
      ) : <p>No monthly allowance is set for you. Each task is limited by its own budget.</p>}
    </main>
  );
}

// Pause, resume and cancel go through the same commands as everywhere else. Which are offered
// follows the task's status; the workflow still decides.
export function TaskActions({ task, busy, reason, onReason, onCommand }: { task: TaskView; busy: boolean; reason: string; onReason: (reason: string) => void; onCommand: (kind: 'pause' | 'resume' | 'cancel') => void }) {
  const terminal = ['succeeded', 'incomplete', 'failed', 'cancelled'].includes(task.status);
  if (terminal) return null;
  const blocked = busy || reason.trim().length === 0 || task.status === 'cancelling';
  return (
    <form className="task-actions" aria-label="Task actions" onSubmit={(e) => { e.preventDefault(); }}>
      <label className="field">Reason (required to pause, resume or cancel)<input type="text" value={reason} onChange={(e) => { onReason(e.target.value); }} /></label>
      <div className="actions">
        {task.status === 'paused' ? <button type="button" disabled={blocked} onClick={() => { onCommand('resume'); }}>Resume</button> : <button type="button" disabled={blocked} onClick={() => { onCommand('pause'); }}>Pause</button>}
        <button type="button" className="danger" disabled={blocked} onClick={() => { onCommand('cancel'); }}>Cancel task</button>
      </div>
    </form>
  );
}

export type ReviewState = { reviewed: PlanSectionId[]; reason: string; problems: string[]; sending: boolean; sent?: string | undefined };
// Reviewing and answering one decision. Sections are ticked by the reviewer, never pre-ticked;
// the approve button stays available so the reason for a refusal is shown rather than hidden.
export function DecisionReview({ decision, item, taskTitle, packetUrl, state, onToggle, onReason, onAnswer }: {
  decision: DecisionView; item: InboxItem | undefined; taskTitle: string; packetUrl?: string | undefined; state: ReviewState;
  onToggle: (section: PlanSectionId) => void; onReason: (reason: string) => void; onAnswer: (outcome: 'approve' | 'request_changes' | 'reject') => void;
}) {
  return (
    <main aria-labelledby="decision-title">
      <h1 id="decision-title">{item?.label ?? decision.action.replace(/_/g, ' ')}</h1>
      <p>For <a href={href.task(decision.taskId)}>{taskTitle || 'this task'}</a> · expires <time dateTime={decision.expiresAt}>{decision.expiresAt}</time></p>
      <p>{decision.reason}</p>
      {packetUrl ? <p><a href={packetUrl} rel="noreferrer">Open the plan you are approving</a></p> : null}
      {state.sent ? <Notice kind="empty">{state.sent}</Notice> : !item ? <Notice kind="empty">This decision is {decision.state.replace(/_/g, ' ')}; there is nothing to answer.</Notice> : (
        <form onSubmit={(e) => { e.preventDefault(); }}>
          {item.sectionsToReview.length > 0 ? (
            <fieldset>
              <legend>Sections you have reviewed</legend>
              {item.sectionsToReview.map((s) => (
                <label key={s}><input type="checkbox" checked={state.reviewed.includes(s)} onChange={() => { onToggle(s); }} /> {s.replace(/_/g, ' ')}</label>
              ))}
            </fieldset>
          ) : null}
          <label className="field">Reason<textarea value={state.reason} onChange={(e) => { onReason(e.target.value); }} rows={3} required /></label>
          {state.problems.length > 0 ? <ul role="alert" className="problems">{state.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
          <div className="actions">
            <button type="button" className="primary" disabled={state.sending} onClick={() => { onAnswer('approve'); }}>Approve</button>
            <button type="button" disabled={state.sending} onClick={() => { onAnswer('request_changes'); }}>Request changes</button>
            <button type="button" className="danger" disabled={state.sending} onClick={() => { onAnswer('reject'); }}>Reject</button>
          </div>
        </form>
      )}
    </main>
  );
}
