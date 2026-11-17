// The single pane: one signed-in app over the factory API. It owns loading, polling and sign-in;
// the views it renders are pure. It holds no rules: every action is an API call the server decides.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DecisionView, GateEvaluation, PlanSectionId, RunView, TaskView } from '@factory/contracts';
import { FactoryClient, QUEUE_ACK_PATH, QUEUE_PATH, buildDecisionResponse, inboxModel, parseQueue, type ApiResult, type Board, type InboxModel, type Me, type MyWork, type Queue } from '@factory/client';
import { beginSignIn, completeSignIn, currentSession, discover, signOut, type AuthConfig, type Discovery, type KeyValue, type Session } from './auth.ts';
import { BoardView, DecisionInbox, QueueView, TaskDetail } from './components.tsx';
import { href, parseRoute, type Route } from './routes.ts';
import { BudgetView, DecisionReview, Notice, ProjectsView, Shell, SignedOut, TaskActions, type AllowanceData, type ReviewState } from './shell.tsx';
import { pipelineOf, taskModel, type PlanNode } from './view-model.ts';

export type AppConfig = { apiUrl: string; auth: AuthConfig };
export type AppDeps = { config: AppConfig; storage: KeyValue; location: { href: string; hash: string; assign: (url: string) => void; replaceHash: (hash: string) => void; onHashChange: (listener: () => void) => () => void }; fetchImpl?: typeof fetch; now?: () => number; pollMs?: number };

class Unauthorized extends Error {}
class ApiProblem extends Error {
  readonly status: number;
  constructor(r: ApiResult) {
    const p = (typeof r.body === 'object' && r.body !== null ? r.body : {}) as { detail?: string; code?: string };
    super(p.detail ?? p.code ?? `request failed (${String(r.status)})`);
    this.status = r.status;
  }
}
type Loaded<T> = { data?: T; error?: string; missing?: boolean };

// Loads `load` now and every `pollMs`, keeping the last good data on a failed refresh.
function usePolled<T>(load: (() => Promise<T>) | undefined, key: string, pollMs: number, onUnauthorized: () => void): Loaded<T> & { reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({});
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => { setState({}); }, [key]);
  useEffect(() => {
    let live = true;
    const run = async (): Promise<void> => {
      const fn = loader.current;
      if (!fn) return;
      try {
        const data = await fn();
        if (live) setState({ data });
      } catch (e) {
        if (!live) return;
        if (e instanceof Unauthorized) { onUnauthorized(); return; }
        const missing = e instanceof ApiProblem && e.status === 404;
        setState((prev) => ({ ...prev, error: e instanceof Error ? e.message : 'request failed', ...(missing ? { missing: true } : {}) }));
      }
    };
    void run();
    const timer = setInterval(() => { void run(); }, pollMs);
    return () => { live = false; clearInterval(timer); };
  }, [key, tick, pollMs, onUnauthorized]);
  return { ...state, reload: useCallback(() => { setTick((t) => t + 1); }, []) };
}

