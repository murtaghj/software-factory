// The single pane: one signed-in app over the factory API. It owns loading, polling and sign-in;
// the views it renders are pure. It holds no rules: every action is an API call the server decides.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DecisionView, GateEvaluation, PlanSectionId, RunView, TaskView } from '@factory/contracts';
import { FactoryClient, buildDecisionResponse, inboxModel, type ApiResult, type Board, type InboxModel, type Me, type MyWork } from '@factory/client';
import { beginSignIn, completeSignIn, currentSession, discover, signOut, type AuthConfig, type Discovery, type KeyValue, type Session } from './auth.ts';
import { BoardView, DecisionInbox, MyWorkView, TaskDetail } from './components.tsx';
import { href, parseRoute, type Route } from './routes.ts';
import { BudgetView, DecisionReview, Notice, ProjectsView, Shell, SignedOut, TaskActions, type AllowanceData, type ReviewState } from './shell.tsx';
import { taskModel } from './view-model.ts';

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

  if (!session || !client) return <SignedOut message={authMessage} onSignIn={startSignIn} />;
  if (!me.data) return <Notice kind={me.error ? 'error' : 'loading'}>{me.error ?? 'Loading…'}</Notice>;
  return (
    <Shell me={me.data} route={route} inboxCount={inbox.data?.items.length ?? 0} onSignOut={leave}>
      <Page route={route} me={me.data} inbox={inbox} get={get} client={client} pollMs={pollMs} now={now} onUnauthorized={expire} />
    </Shell>
  );
}

type PageProps = { route: Route; me: Me; inbox: Loaded<InboxModel> & { reload: () => void }; get: <T>(path: string) => Promise<T>; client: FactoryClient; pollMs: number; now: () => number; onUnauthorized: () => void };
function pending<T>(l: Loaded<T>, what: string): React.ReactElement | undefined {
  if (l.data !== undefined) return undefined;
  if (l.missing) return <Notice kind="error">This {what} does not exist, or you do not have access to it.</Notice>;
  return <Notice kind={l.error ? 'error' : 'loading'}>{l.error ?? 'Loading…'}</Notice>;
}

function Page(p: PageProps) {
  switch (p.route.page) {
    case 'work': return <WorkPage {...p} />;
    case 'inbox': return p.inbox.data ? <DecisionInbox model={p.inbox.data} taskHref={href.task} decisionHref={href.decision} /> : pending(p.inbox, 'inbox') ?? null;
    case 'projects': return <ProjectsView me={p.me} />;
    case 'project': return <ProjectPage {...p} applicationId={p.route.applicationId} />;
    case 'task': return <TaskPage {...p} taskId={p.route.taskId} />;
    case 'decision': return <DecisionPage {...p} decisionId={p.route.decisionId} />;
    case 'budget': return <BudgetPage {...p} />;
    case 'not_found': return <Notice kind="error">There is no such page. <a href={href.work}>Go to my work</a>.</Notice>;
  }
}

function WorkPage({ get, pollMs, onUnauthorized }: PageProps) {
  const work = usePolled<MyWork>(() => get<MyWork>('/v2/me/work'), 'work', pollMs, onUnauthorized);
  return work.data ? <MyWorkView work={work.data} taskHref={href.task} /> : pending(work, 'page') ?? null;
}
function ProjectPage({ get, pollMs, onUnauthorized, applicationId }: PageProps & { applicationId: string }) {
  const board = usePolled<Board>(() => get<Board>(`/v2/applications/${applicationId}/board`), `board:${applicationId}`, pollMs, onUnauthorized);
  return board.data ? <BoardView board={board.data} taskHref={href.task} /> : pending(board, 'project') ?? null;
}
function BudgetPage({ get, pollMs, onUnauthorized }: PageProps) {
  const a = usePolled<AllowanceData>(() => get<AllowanceData>('/v2/me/allowance'), 'allowance', pollMs * 3, onUnauthorized);
  return a.data ? <BudgetView allowance={a.data} /> : pending(a, 'page') ?? null;
}

type TaskData = { task: TaskView; runs: RunView[]; gates: GateEvaluation[] };
function TaskPage({ get, client, pollMs, now, onUnauthorized, taskId }: PageProps & { taskId: string }) {
  const t = usePolled<TaskData>(async () => ({ task: await get<TaskView>(`/v2/tasks/${taskId}`), runs: (await get<{ items: RunView[] }>(`/v2/tasks/${taskId}/runs`)).items, gates: (await get<{ items: GateEvaluation[] }>(`/v2/tasks/${taskId}/gates`)).items }), `task:${taskId}`, Math.min(pollMs, 2000), onUnauthorized);
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
      setNote(r.status === 202 ? `${kind} requested.` : new ApiProblem(r).message);
      if (r.status === 202) setReason('');
      setBusy(false);
      t.reload();
    })();
  };
  if (!data) return pending(t, 'task') ?? null;
  return (
    <>
      <TaskDetail model={taskModel(data.task, data.runs, data.gates, t.error ? 'disconnected' : 'live', now())} />
      <TaskActions task={data.task} busy={busy} reason={reason} onReason={setReason} onCommand={send} />
      {note ? <Notice kind="empty">{note}</Notice> : null}
    </>
  );
}

function DecisionPage({ get, client, pollMs, now, onUnauthorized, inbox, decisionId }: PageProps & { decisionId: string }) {
  const d = usePolled<{ decision: DecisionView; task: TaskView }>(async () => { const decision = await get<DecisionView>(`/v2/decisions/${decisionId}`); return { decision, task: await get<TaskView>(`/v2/tasks/${decision.taskId}`) }; }, `decision:${decisionId}`, pollMs, onUnauthorized);
  const [state, setState] = useState<ReviewState>({ reviewed: [], reason: '', problems: [], sending: false });
  useEffect(() => { setState({ reviewed: [], reason: '', problems: [], sending: false }); }, [decisionId]);
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
  const toggle = (section: PlanSectionId): void => { setState((s) => ({ ...s, reviewed: s.reviewed.includes(section) ? s.reviewed.filter((x) => x !== section) : [...s.reviewed, section] })); };
  return <DecisionReview decision={data.decision} item={item} taskTitle={data.task.spec.title} state={state} onToggle={toggle} onReason={(reason) => { setState((s) => ({ ...s, reason })); }} onAnswer={answer} />;
}
