// The single pane's frame and its simpler pages. These are pure views: given data, they render.
// Loading, polling and sign-in live in app.tsx.
import type { DecisionView, PlanSectionId, TaskView } from '@factory/contracts';
import type { InboxItem, Me } from '@factory/client';
import type { ReactNode } from 'react';
import { Avatar } from './components.tsx';
import { fullTime, label, relativeTime, shortName, usd } from './format.ts';
import { NAV, href, type Route } from './routes.ts';

// Frame: a sidebar that always shows where you are, what waits on you and your projects, with the
// page beside it. On a narrow screen the sidebar becomes a top bar.
export function Shell({ me, route, inboxCount, onSignOut, children }: { me: Me; route: Route; inboxCount: number; onSignOut: () => void; children: ReactNode }) {
  const openProject = route.page === 'project' ? route.applicationId : undefined;
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <aside className="side">
        <a className="brand" href={href.work}><span className="brand-mark" aria-hidden="true">◆</span>Software factory</a>
        <nav aria-label="Main">
          <ul>
            {NAV.filter((n) => n.href !== href.projects).map((n) => (
              <li key={n.href}>
                <a href={n.href} aria-current={n.pages.includes(route.page) ? 'page' : undefined}>
                  <span>{n.label}</span>{n.href === href.inbox && inboxCount > 0 ? <span className="count" aria-label={`${String(inboxCount)} waiting on you`}>{inboxCount}</span> : null}
                </a>
              </li>
            ))}
          </ul>
          <p className="side-heading"><a href={href.projects} aria-current={route.page === 'projects' ? 'page' : undefined}>Projects</a></p>
          <ul className="side-projects">
            {me.projects.map((p) => <li key={p.applicationId}><a href={href.project(p.applicationId)} aria-current={openProject === p.applicationId ? 'page' : undefined}><span className="project-dot" aria-hidden="true" />{p.name}</a></li>)}
            {me.projects.length === 0 ? <li className="muted side-none">None yet</li> : null}
          </ul>
        </nav>
        <div className="who">
          <Avatar name={me.displayName || '?'} size="md" />
          <div className="who-name"><strong>{shortName(me.displayName) || 'Signed in'}</strong><span className="muted">{me.roles.map(label).join(', ')}</span></div>
          <button type="button" className="quiet" onClick={onSignOut}>Sign out</button>
        </div>
      </aside>
      <div id="main" className="content" tabIndex={-1}>{children}</div>
    </div>
  );
}

export function SignedOut({ message, onSignIn }: { message?: string | undefined; onSignIn: () => void }) {
  return (
    <main className="signed-out" aria-labelledby="signin-title">
      <div className="signin-card">
        <p className="brand"><span className="brand-mark" aria-hidden="true">◆</span>Software factory</p>
        <h1 id="signin-title">One place for your work</h1>
        <p className="muted">Sign in to see your work, your projects and what is waiting on you.</p>
        {message ? <p role="alert" className="note note-error">{message}</p> : null}
        <button type="button" className="button primary wide" onClick={onSignIn}>Sign in</button>
      </div>
    </main>
  );
}