export function App({ deps }: { deps: AppDeps }) {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 4000;
  const [session, setSession] = useState<Session | undefined>(() => currentSession(deps.storage, now()));
  const [authMessage, setAuthMessage] = useState<string | undefined>();
  const [route, setRoute] = useState<Route>(() => parseRoute(deps.location.hash));
  const discovery = useRef<Discovery | undefined>(undefined);
  const getDiscovery = useCallback(async (): Promise<Discovery> => { discovery.current ??= await discover(deps.config.auth.issuer, deps.fetchImpl); return discovery.current; }, [deps]);

  useEffect(() => deps.location.onHashChange(() => { setRoute(parseRoute(deps.location.hash)); }), [deps]);

  // Finish a sign-in if this page load is the redirect back from the login provider.
  useEffect(() => {
    void (async () => {
      try {
        const r = await completeSignIn(deps.config.auth, await getDiscovery(), deps.storage, deps.location.href, now(), deps.fetchImpl);
        if (r.kind === 'signed_in') { setSession(r.session); deps.location.replaceHash(r.returnTo); setRoute(parseRoute(r.returnTo)); }
        if (r.kind === 'error') { setAuthMessage(r.message); deps.location.replaceHash(''); }
      } catch (e) { setAuthMessage(e instanceof Error ? e.message : 'Sign-in is unavailable.'); }
    })();
  }, [deps, getDiscovery, now]);

  const startSignIn = useCallback(() => {
    void (async () => {
      try { deps.location.assign(await beginSignIn(deps.config.auth, await getDiscovery(), deps.storage, deps.location.hash)); } catch (e) { setAuthMessage(e instanceof Error ? e.message : 'Sign-in is unavailable.'); }
    })();
  }, [deps, getDiscovery]);
  const expire = useCallback(() => { signOut(deps.storage); setSession(undefined); setAuthMessage('Your session ended. Sign in again to continue.'); }, [deps]);
  const leave = useCallback(() => { signOut(deps.storage); setSession(undefined); setAuthMessage(undefined); }, [deps]);

  const client = useMemo(() => (session ? new FactoryClient({ baseUrl: deps.config.apiUrl, token: () => session.accessToken, ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}) }) : undefined), [session, deps]);
  const get = useCallback(async <T,>(path: string): Promise<T> => {
    if (!client) throw new Unauthorized();
    const r = await client.get(path);
    if (r.status === 401) throw new Unauthorized();
    if (r.status !== 200) throw new ApiProblem(r);
    return r.body as T;
  }, [client]);
  const signedIn = client !== undefined;

  const me = usePolled<Me>(signedIn ? () => get<Me>('/v2/me') : undefined, `me:${String(signedIn)}`, 60_000, expire);
  const inbox = usePolled<InboxModel>(signedIn ? async () => inboxModel((await get<{ items: DecisionView[] }>('/v2/decisions?state=pending&assignedTo=me')).items, now()) : undefined, `inbox:${String(signedIn)}`, pollMs, expire);

  const allowance = usePolled<AllowanceData>(signedIn ? () => get<AllowanceData>('/v2/me/allowance') : undefined, `allowance:${String(signedIn)}`, 30_000, expire);

  if (!session || !client) return <SignedOut message={authMessage} onSignIn={startSignIn} />;
  if (!me.data) return <Notice kind={me.error ? 'error' : 'loading'} onRetry={me.error ? me.reload : undefined}>{me.error ?? 'Loading…'}</Notice>;
  return (
    <Shell me={me.data} route={route} inboxCount={inbox.data?.items.length ?? 0} allowance={allowance.data} onSignOut={leave}>
      <Page route={route} me={me.data} inbox={inbox} get={get} client={client} pollMs={pollMs} now={now} onUnauthorized={expire} />
    </Shell>
  );
}

type PageProps = { route: Route; me: Me; inbox: Loaded<InboxModel> & { reload: () => void }; get: <T>(path: string) => Promise<T>; client: FactoryClient; pollMs: number; now: () => number; onUnauthorized: () => void };
function pending<T>(l: Loaded<T> & { reload?: () => void }, what: string): React.ReactElement | undefined {
  if (l.data !== undefined) return undefined;
  if (l.missing) return <Notice kind="error">This {what} does not exist, or you do not have access to it.</Notice>;
  return <Notice kind={l.error ? 'error' : 'loading'} onRetry={l.error ? l.reload : undefined}>{l.error ?? 'Loading…'}</Notice>;
}

function Page(p: PageProps) {
  switch (p.route.page) {
    case 'work': return <WorkPage {...p} />;
    case 'inbox': return <InboxPage {...p} />;
    case 'projects': return <ProjectsView me={p.me} />;
    case 'project': return <ProjectPage {...p} applicationId={p.route.applicationId} />;
    case 'task': return <TaskPage {...p} taskId={p.route.taskId} />;
    case 'decision': return <DecisionPage {...p} decisionId={p.route.decisionId} />;
    case 'budget': return <BudgetPage {...p} />;
    case 'not_found': return <Notice kind="error">There is no such page. <a href={href.work}>Go to my work</a>.</Notice>;
  }
}

