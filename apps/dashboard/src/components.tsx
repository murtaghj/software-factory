// The pane's views. Pure: given data and "now", they render. No untrusted HTML — every value is
// rendered as text by React. Nothing here speaks in codes or raw timestamps: wording comes from
// format.ts, and exact times are available as tooltips and <time> values.
import { BOARD_COLUMNS, COLUMN_LABELS, DISMISS_LABEL, TRUNCATED_NOTE, actionOf, degradedNote, needLabel, queueHeadline, reasonOf, rulesText, type Board, type InboxModel, type MyWork, type Queue, type QueueItem, type TaskCard } from '@factory/client';
import type { ReactNode } from 'react';
import { fullTime, hueOf, initials, label, relativeTime, shortName, statusOf, usd, type Tone } from './format.ts';
import type { PipelineStep, TaskModel } from './view-model.ts';

export function StatusChip({ status }: { status: string }) {
  const s = statusOf(status);
  return <span className="chip" data-tone={s.tone}><span className="dot" aria-hidden="true" />{s.label}</span>;
}

export function Avatar({ name, size = 'sm' }: { name: string; size?: 'sm' | 'md' }) {
  return <span className={`avatar avatar-${size}`} style={{ '--hue': String(hueOf(name)) } as React.CSSProperties} aria-hidden="true">{initials(name)}</span>;
}
function Person({ name, prefix }: { name: string; prefix?: string }) {
  return <span className="person"><Avatar name={name} />{prefix ? `${prefix} ` : ''}{shortName(name)}</span>;
}
function When({ iso, now }: { iso: string; now: number }) {
  return <time dateTime={iso} title={fullTime(iso)}>{relativeTime(iso, now)}</time>;
}

export function FreshnessBanner({ freshness }: { freshness: TaskModel['freshness'] }) {
  return (
    <p role="status" aria-live="polite" data-stale={freshness.stale ? 'true' : 'false'} data-connection={freshness.connection} className={freshness.stale ? 'fresh fresh-stale' : 'fresh'}>
      <span className="dot" aria-hidden="true" />{freshness.message}
    </p>
  );
}

// One task, as a card. Used on the board and in "my work".
export function TaskCardView({ card, people, taskHref, now, project, showStatus = true }: { card: TaskCard; people: Record<string, string>; taskHref: (taskId: string) => string; now: number; project?: string | undefined; showStatus?: boolean }) {
  const waitingOn = card.waitingOnPrincipalId ? people[card.waitingOnPrincipalId] ?? 'someone' : undefined;
  const creator = people[card.creatorId] ?? 'Unknown';
  return (
    <article className="card" data-status={card.status}>
      <a className="card-title" href={taskHref(card.taskId)}>{card.title}</a>
      <div className="card-meta">
        {showStatus ? <StatusChip status={card.status} /> : null}
        {project ? <span className="tag">{project}</span> : null}
        {card.currentNodeId && !waitingOn && card.column !== 'done' && card.column !== 'stopped' ? <span className="muted">{label(card.currentNodeId)}</span> : null}
        {card.column === 'stopped' && card.waitingReason ? <span className="muted">{label(card.waitingReason)}</span> : null}
      </div>
      {waitingOn ? (
        <p className="card-wait"><Person name={waitingOn} prefix="Waiting on" />{card.decisionExpiresAt ? <span className="muted">expires <When iso={card.decisionExpiresAt} now={now} /></span> : null}</p>
      ) : null}
      <div className="card-foot"><Person name={creator} /><span className="muted">updated <When iso={card.updatedAt} now={now} /></span></div>
    </article>
  );
}

const NEED_TONE: Record<string, Tone> = { blocked_on_you: 'warning', running_out: 'warning', stopped: 'danger', finished: 'success' };
const NEED_FOCUS: Record<string, string> = { blocked_on_you: 'answer', running_out: 'answer', stopped: 'look', finished: 'clear' };
export type QueueLinks = { taskHref: (taskId: string) => string; decisionHref: (decisionId: string) => string; budgetHref: string };
const itemHref = (i: QueueItem, l: QueueLinks): string => (i.action.kind === 'answer_decision' ? l.decisionHref(i.action.decisionId) : i.action.kind === 'open_task' ? l.taskHref(i.action.taskId) : l.budgetHref);

