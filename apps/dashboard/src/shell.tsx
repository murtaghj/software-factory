// The single pane's frame and its simpler pages. These are pure views: given data, they render.
// Loading, polling and sign-in live in app.tsx.
import type { DecisionView, PlanSectionId, TaskView } from '@factory/contracts';
import type { InboxItem, Me } from '@factory/client';
import { useEffect, useRef, type ReactNode } from 'react';
import { askOf, fullTime, label, relativeTime, shortName, timeLeft, usd } from './format.ts';
import { TaskLine } from './line.tsx';
import { NAV, href, type Route } from './routes.ts';
import type { PipelineStep } from './view-model.ts';

export type AllowanceData = { enrolled: boolean; periodEnd?: string; limitMicroUsd?: number; reservedMicroUsd?: number; chargedMicroUsd?: number; remainingMicroUsd?: number };
// The allowance is "low" at the same point the queue says so: ten percent or less left.
const LOW_PERCENT = 10;
const share = (part: number | undefined, whole: number | undefined): number => ((whole ?? 0) > 0 ? Math.max(0, Math.min(100, Math.round(((part ?? 0) / (whole ?? 1)) * 100))) : 0);

// A fuel gauge: what is left of this month's allowance. It goes amber when it is low.
function Fuel({ allowance }: { allowance: AllowanceData }) {
  if (!allowance.enrolled) return null;
  const left = share(allowance.remainingMicroUsd, allowance.limitMicroUsd);
  return (
    <a className="fuel" href={href.budget} title="Your monthly allowance">
      <span className="tube" aria-hidden="true"><i data-low={left <= LOW_PERCENT ? 'true' : 'false'} style={{ width: `${String(left)}%` }} /></span>
      <span className="visually-hidden">{String(left)}% of your allowance is left. </span>
      <span><strong>{usd(allowance.remainingMicroUsd)}</strong><span className="of"> of {usd(allowance.limitMicroUsd)}</span> left</span>
    </a>
  );
}

// Frame: a bar across the top that always shows where you are, what waits on you and what is left of
// your allowance, with the page beneath it. On a narrow screen the links drop to a second row.
export function Shell({ me, route, inboxCount, allowance, onSignOut, children }: { me: Me; route: Route; inboxCount: number; allowance?: AllowanceData | undefined; onSignOut: () => void; children: ReactNode }) {
  return (
    <div className="shell">
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
      <header className="bar">
        <a className="brand" href={href.work}><i aria-hidden="true" />Software factory</a>
        <nav aria-label="Main">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} aria-current={n.pages.includes(route.page) ? 'page' : undefined}>
              {n.label}{n.href === href.inbox && inboxCount > 0 ? <span className="tok amber count">{inboxCount}<span className="visually-hidden"> waiting on you</span></span> : null}
            </a>
          ))}
        </nav>
        <div className="right">
          {allowance ? <Fuel allowance={allowance} /> : null}
          <span className="who" title={me.roles.map(label).join(', ')}>{shortName(me.displayName) || 'Signed in'}</span>
          <button type="button" className="plain" onClick={onSignOut}>Sign out</button>
        </div>
      </header>
      <div id="main" className="content" tabIndex={-1}>{children}</div>
    </div>
  );
}

export function SignedOut({ message, onSignIn }: { message?: string | undefined; onSignIn: () => void }) {
  return (
    <main className="signed-out" aria-labelledby="signin-title">
      <div className="signin-card console">
        <p className="brand"><i aria-hidden="true" />Software factory</p>
        <h1 id="signin-title">One place for your work</h1>
        <p className="dim">Sign in to see your work, your projects and what is waiting on you.</p>
        {message ? <p role="alert" className="note"><span className="lamp red" aria-hidden="true" />{message}</p> : null}
        <button type="button" className="key on tall wide" onClick={onSignIn}>Sign in</button>
      </div>
    </main>
  );
}

// Loading, error and empty states: a lamp and a sentence. An error that can be retried offers it.
export function Notice({ kind, children, onRetry }: { kind: 'loading' | 'error' | 'empty'; children: ReactNode; onRetry?: (() => void) | undefined }) {
  return (
    <p className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span className={kind === 'error' ? 'lamp red' : kind === 'loading' ? 'lamp run pulse' : 'lamp else'} aria-hidden="true" />{children}
      {kind === 'error' && onRetry ? <button type="button" className="key" onClick={onRetry}>Try again</button> : null}
    </p>
  );
}