// The inbox lists decisions; "my work" knows which task each belongs to, its project and who asked.
function InboxPage({ inbox, get, pollMs, now, onUnauthorized }: PageProps) {
  const work = usePolled<MyWork>(() => get<MyWork>('/v2/me/work'), 'inbox-context', pollMs, onUnauthorized);
  if (!inbox.data) return pending(inbox, 'inbox') ?? null;
  const w = work.data;
  const context = Object.fromEntries((w?.needsYou ?? []).map((c) => [c.taskId, { title: c.title, project: w?.applications[c.applicationId], askedBy: w?.people[c.creatorId] }]));
  return <DecisionInbox model={inbox.data} taskHref={href.task} decisionHref={href.decision} context={context} now={now()} />;
}
function WorkPage({ get, client, pollMs, now, onUnauthorized }: PageProps) {
  const queue = usePolled<Queue>(() => get<unknown>(QUEUE_PATH).then(parseQueue), 'queue', pollMs, onUnauthorized);
  const work = usePolled<MyWork>(() => get<MyWork>('/v2/me/work'), 'work', pollMs * 3, onUnauthorized);
  const [note, setNote] = useState<string | undefined>();
  // "Mark as seen" is the person's own click; the server decides whether the item may be dismissed.
  const dismiss = (key: string): void => {
    void (async () => {
      const r = await client.post(QUEUE_ACK_PATH, { key });
      setNote(r.status === 204 ? undefined : new ApiProblem(r).message);
      queue.reload();
    })();
  };
  if (!queue.data) return pending(queue, 'page') ?? null;
  return (
    <>
      {note ? <Notice kind="error">{note}</Notice> : null}
      <QueueView queue={queue.data} work={work.data} links={{ taskHref: href.task, decisionHref: href.decision, budgetHref: href.budget }} onDismiss={dismiss} now={now()} />
    </>
  );
}
function ProjectPage({ get, pollMs, now, onUnauthorized, applicationId }: PageProps & { applicationId: string }) {
  const board = usePolled<Board>(() => get<Board>(`/v2/applications/${applicationId}/board`), `board:${applicationId}`, pollMs, onUnauthorized);
  return board.data ? <BoardView board={board.data} taskHref={href.task} now={now()} /> : pending(board, 'project') ?? null;
}
function BudgetPage({ get, pollMs, now, onUnauthorized }: PageProps) {
  const a = usePolled<AllowanceData>(() => get<AllowanceData>('/v2/me/allowance'), 'allowance', pollMs * 3, onUnauthorized);
  return a.data ? <BudgetView allowance={a.data} now={now()} /> : pending(a, 'page') ?? null;
}