// The ranked "what needs you next" list (P-24). It renders the order the server sent; it never sorts.
// The first item gets the focus treatment. No group headings: the chip says why each item is here.
export function QueueView({ queue, work, links, onDismiss, now = Date.now() }: { queue: Queue; work?: MyWork | undefined; links: QueueLinks; onDismiss?: (key: string) => void; now?: number }) {
  const people = Object.fromEntries(Object.entries(queue.people).map(([id, name]) => [id, shortName(name)]));
  const me = queue.people[queue.principalId];
  const note = degradedNote(queue);
  const other = work ? [...work.inProgress, ...work.waitingOnOthers] : [];
  const rules = rulesText(queue);
  return (
    <main aria-labelledby="work-title">
      <header className="page-head"><h1 id="work-title">{me ? `Hello, ${shortName(me)}` : 'My work'}</h1><p className="muted">What needs you next, across all your projects.</p></header>
      {queue.items.length === 0 ? (
        <section className="focus" role="status" aria-live="polite" data-focus="clear"><div><p className="eyebrow">Next</p><p className="focus-text">{queueHeadline(queue, now)}</p></div></section>
      ) : (
        <>
          {note ? <p className="note" role="status">{note}</p> : null}
          {queue.truncated ? <p className="note" role="status">{TRUNCATED_NOTE}</p> : null}
          <ol className="queue" aria-label="What needs you, most urgent first">
            {queue.items.map((item, i) => {
              const { lead, when } = reasonOf(item, { people });
              const project = item.subject.applicationId ? queue.applications[item.subject.applicationId] : undefined;
              return (
                <li key={item.key} className={i === 0 ? 'queue-item focus' : 'queue-item'} data-key={item.key} data-tier={item.tier} {...(i === 0 ? { 'data-focus': NEED_FOCUS[item.need] ?? 'clear' } : {})}>
                  <span className="queue-rank" aria-hidden="true">{item.rank}</span>
                  <div className="queue-body">
                    <div className="card-meta">
                      <span className="chip" data-tone={NEED_TONE[item.need] ?? 'neutral'}><span className="dot" aria-hidden="true" />{needLabel(item.need)}</span>
                      {project ? <span className="tag">{project}</span> : null}
                      {item.priority === 'incident' ? <span className="chip" data-tone="danger">Incident</span> : null}
                    </div>
                    <a className="card-title" href={itemHref(item, links)}>{item.subject.title || 'Untitled task'}</a>
                    <p className="queue-reason">{lead}{when ? <>, {when.kind === 'expires' ? 'expires ' : ''}<When iso={when.iso} now={now} /></> : null}</p>
                  </div>
                  <div className="queue-actions">
                    <a className="button primary" href={itemHref(item, links)}>{actionOf(item).label}</a>
                    {item.dismissible ? <button type="button" className="quiet" data-dismiss onClick={() => { onDismiss?.(item.key); }}>{DISMISS_LABEL}</button> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
      <details className="queue-rules">
        <summary>How this list is ordered</summary>
        <ol>{rules.slice(0, -1).map((r) => <li key={r}>{r}</li>)}</ol>
        <p className="muted">{rules.at(-1)}</p>
      </details>
      {other.length > 0 && work ? (
        <details className="queue-other">
          <summary>Your other work ({other.length})</summary>
          <div className="cards">{other.map((c) => <TaskCardView key={c.taskId} card={c} people={work.people} taskHref={links.taskHref} now={now} project={work.applications[c.applicationId]} />)}</div>
        </details>
      ) : null}
    </main>
  );
}

export function BoardView({ board, taskHref, now = Date.now() }: { board: Board; taskHref: (taskId: string) => string; now?: number }) {
  const active = board.columns.queued.length + board.columns.running.length + board.columns.waiting.length + board.columns.paused.length;
  return (
    <main aria-labelledby="board-title" className="board-page">
      <header className="page-head">
        <h1 id="board-title">{board.name}</h1>
        <ul className="facts">
          <li><strong>{active}</strong> active</li>
          <li data-tone={board.needsPerson.length > 0 ? 'warning' : 'neutral'}><strong>{board.needsPerson.length}</strong> waiting on a person</li>
          <li><strong>{usd(board.spentThisMonthMicroUsd)}</strong> spent this month</li>
          <li className="muted">updated <When iso={board.generatedAt} now={now} /></li>
        </ul>
      </header>
      {board.truncated ? <p className="note" role="status">This board is too large to show in full; some tasks are not listed.</p> : null}
      <div className="board" role="list" aria-label={`${board.name} board`}>
        {BOARD_COLUMNS.map((col) => (
          <section key={col} role="listitem" className="column" aria-labelledby={`board-${col}`} data-column={col} data-empty={board.columns[col].length === 0 ? 'true' : 'false'}>
            <h2 id={`board-${col}`}><span>{COLUMN_LABELS[col]}</span> <span className="count-pill">{board.columns[col].length}</span></h2>
            {board.columns[col].length === 0 ? <p className="column-empty visually-hidden">Nothing here</p> : board.columns[col].map((c) => <TaskCardView key={c.taskId} card={c} people={board.people} taskHref={taskHref} now={now} showStatus={col === 'stopped' || col === 'running'} />)}
          </section>
        ))}
      </div>
    </main>
  );
}

const STEP_WORD: Record<PipelineStep['state'], string> = { done: 'done', current: 'in progress', failed: 'did not pass', pending: 'not started' };
export function Pipeline({ steps }: { steps: PipelineStep[] }) {
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.state === 'done').length;
  return (
    <section className="panel" aria-labelledby="pipeline-title">
      <h2 id="pipeline-title">Progress <span className="muted">{done} of {steps.length} stages done</span></h2>
      <ol className="pipeline">
        {steps.map((s, i) => (
          <li key={s.id} data-state={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
            <span className="step-mark" aria-hidden="true">{s.state === 'done' ? '✓' : s.state === 'failed' ? '!' : i + 1}</span>
            <span className="step-name">{label(s.id)}</span>
            <span className="step-state">{STEP_WORD[s.state]}{s.attempts > 1 ? ` · attempt ${String(s.attempts)}` : ''}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export type TaskExtras = { steps?: PipelineStep[]; project?: string | undefined; creator?: string | undefined; waitingOn?: { name: string; expiresAt?: string | undefined; decisionHref?: string | undefined } | undefined; reason?: string | undefined; now?: number; actions?: ReactNode };
export function TaskDetail({ model, extras = {} }: { model: TaskModel; extras?: TaskExtras }) {
  const now = extras.now ?? Date.now();
  const current = model.gates.filter((g) => g.current);
  const past = model.gates.filter((g) => !g.current);
  const history = model.stages.filter((s) => s.superseded || s.attempt > 1);
  return (
    <main aria-labelledby="task-title" className="task-page">
      <header className="page-head">
        <p className="crumbs">{extras.project ? <span className="tag">{extras.project}</span> : null}{extras.creator ? <Person name={extras.creator} prefix="by" /> : null}</p>
        <h1 id="task-title">{model.title}</h1>
        <p className="status-line"><span className="visually-hidden">Status: {model.status.value}</span><StatusChip status={model.status.value} />{model.currentNode && model.status.tone !== 'success' ? <span className="muted">at {label(model.currentNode)}</span> : null}</p>
        <FreshnessBanner freshness={model.freshness} />
      </header>
      {extras.waitingOn ? (
        <section className="callout" data-tone="waiting">
          <p className="callout-line"><Avatar name={extras.waitingOn.name} size="md" /><span><strong>Waiting on {shortName(extras.waitingOn.name)}</strong> to review the plan.{extras.waitingOn.expiresAt ? <span className="muted"> The request expires <When iso={extras.waitingOn.expiresAt} now={now} />.</span> : null}</span></p>
          {extras.waitingOn.decisionHref ? <a className="button primary" href={extras.waitingOn.decisionHref}>Review now</a> : null}
        </section>
      ) : null}
      {extras.reason ? <section className="callout" data-tone="warning"><p><strong>{label(extras.reason)}.</strong> This task stopped before finishing; nothing was delivered.</p></section> : null}
      {extras.steps ? <Pipeline steps={extras.steps} /> : null}
      <section className="panel" aria-labelledby="gates-title">
        <h2 id="gates-title">Checks</h2>
        {current.length === 0 ? <p className="muted">No checks have run yet.</p> : (
          <ul className="checks" aria-label="Gates">
            {current.map((g, i) => (
              <li key={`${g.gateId}-${String(i)}`} data-verdict={g.verdict}>
                <span className="check-mark" aria-hidden="true">{g.verdict === 'passed' ? '✓' : g.verdict === 'failed' ? '✕' : '?'}</span>
                <span><strong>{label(g.gateId)}</strong> <span className="visually-hidden">{g.gateId} {g.verdict}</span><span className="muted">{g.reasonCodes.map(label).join(' · ')}</span></span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {extras.actions}
      {history.length + past.length > 0 ? (
        <details className="panel">
          <summary>History: earlier attempts and superseded work ({history.length + past.length})</summary>
          {past.length > 0 ? (
            <ul className="checks" aria-label="Superseded checks">
              {past.map((g, i) => <li key={`${g.gateId}-${String(i)}`} data-verdict="superseded"><span className="check-mark" aria-hidden="true">–</span><span><strong>{label(g.gateId)}</strong><span className="muted">{label(g.verdict)} earlier — superseded, no longer applies</span></span></li>)}
            </ul>
          ) : null}
          {history.length > 0 ? (
          <table aria-label="Stages">
            <thead><tr><th scope="col">Stage</th><th scope="col">Plan</th><th scope="col">Attempt</th><th scope="col">Result</th></tr></thead>
            <tbody>{history.map((s) => <tr key={s.logicalId} data-superseded={s.superseded ? 'true' : 'false'}><td>{label(s.nodeId)}</td><td>{s.planVersion}</td><td>{s.attempt}</td><td>{s.superseded ? `${label(s.status)} (superseded)` : label(s.status)}</td></tr>)}</tbody>
          </table>
          ) : null}
        </details>
      ) : null}
    </main>
  );
}

// Decision inbox: one card per item waiting on the signed-in person, soonest expiry first. An
// expired item offers no way to answer.
export type InboxContext = Record<string, { title: string; project?: string | undefined; askedBy?: string | undefined }>;
export function DecisionInbox({ model, taskHref, decisionHref, context = {}, now = Date.now() }: { model: InboxModel; taskHref: (taskId: string) => string; decisionHref: (decisionId: string) => string; context?: InboxContext; now?: number }) {
  return (
    <main aria-labelledby="inbox-title">
      <header className="page-head"><h1 id="inbox-title">Inbox</h1><p role="status" aria-live="polite" className="muted">{model.summary}</p></header>
      {model.items.length === 0 ? <p className="empty">You're all caught up. Requests for your review will appear here.</p> : (
        <ul className="inbox" aria-label="Decisions waiting on you">
          {model.items.map((i) => (
            <li key={i.id} className="card inbox-item" data-urgency={i.urgency}>
              <div>
                <p className="eyebrow">{i.label}</p>
                <p className="card-title">{context[i.taskId]?.title ?? i.reason}</p>
                {context[i.taskId] ? <p className="muted">{i.reason}</p> : null}
                <p className="card-meta">
                  {context[i.taskId]?.project ? <span className="tag">{context[i.taskId]?.project}</span> : null}
                  {context[i.taskId]?.askedBy ? <Person name={context[i.taskId]?.askedBy ?? ''} prefix="asked by" /> : null}
                  <span className="chip" data-tone={i.urgency === 'normal' ? 'neutral' : 'warning'}><span className="dot" aria-hidden="true" />{i.urgency === 'expired' ? 'Expired' : <>Expires <When iso={i.expiresAt} now={now} /></>}</span>
                  <a href={taskHref(i.taskId)}>Open task</a>
                </p>
              </div>
              {i.urgency === 'expired' ? <span className="muted">No longer answerable</span> : <a className="button primary" href={decisionHref(i.id)}>Review</a>}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
