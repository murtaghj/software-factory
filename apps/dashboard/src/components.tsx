// The pane's views. Pure: given data and "now", they render. No untrusted HTML — every value is
// rendered as text by React. Nothing here speaks in codes or raw timestamps: wording comes from
// format.ts and @factory/client, and exact times are available as tooltips and <time> values.
import { BOARD_COLUMNS, COLUMN_LABELS, DISMISS_LABEL, TRUNCATED_NOTE, actionOf, degradedNote, needLabel, queueHeadline, reasonOf, rulesText, type Board, type InboxModel, type MyWork, type Queue, type QueueItem, type TaskCard } from '@factory/client';
import type { ReactNode } from 'react';
import { askOf, fullTime, label, relativeTime, shortName, statusOf, timeLeft, usd } from './format.ts';
import { LineLegend, MiniLine, TaskLine, Tok, WorkLine, type Lamp, type LampKind } from './line.tsx';
import type { TaskModel, PipelineStep } from './view-model.ts';

function When({ iso, now }: { iso: string; now: number }) {
  return <time dateTime={iso} title={fullTime(iso)}>{relativeTime(iso, now)}</time>;
}
function Left({ iso, now }: { iso: string; now: number }) {
  return <time dateTime={iso} title={fullTime(iso)}>{timeLeft(iso, now)}</time>;
}

export function FreshnessBanner({ freshness }: { freshness: TaskModel['freshness'] }) {
  return (
    <p role="status" aria-live="polite" data-stale={freshness.stale ? 'true' : 'false'} data-connection={freshness.connection} className={freshness.stale ? 'fresh fresh-stale' : 'fresh'}>
      <span className={freshness.stale ? 'lamp else' : 'lamp'} aria-hidden="true" />{freshness.message}
    </p>
  );
}

const STATUS_LAMP: Record<string, LampKind> = { running: 'run', succeeded: 'green', incomplete: 'red', failed: 'red' };
const lampOfStatus = (status: string): LampKind => STATUS_LAMP[status] ?? 'else';

// One task on a board. The mini line says where it is; a waiting or stopped task says why, in words.
function BoardCard({ card, people, stations, taskHref, now }: { card: TaskCard; people: Record<string, string>; stations: Board['stations']; taskHref: (taskId: string) => string; now: number }) {
  const waitingOn = card.waitingOnPrincipalId ? people[card.waitingOnPrincipalId] ?? 'someone' : undefined;
  const creator = people[card.creatorId] ?? 'Unknown';
  const stopped = card.column === 'stopped';
  const done = card.column === 'done';
  const at = card.stage?.label ?? (card.currentNodeId ? label(card.currentNodeId) : '');
  return (
    <article className="card" data-status={card.status}>
      <a className="card-title" href={taskHref(card.taskId)}>{card.title}</a>
      <p className="card-stage">
        <MiniLine stations={stations} stage={card.stage} finished={done} tone={stopped ? 'stopped' : undefined} />
        <span>{done ? 'Done' : stopped ? (at ? `Stopped at ${at}` : 'Stopped') : at || statusOf(card.status).label}</span>
      </p>
      {stopped && card.waitingReason ? <p className="card-wait"><Tok kind="red" words="Stopped" />{label(card.waitingReason)}</p> : null}
      {waitingOn ? (
        <p className="card-wait"><Tok kind="else" />Waiting on {shortName(waitingOn)}{card.decisionExpiresAt ? <span className="dim"> · <Left iso={card.decisionExpiresAt} now={now} /></span> : null}</p>
      ) : null}
      <p className="card-foot">{shortName(creator)}<span>updated <When iso={card.updatedAt} now={now} /></span></p>
    </article>
  );
}

