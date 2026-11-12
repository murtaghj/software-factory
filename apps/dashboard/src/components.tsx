// Task detail view (W-014). Text plus color for status, accessible tables, an explicit freshness
// banner, and no untrusted HTML: every value is rendered as text by React.
import { BOARD_COLUMNS, COLUMN_LABELS, MY_WORK_SECTIONS, focusOf, type Board, type InboxModel, type MyWork, type TaskCard } from '@factory/client';
import type { TaskModel } from './view-model.ts';

export function FreshnessBanner({ freshness }: { freshness: TaskModel['freshness'] }) {
  return (
    <p role="status" aria-live="polite" data-stale={freshness.stale ? 'true' : 'false'} data-connection={freshness.connection} className={freshness.stale ? 'banner banner-stale' : 'banner'}>
      {freshness.message}
    </p>
  );
}

export function TaskDetail({ model }: { model: TaskModel }) {
  return (
    <main aria-labelledby="task-title">
      <h1 id="task-title">{model.title}</h1>
      <p>Status: <strong data-tone={model.status.tone}>{model.status.label}</strong>{model.currentNode ? <> · current stage <code>{model.currentNode}</code></> : null}</p>
      <FreshnessBanner freshness={model.freshness} />
      <table aria-label="Stages">
        <thead><tr><th scope="col">Stage</th><th scope="col">Plan</th><th scope="col">Attempt</th><th scope="col">Status</th></tr></thead>
        <tbody>
          {model.stages.map((s) => (
            <tr key={s.logicalId} data-superseded={s.superseded ? 'true' : 'false'}>
              <td>{s.nodeId}</td><td>{s.planVersion}</td><td>{s.attempt}</td><td>{s.superseded ? `${s.status} (superseded)` : s.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table aria-label="Gates">
        <thead><tr><th scope="col">Gate</th><th scope="col">Verdict</th><th scope="col">Applies to current inputs</th><th scope="col">Reasons</th></tr></thead>
        <tbody>
          {model.gates.map((g, i) => (
            <tr key={`${g.gateId}-${String(i)}`}><td>{g.gateId}</td><td>{g.verdict}</td><td>{g.current ? 'yes' : 'no — superseded'}</td><td>{g.reasonCodes.join(', ')}</td></tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

// Decision inbox (P-02). One row per item waiting on the signed-in person, soonest expiry first.
// Urgency is given as text as well as an attribute, and an expired item offers no way to answer.
export function DecisionInbox({ model, taskHref, decisionHref }: { model: InboxModel; taskHref: (taskId: string) => string; decisionHref: (decisionId: string) => string }) {
  return (
    <section aria-labelledby="inbox-title">
      <h2 id="inbox-title">Waiting on you</h2>
      <p role="status" aria-live="polite">{model.summary}</p>
      {model.items.length === 0 ? null : (
        <table aria-label="Decisions waiting on you">
          <thead><tr><th scope="col">Decision</th><th scope="col">Why</th><th scope="col">Task</th><th scope="col">Expires</th><th scope="col">Answer</th></tr></thead>
          <tbody>
            {model.items.map((i) => (
              <tr key={i.id} data-urgency={i.urgency}>
                <td>{i.label}</td>
                <td>{i.reason}</td>
                <td><a href={taskHref(i.taskId)}>Open task</a></td>
                <td><time dateTime={i.expiresAt}>{i.expiresAt}</time>{i.urgency === 'soon' ? ' — expires within a day' : i.urgency === 'expired' ? ' — expired' : ''}</td>
                <td>{i.urgency === 'expired' ? 'Expired' : <a href={decisionHref(i.id)}>Review and answer</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// Project board and "my work" (P-21). Both are read-only: a card shows state the workflow decided,
// and offers links, never a way to move it. Truncation is stated, never hidden.
function Card({ card, people, taskHref, project }: { card: TaskCard; people: Record<string, string>; taskHref: (taskId: string) => string; project?: string | undefined }) {
  return (
    <li data-status={card.status}>
      <a href={taskHref(card.taskId)}>{card.title}</a>
      <span> · {card.status.replace(/_/g, ' ')}</span>
      {project ? <span> · {project}</span> : null}
      {card.currentNodeId ? <span> · stage <code>{card.currentNodeId}</code></span> : null}
      {card.waitingOnPrincipalId ? <span> · waiting on {people[card.waitingOnPrincipalId] ?? 'someone'}{card.decisionExpiresAt ? <> until <time dateTime={card.decisionExpiresAt}>{card.decisionExpiresAt}</time></> : null}</span> : null}
      <span> · by {people[card.creatorId] ?? 'unknown'}</span>
    </li>
  );
}

export function BoardView({ board, taskHref }: { board: Board; taskHref: (taskId: string) => string }) {
  return (
    <main aria-labelledby="board-title">
      <h1 id="board-title">{board.name}</h1>
      <p>As of <time dateTime={board.generatedAt}>{board.generatedAt}</time> · spent this month ${(board.spentThisMonthMicroUsd / 1_000_000).toFixed(2)}</p>
      {board.truncated ? <p role="status">This board is too large to show in full; some tasks are not listed.</p> : null}
      <section aria-labelledby="board-needs"><h2 id="board-needs">Needs a person ({board.needsPerson.length})</h2>
        {board.needsPerson.length === 0 ? <p>Nothing is waiting on anyone.</p> : <ul>{board.needsPerson.map((c) => <Card key={c.taskId} card={c} people={board.people} taskHref={taskHref} />)}</ul>}
      </section>
      {BOARD_COLUMNS.map((col) => (
        <section key={col} aria-labelledby={`board-${col}`} data-column={col}>
          <h2 id={`board-${col}`}>{COLUMN_LABELS[col]} ({board.columns[col].length})</h2>
          {board.columns[col].length === 0 ? <p>None.</p> : <ul>{board.columns[col].map((c) => <Card key={c.taskId} card={c} people={board.people} taskHref={taskHref} />)}</ul>}
        </section>
      ))}
    </main>
  );
}

export function MyWorkView({ work, taskHref }: { work: MyWork; taskHref: (taskId: string) => string }) {
  const focus = focusOf(work);
  return (
    <main aria-labelledby="work-title">
      <h1 id="work-title">My work</h1>
      <p role="status" aria-live="polite" data-focus={focus.kind}><strong>Next:</strong> {focus.text}</p>
      {work.truncated ? <p role="status">You have more work than can be shown; some tasks are not listed.</p> : null}
      {MY_WORK_SECTIONS.map(({ key, label }) => (work[key].length === 0 ? null : (
        <section key={key} aria-labelledby={`work-${key}`} data-section={key}>
          <h2 id={`work-${key}`}>{label} ({work[key].length})</h2>
          <ul>{work[key].map((c) => <Card key={`${key}-${c.taskId}`} card={c} people={work.people} taskHref={taskHref} project={work.applications[c.applicationId]} />)}</ul>
        </section>
      )))}
    </main>
  );
}