type TaskData = { task: TaskView; runs: RunView[]; gates: GateEvaluation[]; plan: { planVersion: number; nodes: PlanNode[] }; board?: Board | undefined };
function TaskPage({ get, client, me, pollMs, now, onUnauthorized, taskId }: PageProps & { taskId: string }) {
  const t = usePolled<TaskData>(async () => {
    const task = await get<TaskView>(`/v2/tasks/${taskId}`);
    const applicationId = task.spec.targetContext.kind === 'existing_application' ? task.spec.targetContext.applicationId : undefined;
    return {
      task, runs: (await get<{ items: RunView[] }>(`/v2/tasks/${taskId}/runs`)).items, gates: (await get<{ items: GateEvaluation[] }>(`/v2/tasks/${taskId}/gates`)).items,
      plan: await get<{ planVersion: number; nodes: PlanNode[] }>(`/v2/tasks/${taskId}/plan`),
      // The board supplies names and who the task is waiting on; the page still works without it.
      board: applicationId ? await get<Board>(`/v2/applications/${applicationId}/board`).catch(() => undefined) : undefined,
    };
  }, `task:${taskId}`, Math.min(pollMs, 2000), onUnauthorized);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const data = t.data;
  const send = (kind: 'pause' | 'resume' | 'cancel'): void => {
    if (!data) return;
    if (reason.trim().length === 0) return;
    setBusy(true);
    void (async () => {
      const rev = data.task.revision;
      const r = await client.post(`/v2/tasks/${taskId}/commands`, { commandId: globalThis.crypto.randomUUID(), expectedRevision: rev, kind, reason: reason.trim() }, undefined, { 'if-match': String(rev) });
      setNote(r.status === 202 ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)} requested.` : new ApiProblem(r).message);
      if (r.status === 202) setReason('');
      setBusy(false);
      t.reload();
    })();
  };
  if (!data) return pending(t, 'task') ?? null;
  const { task, board } = data;
  const terminal = ['succeeded', 'incomplete', 'failed', 'cancelled'].includes(task.status);
  const card = board ? Object.values(board.columns).flat().find((c) => c.taskId === taskId) : undefined;
  const people = board?.people ?? {};
  const waitingOn = card?.waitingOnPrincipalId ? { name: people[card.waitingOnPrincipalId] ?? 'someone', expiresAt: card.decisionExpiresAt, decisionHref: card.waitingOnPrincipalId === me.principalId && card.decisionId ? href.decision(card.decisionId) : undefined } : undefined;
  return (
    <TaskDetail
      model={taskModel(task, data.runs, data.gates, t.error ? 'disconnected' : 'live', now())}
      extras={{
        now: now(), steps: pipelineOf(data.plan.nodes, data.runs, data.plan.planVersion, task.currentNodeId, terminal), project: board?.name, creator: people[task.creatorId], waitingOn,
        reason: task.status === 'incomplete' || task.status === 'failed' ? task.waitingReason ?? (task.status === 'failed' ? 'A required stage did not pass' : undefined) : undefined,
        actions: <TaskActions task={task} busy={busy} reason={reason} note={note} onReason={setReason} onCommand={send} />,
      }}
    />
  );
}

type DecisionData = { decision: DecisionView; task: TaskView; plan: { planVersion: number; nodes: PlanNode[] } | undefined; runs: RunView[]; work: MyWork | undefined };
function DecisionPage({ get, client, pollMs, now, onUnauthorized, inbox, decisionId }: PageProps & { decisionId: string }) {
  const d = usePolled<DecisionData>(async () => {
    const decision = await get<DecisionView>(`/v2/decisions/${decisionId}`);
    // The task is needed; the line and the names are context, so their failures do not stop the review.
    // All four are asked at once.
    const [task, plan, runs, work] = await Promise.all([
      get<TaskView>(`/v2/tasks/${decision.taskId}`),
      get<{ planVersion: number; nodes: PlanNode[] }>(`/v2/tasks/${decision.taskId}/plan`).catch(() => undefined),
      get<{ items: RunView[] }>(`/v2/tasks/${decision.taskId}/runs`).then((r) => r.items).catch(() => [] as RunView[]),
      get<MyWork>('/v2/me/work').catch(() => undefined),
    ]);
    return { decision, task, plan, runs: plan ? runs : [], work };
  }, `decision:${decisionId}`, pollMs, onUnauthorized);
  const [state, setState] = useState<ReviewState>({ reviewed: [], reason: '', problems: [], sending: false });
  useEffect(() => { setState({ reviewed: [], reason: '', problems: [], sending: false }); }, [decisionId]);
  // A short-lived link to the plan on the isolated download origin, fetched once per decision.
  const [packetUrl, setPacketUrl] = useState<string | undefined>();
  const subject = d.data?.decision.subjectRef.artifactId;
  useEffect(() => {
    setPacketUrl(undefined);
    if (!subject) return;
    let live = true;
    void client.post(`/v2/artifacts/${subject}/access`, { purpose: 'plan review' }).then((r) => { if (live && r.status === 200) setPacketUrl((r.body as { url: string }).url); });
    return () => { live = false; };
  }, [client, subject]);
  const data = d.data;
  if (!data) return pending(d, 'decision') ?? null;
  const item = inboxModel([data.decision], now()).items[0];
  const answer = (outcome: 'approve' | 'request_changes' | 'reject'): void => {
    if (!item) return;
    const built = buildDecisionResponse(item, { outcome, reason: state.reason, reviewedSectionIds: state.reviewed, commandId: globalThis.crypto.randomUUID(), expectedRevision: data.task.revision });
    if (!built.ok) { setState((s) => ({ ...s, problems: built.problems })); return; }
    setState((s) => ({ ...s, problems: [], sending: true }));
    void (async () => {
      const r = await client.post(`/v2/decisions/${decisionId}/responses`, built.body);
      setState((s) => (r.status === 202 ? { ...s, sending: false, sent: 'Your answer was sent. The task continues once the workflow has applied it.' } : { ...s, sending: false, problems: [new ApiProblem(r).message] }));
      inbox.reload();
      d.reload();
    })();
  };
  // A refusal describes the form as it was; once the form changes it is out of date and goes away.
  const toggle = (section: PlanSectionId): void => { setState((s) => ({ ...s, problems: [], reviewed: s.reviewed.includes(section) ? s.reviewed.filter((x) => x !== section) : [...s.reviewed, section] })); };
  const card = data.work?.needsYou.find((c) => c.taskId === data.decision.taskId);
  const terminal = ['succeeded', 'incomplete', 'failed', 'cancelled'].includes(data.task.status);
  const context = {
    project: card ? data.work?.applications[card.applicationId] : undefined, askedBy: card ? data.work?.people[card.creatorId] : undefined,
    steps: data.plan ? pipelineOf(data.plan.nodes, data.runs, data.plan.planVersion, data.task.currentNodeId, terminal) : undefined,
  };
  return <DecisionReview decision={data.decision} item={item} taskTitle={data.task.spec.title} packetUrl={packetUrl} context={context} now={now()} state={state} onToggle={toggle} onReason={(reason) => { setState((s) => ({ ...s, problems: [], reason })); }} onAnswer={answer} />;
}