export type QueueLinks = { taskHref: (taskId: string) => string; decisionHref: (decisionId: string) => string; budgetHref: string };
const itemHref = (i: QueueItem, l: QueueLinks): string => (i.action.kind === 'answer_decision' ? l.decisionHref(i.action.decisionId) : i.action.kind === 'open_task' ? l.taskHref(i.action.taskId) : l.budgetHref);
// Held by you, stopped, finished: the three lamps a numbered row can have.
const LAMP_OF_NEED: Record<string, LampKind> = { blocked_on_you: 'amber', running_out: 'amber', stopped: 'red', finished: 'green' };
// Amber is "held by you" and nothing else: a review request you made, waiting on someone, is a hollow lamp.
const lampOf = (i: QueueItem): LampKind => (i.reason.code === 'review_expiring' ? 'else' : LAMP_OF_NEED[i.need] ?? 'amber');
const NEED_FOCUS: Record<string, string> = { blocked_on_you: 'answer', running_out: 'answer', stopped: 'look', finished: 'clear' };

// What a task that is not asking anything of you is doing, in a sentence, and the time that goes with it.
function otherLine(c: TaskCard, people: Record<string, string>, now: number): { kind: LampKind; why: string; when: ReactNode } {
  if (c.waitingOnPrincipalId) {
    const name = shortName(people[c.waitingOnPrincipalId] ?? 'someone');
    return { kind: 'else', why: `Waiting on ${name} to review the plan`, when: c.decisionExpiresAt ? <Left iso={c.decisionExpiresAt} now={now} /> : null };
  }
  const updated = <>updated <When iso={c.updatedAt} now={now} /></>;
  if (c.column === 'paused') return { kind: 'else', why: 'Paused', when: updated };
  if (c.column === 'queued') return { kind: 'else', why: 'Waiting to start', when: updated };
  if (c.column === 'running') return { kind: 'run', why: `An agent is running ${c.stage?.label ?? (c.currentNodeId ? label(c.currentNodeId) : 'this task')}`, when: updated };
  return { kind: 'else', why: statusOf(c.status).label, when: updated };
}