export function Notice({ kind, children }: { kind: 'loading' | 'error' | 'empty'; children: ReactNode }) {
  return <p className={`note note-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</p>;
}

export function ProjectsView({ me }: { me: Me }) {
  return (
    <main aria-labelledby="projects-title">
      <header className="page-head"><h1 id="projects-title">Projects</h1><p className="muted">Each project has a board of its tasks.</p></header>
      {me.projects.length === 0 ? <p className="empty">You have no role on any project yet. Ask a project owner or an organization admin.</p> : (
        <ul className="project-grid">{me.projects.map((p) => <li key={p.applicationId}><a className="card project-card" href={href.project(p.applicationId)}><span className="project-dot" aria-hidden="true" /><span className="card-title">{p.name}</span><span className="muted">Open board →</span></a></li>)}</ul>
      )}
    </main>
  );
}

export type AllowanceData = { enrolled: boolean; periodEnd?: string; limitMicroUsd?: number; reservedMicroUsd?: number; chargedMicroUsd?: number; remainingMicroUsd?: number };
export function BudgetView({ allowance, now = Date.now() }: { allowance: AllowanceData; now?: number }) {
  const limit = allowance.limitMicroUsd ?? 0;
  const pct = (n: number | undefined): number => (limit > 0 ? Math.min(100, Math.round(((n ?? 0) / limit) * 100)) : 0);
  const used = pct((allowance.chargedMicroUsd ?? 0) + (allowance.reservedMicroUsd ?? 0));
  return (
    <main aria-labelledby="budget-title">
      <header className="page-head"><h1 id="budget-title">Budget</h1><p className="muted">Your monthly allowance. Tasks you create draw on it as they run.</p></header>
      {allowance.enrolled ? (
        <section className="panel">
          <p className="headline"><strong>{usd(allowance.remainingMicroUsd)}</strong> left of {usd(allowance.limitMicroUsd)}</p>
          <div className="meter" role="img" aria-label={`${String(used)}% of your allowance is used or reserved`}>
            <span className="meter-spent" style={{ width: `${String(pct(allowance.chargedMicroUsd))}%` }} />
            <span className="meter-reserved" style={{ width: `${String(pct(allowance.reservedMicroUsd))}%` }} />
          </div>
          <ul className="legend">
            <li><span className="swatch swatch-spent" aria-hidden="true" />Spent <strong>{usd(allowance.chargedMicroUsd)}</strong></li>
            <li><span className="swatch swatch-reserved" aria-hidden="true" />Reserved by running work <strong>{usd(allowance.reservedMicroUsd)}</strong></li>
            {allowance.periodEnd ? <li className="muted">Resets <time dateTime={allowance.periodEnd} title={fullTime(allowance.periodEnd)}>{relativeTime(allowance.periodEnd, now)}</time></li> : null}
          </ul>
          {allowance.remainingMicroUsd === 0 ? <p className="note note-error" role="alert">Your allowance is used up. Running tasks stop at their next stage and new tasks are refused until it is raised or the period ends.</p> : null}
        </section>
      ) : <p className="empty">No monthly allowance is set for you. Each task is limited by its own budget.</p>}
    </main>
  );
}

// Pause, resume and cancel go through the same commands as everywhere else. Which are offered
// follows the task's status; the workflow still decides.
export function TaskActions({ task, busy, reason, note, onReason, onCommand }: { task: TaskView; busy: boolean; reason: string; note?: string | undefined; onReason: (reason: string) => void; onCommand: (kind: 'pause' | 'resume' | 'cancel') => void }) {
  const terminal = ['succeeded', 'incomplete', 'failed', 'cancelled'].includes(task.status);
  if (terminal) return null;
  const blocked = busy || reason.trim().length === 0 || task.status === 'cancelling';
  return (
    <form className="panel task-actions" aria-label="Task actions" onSubmit={(e) => { e.preventDefault(); }}>
      <h2>Control this task</h2>
      <label className="field">Reason<span className="hint">Recorded with the action. Required.</span><input type="text" value={reason} onChange={(e) => { onReason(e.target.value); }} placeholder="Why are you pausing or cancelling?" /></label>
      <div className="actions">
        {task.status === 'paused' ? <button type="button" className="button" disabled={blocked} onClick={() => { onCommand('resume'); }}>Resume</button> : <button type="button" className="button" disabled={blocked} onClick={() => { onCommand('pause'); }}>Pause</button>}
        <button type="button" className="button danger" disabled={blocked} onClick={() => { onCommand('cancel'); }}>Cancel task</button>
      </div>
      {note ? <p className="note" role="status">{note}</p> : null}
    </form>
  );
}

export type ReviewState = { reviewed: PlanSectionId[]; reason: string; problems: string[]; sending: boolean; sent?: string | undefined };
// Reviewing and answering one decision. Sections are ticked by the reviewer, never pre-ticked;
// the approve button stays available so the reason for a refusal is shown rather than hidden.
export function DecisionReview({ decision, item, taskTitle, packetUrl, state, now = Date.now(), onToggle, onReason, onAnswer }: {
  decision: DecisionView; item: InboxItem | undefined; taskTitle: string; packetUrl?: string | undefined; state: ReviewState; now?: number;
  onToggle: (section: PlanSectionId) => void; onReason: (reason: string) => void; onAnswer: (outcome: 'approve' | 'request_changes' | 'reject') => void;
}) {
  const total = item?.sectionsToReview.length ?? 0;
  return (
    <main aria-labelledby="decision-title" className="decision-page">
      <header className="page-head">
        <p className="crumbs"><a href={href.inbox}>← Inbox</a></p>
        <h1 id="decision-title">{item?.label ?? label(decision.action)}</h1>
        <p className="muted">For <a href={href.task(decision.taskId)}>{taskTitle || 'this task'}</a> · expires <time dateTime={decision.expiresAt} title={fullTime(decision.expiresAt)}>{relativeTime(decision.expiresAt, now)}</time></p>
      </header>
      <section className="panel">
        <h2>What you are deciding</h2>
        <p>{decision.reason}.</p>
        {packetUrl ? <p><a className="button" href={packetUrl} target="_blank" rel="noreferrer">Open the plan ↗</a></p> : null}
      </section>
      {state.sent ? <p className="note note-success" role="status">{state.sent}</p> : !item ? <p className="empty">This decision is {label(decision.state).toLowerCase()}; there is nothing to answer.</p> : (
        <form className="panel" onSubmit={(e) => { e.preventDefault(); }}>
          {total > 0 ? (
            <fieldset>
              <legend>Sections you have reviewed <span className="count-pill">{state.reviewed.length} of {total}</span></legend>
              <p className="hint">Tick each section as you read it. Approval needs all of them.</p>
              <div className="section-grid">
                {item.sectionsToReview.map((s) => (
                  <label key={s} className="check"><input type="checkbox" checked={state.reviewed.includes(s)} onChange={() => { onToggle(s); }} /><span>{label(s)}</span></label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <label className="field">Your reason<span className="hint">Recorded with your decision.</span><textarea value={state.reason} onChange={(e) => { onReason(e.target.value); }} rows={3} required /></label>
          {state.problems.length > 0 ? <ul role="alert" className="note note-error problems">{state.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
          <div className="actions">
            <button type="button" className="button primary" disabled={state.sending} onClick={() => { onAnswer('approve'); }}>Approve</button>
            <button type="button" className="button" disabled={state.sending} onClick={() => { onAnswer('request_changes'); }}>Request changes</button>
            <button type="button" className="button danger" disabled={state.sending} onClick={() => { onAnswer('reject'); }}>Reject</button>
          </div>
        </form>
      )}
    </main>
  );
}
