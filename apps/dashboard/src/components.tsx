// Task detail view (W-014). Text plus color for status, accessible tables, an explicit freshness
// banner, and no untrusted HTML: every value is rendered as text by React.
import type { InboxModel } from '@factory/client';
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