// The ranked "what needs you next" list (P-24) under the line that shows where all your work is held.
// It renders the order the server sent; it never sorts. The first row is raised.
export function QueueView({ queue, work, links, onDismiss, now = Date.now() }: { queue: Queue; work?: MyWork | undefined; links: QueueLinks; onDismiss?: (key: string) => void; now?: number }) {
  const people = Object.fromEntries(Object.entries(queue.people).map(([id, name]) => [id, shortName(name)]));
  const note = degradedNote(queue);
  const other = work ? [...work.inProgress, ...work.waitingOnOthers] : [];
  const rules = rulesText(queue);
  const lamps: Record<string, Lamp[]> = {};
  const put = (nodeId: string, l: Lamp): void => { (lamps[nodeId] ??= []).push(l); };
  for (const i of queue.items) if (i.stage) put(i.stage.nodeId, { key: i.key, kind: lampOf(i), n: i.rank, words: needLabel(i.need), title: i.subject.title });
  const others = work ? other.map((c) => ({ card: c, ...otherLine(c, work.people, now) })) : [];
  for (const o of others) if (o.card.stage) put(o.card.stage.nodeId, { key: `other:${o.card.taskId}`, kind: o.kind, title: o.card.title });
  return (
    <main aria-labelledby="work-title" className="work-page">
      <h1 id="work-title" className="visually-hidden">My work</h1>
      <section className="band line-band" aria-labelledby="line-title">
        <div className="linehead">
          <h2 id="line-title">Where your work is held</h2>
          <LineLegend kinds={['amber', 'red', 'green', 'else', 'run']} />
        </div>
        <WorkLine stations={queue.stations} lamps={lamps} label="Stages, with your tasks at the stage they have reached" />
      </section>
      <section className="band table-band">
        {note ? <p className="note" role="status"><span className="lamp" aria-hidden="true" />{note}</p> : null}
        {queue.truncated && queue.items.length > 0 ? <p className="note" role="status"><span className="lamp" aria-hidden="true" />{TRUNCATED_NOTE}</p> : null}
        {queue.items.length === 0 ? (
          <p className="empty" role="status" aria-live="polite" data-focus="clear">{queueHeadline(queue, now)}</p>
        ) : (
          <table aria-label="What needs you, most urgent first">
            <colgroup><col className="c-num" /><col /><col className="c-why" /><col className="c-proj" /><col className="c-when" /><col className="c-act" /></colgroup>
            <thead><tr><th scope="col"><span className="visually-hidden">Rank</span></th><th scope="col">Task</th><th scope="col">Why it is here</th><th scope="col">Project</th><th scope="col" className="when">When</th><th scope="col"><span className="visually-hidden">Action</span></th></tr></thead>
            <tbody>
              {queue.items.map((item, i) => {
                const { lead, when } = reasonOf(item, { people });
                const project = item.subject.applicationId ? queue.applications[item.subject.applicationId] : undefined;
                const href = itemHref(item, links);
                return (
                  <tr key={item.key} className={i === 0 ? 'first' : undefined} data-key={item.key} data-tier={item.tier} {...(i === 0 ? { 'data-focus': NEED_FOCUS[item.need] ?? 'clear' } : {})}>
                    <td className="num"><Tok kind={lampOf(item)} n={item.rank} words={needLabel(item.need)} /></td>
                    <td className="task">
                      <a className="t" href={href}>{item.subject.title || 'Untitled task'}</a>
                      {item.priority === 'incident' ? <span className="flag">Incident</span> : null}
                      {item.stage ? <span className="at">{item.need === 'stopped' && item.reason.code === 'task_stopped' ? 'Stopped at' : 'At'} {item.stage.label}</span> : null}
                    </td>
                    <td className="why">{lead}</td>
                    <td className="proj">{project}</td>
                    <td className="when">{when ? (when.kind === 'expires' ? <Left iso={when.iso} now={now} /> : <When iso={when.iso} now={now} />) : null}</td>
                    <td className="act">
                      {item.dismissible ? <button type="button" className="plain" data-dismiss onClick={() => { onDismiss?.(item.key); }}>{DISMISS_LABEL}</button> : null}
                      <a className={i === 0 ? 'key on' : 'key'} href={href}>{actionOf(item).label}</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <details className="queue-rules">
          <summary>How this list is ordered</summary>
          <ol>{rules.slice(0, -1).map((r) => <li key={r}>{r}</li>)}</ol>
          <p className="dim">{rules.at(-1)}</p>
        </details>
        {others.length > 0 && work ? (
          <section className="other" aria-labelledby="other-title">
            <h2 id="other-title" className="subhead">Your other work <span>({others.length})</span></h2>
            <table className="flight" aria-label="Your other work">
              <colgroup><col className="c-num" /><col /><col className="c-why" /><col className="c-proj" /><col className="c-when" /><col className="c-act" /></colgroup>
              <tbody>
                {others.map(({ card, kind, why, when }) => (
                  <tr key={card.taskId}>
                    <td className="num"><Tok kind={kind} /></td>
                    <td className="task"><a className="t" href={links.taskHref(card.taskId)}>{card.title}</a>{card.stage ? <span className="at">At {card.stage.label}</span> : null}</td>
                    <td className="why">{why}</td>
                    <td className="proj">{work.applications[card.applicationId]}</td>
                    <td className="when">{when}</td>
                    <td className="act" />
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </section>
    </main>
  );
}

export function BoardView({ board, taskHref, now = Date.now() }: { board: Board; taskHref: (taskId: string) => string; now?: number }) {
  const active = board.columns.queued.length + board.columns.running.length + board.columns.waiting.length + board.columns.paused.length;
  return (
    <main aria-labelledby="board-title" className="page board-page">
      <header className="page-head">
        <h1 id="board-title">{board.name}</h1>
        <ul className="facts">
          <li><strong>{active}</strong> active</li>
          <li data-tone={board.needsPerson.length > 0 ? 'wait' : 'none'}><strong>{board.needsPerson.length}</strong> waiting on a person</li>
          <li><strong>{usd(board.spentThisMonthMicroUsd)}</strong> spent this month</li>
          <li className="dim">updated <When iso={board.generatedAt} now={now} /></li>
        </ul>
      </header>
      {board.truncated ? <p className="note" role="status"><span className="lamp" aria-hidden="true" />This board is too large to show in full; some tasks are not listed.</p> : null}
      <div className="board" role="list" aria-label={`${board.name} board`}>
        {BOARD_COLUMNS.map((col) => (
          <section key={col} role="listitem" className="column" aria-labelledby={`board-${col}`} data-column={col} data-empty={board.columns[col].length === 0 ? 'true' : 'false'}>
            <h2 id={`board-${col}`}><span>{COLUMN_LABELS[col]}</span> <span className="count-pill">{board.columns[col].length}</span></h2>
            {board.columns[col].length === 0 ? <p className="column-empty visually-hidden">Nothing here</p> : board.columns[col].map((c) => <BoardCard key={c.taskId} card={c} people={board.people} stations={board.stations} taskHref={taskHref} now={now} />)}
          </section>
        ))}
      </div>
    </main>
  );
}

export type TaskExtras = { steps?: PipelineStep[]; project?: string | undefined; creator?: string | undefined; waitingOn?: { name: string; expiresAt?: string | undefined; decisionHref?: string | undefined } | undefined; reason?: string | undefined; now?: number; actions?: ReactNode };
export function TaskDetail({ model, extras = {} }: { model: TaskModel; extras?: TaskExtras }) {
  const now = extras.now ?? Date.now();
  const current = model.gates.filter((g) => g.current);
  const past = model.gates.filter((g) => !g.current);
  const history = model.stages.filter((s) => s.superseded || s.attempt > 1);
  const done = extras.steps?.filter((s) => s.state === 'done').length ?? 0;
  return (
    <main aria-labelledby="task-title" className="page task-page">
      <header className="page-head">
        <p className="crumbs">{extras.project ? <span>{extras.project}</span> : null}{extras.creator ? <span>by {shortName(extras.creator)}</span> : null}</p>
        <h1 id="task-title">{model.title}</h1>
        <p className="status-line">
          <span className="visually-hidden">Status: {model.status.value}</span>
          <span className={`lamp ${lampOfStatus(model.status.value)}`} aria-hidden="true" /><span className="status-word">{statusOf(model.status.value).label}</span>
          {model.currentNode && model.status.tone !== 'success' ? <span className="dim">at {label(model.currentNode)}</span> : null}
        </p>
        <FreshnessBanner freshness={model.freshness} />
      </header>
      {extras.waitingOn ? (
        <section className="callout" aria-label="Waiting on a person">
          <p className="callout-line"><Tok kind="else" /><span><strong>Waiting on {shortName(extras.waitingOn.name)}</strong> to review the plan.{extras.waitingOn.expiresAt ? <span className="dim"> The request expires <When iso={extras.waitingOn.expiresAt} now={now} />.</span> : null}</span></p>
          {extras.waitingOn.decisionHref ? <a className="key on" href={extras.waitingOn.decisionHref}>Review now</a> : null}
        </section>
      ) : null}
      {extras.reason ? <section className="callout" aria-label="Why it stopped"><p className="callout-line"><Tok kind="red" /><span><strong>Stopped before finishing.</strong> {label(extras.reason)}. Nothing was delivered.</span></p></section> : null}
      {extras.steps && extras.steps.length > 0 ? (
        <section className="console line-panel" aria-labelledby="pipeline-title">
          <h2 id="pipeline-title">Progress <span className="dim">{done} of {extras.steps.length} stages done</span></h2>
          <TaskLine steps={extras.steps} holder={extras.waitingOn ? shortName(extras.waitingOn.name) : undefined} />
        </section>
      ) : null}
      <section className="console" aria-labelledby="gates-title">
        <h2 id="gates-title">Checks</h2>
        {current.length === 0 ? <p className="dim">No checks have run yet.</p> : (
          <ul className="checks" aria-label="Gates">
            {current.map((g, i) => (
              <li key={`${g.gateId}-${String(i)}`} data-verdict={g.verdict}>
                <span className={`lamp ${g.verdict === 'passed' ? 'green' : g.verdict === 'failed' ? 'red' : 'else'}`} aria-hidden="true" />
                <span><strong>{label(g.gateId)}</strong> <span className="visually-hidden">{g.gateId} {g.verdict}</span><span className="dim">{g.reasonCodes.map(label).join(' · ')}</span></span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {extras.actions}
      {history.length + past.length > 0 ? (
        <details className="console history">
          <summary>History: earlier attempts and superseded work ({history.length + past.length})</summary>
          {past.length > 0 ? (
            <ul className="checks" aria-label="Superseded checks">
              {past.map((g, i) => <li key={`${g.gateId}-${String(i)}`} data-verdict="superseded"><span className="lamp else" aria-hidden="true" /><span><strong>{label(g.gateId)}</strong><span className="dim">{label(g.verdict)} earlier — superseded, no longer applies</span></span></li>)}
            </ul>
          ) : null}
          {history.length > 0 ? (
            <table aria-label="Stages" className="plain-table">
              <thead><tr><th scope="col">Stage</th><th scope="col">Plan</th><th scope="col">Attempt</th><th scope="col">Result</th></tr></thead>
              <tbody>{history.map((s) => <tr key={s.logicalId} data-superseded={s.superseded ? 'true' : 'false'}><td>{label(s.nodeId)}</td><td>{s.planVersion}</td><td>{s.attempt}</td><td>{s.superseded ? `${label(s.status)} (superseded)` : label(s.status)}</td></tr>)}</tbody>
            </table>
          ) : null}
        </details>
      ) : null}
    </main>
  );
}

// Decision inbox: one row per item waiting on the signed-in person, soonest expiry first. An
// expired item offers no way to answer.
export type InboxContext = Record<string, { title: string; project?: string | undefined; askedBy?: string | undefined }>;
export function DecisionInbox({ model, taskHref, decisionHref, context = {}, now = Date.now() }: { model: InboxModel; taskHref: (taskId: string) => string; decisionHref: (decisionId: string) => string; context?: InboxContext; now?: number }) {
  return (
    <main aria-labelledby="inbox-title" className="page">
      <header className="page-head"><h1 id="inbox-title">Inbox</h1><p role="status" aria-live="polite" className="dim">{model.summary}</p></header>
      {model.items.length === 0 ? <p className="empty">You are all caught up. Requests for your review will appear here.</p> : (
        <table className="inbox" aria-label="Decisions waiting on you">
          <colgroup><col className="c-num" /><col /><col className="c-why" /><col className="c-proj" /><col className="c-asker" /><col className="c-when" /><col className="c-act" /></colgroup>
          <thead><tr><th scope="col"><span className="visually-hidden">Urgency</span></th><th scope="col">Task</th><th scope="col">What you decide</th><th scope="col">Project</th><th scope="col">Asked by</th><th scope="col" className="when">When</th><th scope="col"><span className="visually-hidden">Action</span></th></tr></thead>
          <tbody>
            {model.items.map((i, n) => {
              const c = context[i.taskId];
              return (
                <tr key={i.id} className={n === 0 && i.urgency !== 'expired' ? 'first' : undefined} data-urgency={i.urgency}>
                  <td className="num"><Tok kind={i.urgency === 'expired' ? 'else' : 'amber'} words={i.urgency === 'expired' ? 'Expired' : i.urgency === 'soon' ? 'Expires within a day' : 'Waiting on you'} /></td>
                  <td className="task"><a className="t" href={taskHref(i.taskId)}>{c?.title ?? i.label}</a></td>
                  <td className="why">{askOf(i.action)}</td>
                  <td className="proj">{c?.project}</td>
                  <td className="proj asker">{c?.askedBy ? shortName(c.askedBy) : null}</td>
                  <td className="when">{i.urgency === 'expired' ? 'Expired' : <Left iso={i.expiresAt} now={now} />}</td>
                  <td className="act">{i.urgency === 'expired' ? <span className="dim">No longer answerable</span> : <a className={n === 0 ? 'key on' : 'key'} href={decisionHref(i.id)}>Review</a>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