export function ProjectsView({ me }: { me: Me }) {
  return (
    <main aria-labelledby="projects-title" className="page">
      <header className="page-head"><h1 id="projects-title">Projects</h1><p className="dim">Each project has a board of its tasks.</p></header>
      {me.projects.length === 0 ? <p className="empty">You have no role on any project yet. Ask a project owner or an organization admin.</p> : (
        <ul className="rows projects" aria-label="Projects">{me.projects.map((p) => <li key={p.applicationId}><a href={href.project(p.applicationId)}><span className="name">{p.name}</span><span className="go">Open board</span></a></li>)}</ul>
      )}
    </main>
  );
}

export function BudgetView({ allowance, now = Date.now() }: { allowance: AllowanceData; now?: number }) {
  const spent = share(allowance.chargedMicroUsd, allowance.limitMicroUsd);
  const reserved = share(allowance.reservedMicroUsd, allowance.limitMicroUsd);
  const used = Math.min(100, spent + reserved);
  return (
    <main aria-labelledby="budget-title" className="page">
      <header className="page-head"><h1 id="budget-title">Budget</h1><p className="dim">Your monthly allowance. Tasks you create draw on it as they run.</p></header>
      {allowance.enrolled ? (
        <section className="console budget">
          <p className="headline"><strong>{usd(allowance.remainingMicroUsd)}</strong> left of {usd(allowance.limitMicroUsd)}</p>
          <div className="meter" role="img" aria-label={`${String(used)}% of your allowance is used or reserved`}>
            <span className="meter-spent" style={{ width: `${String(spent)}%` }} />
            <span className="meter-reserved" style={{ width: `${String(reserved)}%` }} />
          </div>
          <ul className="legend">
            <li><span className="swatch swatch-spent" aria-hidden="true" />Spent <strong>{usd(allowance.chargedMicroUsd)}</strong></li>
            <li><span className="swatch swatch-reserved" aria-hidden="true" />Reserved by running work <strong>{usd(allowance.reservedMicroUsd)}</strong></li>
            {allowance.periodEnd ? <li className="dim">Resets <time dateTime={allowance.periodEnd} title={fullTime(allowance.periodEnd)}>{relativeTime(allowance.periodEnd, now)}</time></li> : null}
          </ul>
          {allowance.remainingMicroUsd === 0 ? <p className="note" role="alert"><span className="lamp red" aria-hidden="true" />Your allowance is used up. Running tasks stop at their next stage and new tasks are refused until it is raised or the period ends.</p> : null}
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
    <form className="console task-actions" aria-label="Task actions" onSubmit={(e) => { e.preventDefault(); }}>
      <h2>Control this task</h2>
      <label className="field">Reason<small>Recorded with the action. Required.</small><input type="text" name="reason" value={reason} onChange={(e) => { onReason(e.target.value); }} placeholder="Why are you pausing or cancelling…" autoComplete="off" /></label>
      <div className="actions">
        {task.status === 'paused' ? <button type="button" className="key" disabled={blocked} onClick={() => { onCommand('resume'); }}>Resume</button> : <button type="button" className="key" disabled={blocked} onClick={() => { onCommand('pause'); }}>Pause</button>}
        <button type="button" className="key refuse" disabled={blocked} onClick={() => { onCommand('cancel'); }}>Cancel task</button>
      </div>
      {note ? <p className="note" role="status">{note}</p> : null}
    </form>
  );
}

export type ReviewState = { reviewed: PlanSectionId[]; reason: string; problems: string[]; sending: boolean; sent?: string | undefined };
export type ReviewContext = { project?: string | undefined; askedBy?: string | undefined; steps?: PipelineStep[] | undefined };

// Reviewing and answering one decision. Sections are ticked by the reviewer, never pre-ticked;
// the approve button stays available so the reason for a refusal is shown rather than hidden.
export function DecisionReview({ decision, item, taskTitle, packetUrl, context = {}, state, now = Date.now(), onToggle, onReason, onAnswer }: {
  decision: DecisionView; item: InboxItem | undefined; taskTitle: string; packetUrl?: string | undefined; context?: ReviewContext; state: ReviewState; now?: number;
  onToggle: (section: PlanSectionId) => void; onReason: (reason: string) => void; onAnswer: (outcome: 'approve' | 'request_changes' | 'reject') => void;
}) {
  const total = item?.sectionsToReview.length ?? 0;
  const read = state.reviewed.length;
  const asked = askOf(decision.action).toLowerCase();
  const left = Date.parse(decision.expiresAt) - now;
  const ready = total === 0 || read >= total;
  // On a refusal the first problem takes focus, so a keyboard or screen reader user lands on the reason.
  const firstProblem = useRef<HTMLLIElement>(null);
  useEffect(() => { if (state.problems.length > 0) firstProblem.current?.focus(); }, [state.problems]);
  return (
    <main aria-labelledby="decision-title" className="page decision-page">
      <header className="review-top">
        <div>
          <a className="crumb" href={href.inbox}>Back to inbox</a>
          <h1 id="decision-title">{taskTitle || item?.label || label(decision.action)}</h1>
          <p className="dim">
            {context.askedBy ? `${shortName(context.askedBy)} asked you to ${asked}` : `You were asked to ${asked}`}{context.project ? ` for ${context.project}` : ''}.{' '}
            {left > 0 ? <><strong><time dateTime={decision.expiresAt} title={fullTime(decision.expiresAt)}>{timeLeft(decision.expiresAt, now)}</time></strong> before the request expires.</> : <strong>The request has expired.</strong>}
          </p>
        </div>
        {packetUrl ? <a className="key tall" href={packetUrl} target="_blank" rel="noreferrer">Open the plan in a new tab</a> : null}
      </header>
      {context.steps && context.steps.length > 0 ? <section className="console line-panel" aria-label="Where this task is"><TaskLine steps={context.steps} holder="you" /></section> : null}
      {state.sent ? <p className="note" role="status"><span className="lamp green" aria-hidden="true" />{state.sent}</p> : !item ? <p className="empty">This decision is {label(decision.state).toLowerCase()}; there is nothing to answer.</p> : (
        <form className="cols" onSubmit={(e) => { e.preventDefault(); }}>
          {total > 0 ? (
            <fieldset className="console sections">
              <legend><h2>Sections of the plan</h2></legend>
              <p className="hint">Mark each one as you read it. Approval needs all {total}.</p>
              <div className="secs" style={{ '--rows': Math.ceil(total / 2) } as React.CSSProperties}>
                {item.sectionsToReview.map((s, i) => (
                  <label key={s} className="sec" data-read={state.reviewed.includes(s) ? 'true' : 'false'}>
                    <span className="n" aria-hidden="true">{i + 1}</span><span className="name">{label(s)}</span>
                    <input type="checkbox" className="visually-hidden" checked={state.reviewed.includes(s)} onChange={() => { onToggle(s); }} />
                    <span className="lampbox" aria-hidden="true"><i>&#10003;</i></span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : <div className="console"><p className="dim">This request has no plan sections to read.</p></div>}
          <aside className="console verdict" aria-label="Your decision">
            {total > 0 ? <>
              <p className="count" id="read-count" role="status" aria-live="polite">{read} of {total} read</p>
              <div className="dots" aria-hidden="true" style={{ '--total': total } as React.CSSProperties}>{item.sectionsToReview.map((s) => <i key={s} className={state.reviewed.includes(s) ? 'on' : undefined} />)}</div>
            </> : null}
            <label className="field">Your reason<small>Recorded with your decision.</small><textarea name="reason" value={state.reason} onChange={(e) => { onReason(e.target.value); }} rows={4} required autoComplete="off" placeholder="What did you check, or what has to change…" /></label>
            {state.problems.length > 0 ? <ul role="alert" className="problems">{state.problems.map((p, i) => <li key={p} ref={i === 0 ? firstProblem : undefined} tabIndex={-1}><span className="lamp red" aria-hidden="true" />{p}</li>)}</ul> : null}
            <div className="acts">
              {/* Lit only when every section is read; until then it is an ordinary key. The server still refuses, and the reason shows in place. */}
              <button type="button" className={ready ? 'key on tall' : 'key tall'} aria-describedby={total > 0 ? 'read-count' : undefined} disabled={state.sending} onClick={() => { onAnswer('approve'); }}>{item.label}</button>
              <button type="button" className="key tall" disabled={state.sending} onClick={() => { onAnswer('request_changes'); }}>Request changes</button>
              <button type="button" className="key refuse tall" disabled={state.sending} onClick={() => { onAnswer('reject'); }}>{item.action === 'approve_plan' ? 'Reject plan' : 'Reject'}</button>
            </div>
          </aside>
        </form>
      )}
    </main>
  );
}
