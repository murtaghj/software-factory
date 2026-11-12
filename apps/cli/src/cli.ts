// `factory` command-line client (plan-additions P-07). Thin by design: every rule is enforced by the
// API and the workflow; the CLI only builds requests and prints what came back.
//
// Decisions (approve, reject, request-changes) are human authority (INV-21, INV-29). The CLI
// answers one only from an interactive terminal, after showing the decision and reading a typed
// confirmation. Run without a terminal (a script, a pipe, an agent's shell) it refuses.
import { parseArgs } from 'node:util';
import { PLAN_SECTION_IDS, buildDecisionResponse, fetchInbox, inboxModel, type ApiResult, type FactoryClient } from '@factory/client';
import { validateContract, type DecisionView, type PlanSectionId, type TaskView } from '@factory/contracts';

export type CliIo = {
  client: FactoryClient;
  out: (line: string) => void;
  err: (line: string) => void;
  // True only when a person is at an interactive terminal.
  isTTY: boolean;
  ask: (question: string) => Promise<string>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, text: string) => Promise<void>;
  now: () => number;
  uuid: () => string;
  sleep: (ms: number) => Promise<void>;
};

export const EXIT = { ok: 0, refused: 1, usage: 2 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECISION_VERBS = { approve: 'approve', reject: 'reject', 'request-changes': 'request_changes' } as const;
const TASK_VERBS = ['pause', 'resume', 'cancel'] as const;

export const USAGE = `factory — software factory client

Tasks
  factory submit <request.json> [--key <idempotency-key>]   submit a TaskRequest
  factory status <taskId>                                   show one task
  factory list [--status <status>] [--limit <n>]            list tasks, newest first
  factory evidence <taskId>                                 stage runs and gate evaluations
  factory pause|resume|cancel <taskId> --reason <text> [--wait]
  factory receipt <commandId>                               what happened to a command
  factory export <taskId> [--out <file>]                    outcome bundle (operators)

Decisions waiting on you
  factory inbox                                             what is waiting on you
  factory show <decisionId>                                 one decision
  factory approve <decisionId> --reason <text> --reviewed-all [--wait]
  factory reject <decisionId> --reason <text> [--reviewed <a,b>] [--wait]
  factory request-changes <decisionId> --reason <text> [--reviewed <a,b>] [--wait]
    Decisions are answered by a person: these three need an interactive terminal.

Options
  --json    print the API's JSON instead of text
  --help    show this help

Environment: FACTORY_API_URL, FACTORY_TOKEN`;

class Refused extends Error {
  readonly result: ApiResult;
  constructor(result: ApiResult) { super('refused'); this.result = result; }
}
class Usage extends Error {}

function expect(r: ApiResult, statuses: number[]): unknown {
  if (!statuses.includes(r.status)) throw new Refused(r);
  return r.body;
}
function id(value: string | undefined, what: string): string {
  if (value === undefined || !UUID.test(value)) throw new Usage(`${what} must be a UUID`);
  return value;
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      json: { type: 'boolean' }, help: { type: 'boolean' }, wait: { type: 'boolean' }, 'reviewed-all': { type: 'boolean' },
      reason: { type: 'string' }, reviewed: { type: 'string' }, status: { type: 'string' }, limit: { type: 'string' }, key: { type: 'string' }, out: { type: 'string' },
    } });
  } catch (e) {
    io.err(`factory: ${e instanceof Error ? e.message : 'invalid arguments'}`);
    io.err('Run `factory --help` for usage.');
    return EXIT.usage;
  }
  const { values: opt, positionals } = parsed;
  const [verb, target] = positionals;
  if (opt.help || verb === undefined || verb === 'help') { io.out(USAGE); return verb === undefined && !opt.help ? EXIT.usage : EXIT.ok; }
  const json = opt.json === true;
  const print = (value: unknown, text: () => string[]): void => { if (json) io.out(JSON.stringify(value, null, 2)); else for (const line of text()) io.out(line); };
  const taskLine = (t: TaskView): string => `${t.id}  ${t.status.padEnd(16)}  ${t.spec.title}`;
  // Polls a command until the workflow has applied or rejected it.
  const settle = async (commandId: string): Promise<{ state: string; reason?: string }> => {
    for (let i = 0; i < 120; i += 1) {
      const r = expect(await io.client.get(`/v2/commands/${commandId}`), [200]) as { state: string; reason?: string };
      if (r.state === 'applied' || r.state === 'rejected') return r;
      await io.sleep(500);
    }
    throw new Usage('timed out waiting for the command; check it later with `factory receipt`');
  };
  const receipt = async (r: { commandId: string; state: string; reason?: string }): Promise<number> => {
    const final = opt.wait === true ? { ...r, ...(await settle(r.commandId)) } : r;
    print(final, () => [`command ${final.commandId}: ${final.state}${final.reason ? ` (${final.reason})` : ''}`]);
    return final.state === 'rejected' ? EXIT.refused : EXIT.ok;
  };

  try {
    if (verb === 'submit') {
      if (target === undefined) throw new Usage('submit needs a TaskRequest JSON file');
      let request: unknown;
      try { request = JSON.parse(await io.readFile(target)) as unknown; } catch { throw new Usage(`cannot read ${target} as JSON`); }
      const valid = validateContract('TaskRequest', request);
      if (!valid.ok) throw new Usage(`not a valid TaskRequest:\n${valid.errors.slice(0, 10).map((e) => `  ${e.path || '/'} ${e.message}`).join('\n')}`);
      const body = expect(await io.client.post('/v2/tasks', request, opt.key ?? io.uuid()), [200, 202]) as { taskId: string; status: string };
      print(body, () => [`task ${body.taskId} ${body.status}`]);
      return EXIT.ok;
    }
    if (verb === 'status') {
      const t = expect(await io.client.get(`/v2/tasks/${id(target, 'taskId')}`), [200]) as TaskView;
      print(t, () => [taskLine(t), `  revision ${String(t.revision)} · plan ${String(t.planVersion)}${t.currentNodeId ? ` · stage ${t.currentNodeId}` : ''}${t.waitingReason ? ` · waiting: ${t.waitingReason}` : ''}`, `  as of ${t.projectedAt}`]);
      return EXIT.ok;
    }
    if (verb === 'list') {
      const q = new URLSearchParams({ limit: opt.limit ?? '20' });
      if (opt.status) q.set('status', opt.status);
      const page = expect(await io.client.get(`/v2/tasks?${q.toString()}`), [200]) as { items: TaskView[] };
      print(page, () => (page.items.length === 0 ? ['No tasks.'] : page.items.map(taskLine)));
      return EXIT.ok;
    }
    if (verb === 'evidence') {
      const taskId = id(target, 'taskId');
      const runs = (expect(await io.client.get(`/v2/tasks/${taskId}/runs`), [200]) as { items: Array<{ nodeId: string; semanticAttempt: number; status: string; supersededAt?: string }> }).items;
      const gates = (expect(await io.client.get(`/v2/tasks/${taskId}/gates`), [200]) as { items: Array<{ gateId: string; verdict: string; reasonCodes: string[] }> }).items;
      print({ runs, gates }, () => ['Stages', ...runs.map((r) => `  ${r.nodeId.padEnd(18)} attempt ${String(r.semanticAttempt)}  ${r.status}${r.supersededAt ? ' (superseded)' : ''}`), 'Gates', ...gates.map((g) => `  ${g.gateId.padEnd(20)} ${g.verdict}  ${g.reasonCodes.join(', ')}`)]);
      return EXIT.ok;
    }
    if ((TASK_VERBS as readonly string[]).includes(verb)) {
      const taskId = id(target, 'taskId');
      if (!opt.reason || opt.reason.trim().length === 0) throw new Usage(`${verb} needs --reason`);
      const t = expect(await io.client.get(`/v2/tasks/${taskId}`), [200]) as TaskView;
      const r = expect(await io.client.post(`/v2/tasks/${taskId}/commands`, { commandId: io.uuid(), expectedRevision: t.revision, kind: verb, reason: opt.reason.trim() }, io.uuid(), { 'if-match': String(t.revision) }), [202]) as { commandId: string; state: string };
      return await receipt(r);
    }
    if (verb === 'receipt') {
      const r = expect(await io.client.get(`/v2/commands/${id(target, 'commandId')}`), [200]) as { commandId: string; state: string; reason?: string };
      print(r, () => [`command ${r.commandId}: ${r.state}${r.reason ? ` (${r.reason})` : ''}`]);
      return EXIT.ok;
    }
    if (verb === 'export') {
      const bundle = expect(await io.client.get(`/v2/tasks/${id(target, 'taskId')}/outcome-bundle`), [200]) as { verification: { digestVerifiedArtifacts: number }; reviewMode: string };
      const text = JSON.stringify(bundle, null, 2);
      if (opt.out) { await io.writeFile(opt.out, `${text}\n`); io.out(`wrote ${opt.out} (${String(bundle.verification.digestVerifiedArtifacts)} artifacts verified, review mode ${bundle.reviewMode})`); } else io.out(text);
      return EXIT.ok;
    }
    if (verb === 'inbox') {
      const model = await fetchInbox((path) => io.client.get(path), io.now());
      print(model, () => [model.summary, ...model.items.map((i) => `${i.id}  ${i.label.padEnd(22)} task ${i.taskId}  expires ${i.expiresAt}${i.urgency === 'soon' ? ' (within a day)' : i.urgency === 'expired' ? ' (expired)' : ''}`)]);
      return EXIT.ok;
    }
    if (verb === 'show') {
      const d = expect(await io.client.get(`/v2/decisions/${id(target, 'decisionId')}`), [200]) as DecisionView;
      print(d, () => [`${d.id}  ${d.action}  ${d.state}`, `  task ${d.taskId}`, `  ${d.reason}`, `  subject ${d.subjectHash}`, `  expires ${d.expiresAt}`]);
      return EXIT.ok;
    }
    if (verb in DECISION_VERBS) {
      const outcome = DECISION_VERBS[verb as keyof typeof DECISION_VERBS];
      const decisionId = id(target, 'decisionId');
      if (!io.isTTY) { io.err(`factory: ${verb} is a human decision and needs an interactive terminal. It cannot be run from a script, a pipe or an agent.`); return EXIT.usage; }
      const d = expect(await io.client.get(`/v2/decisions/${decisionId}`), [200]) as DecisionView;
      const item = inboxModel([d], io.now()).items[0];
      if (!item) { io.err(`factory: decision ${decisionId} is ${d.state}; there is nothing to answer.`); return EXIT.refused; }
      const asked = (opt.reviewed ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      const unknown = asked.filter((s) => !(PLAN_SECTION_IDS as readonly string[]).includes(s));
      if (unknown.length > 0) throw new Usage(`unknown section(s): ${unknown.join(', ')}`);
      const reviewed = opt['reviewed-all'] === true ? [...item.sectionsToReview] : (asked as PlanSectionId[]);
      const t = expect(await io.client.get(`/v2/tasks/${d.taskId}`), [200]) as TaskView;
      const built = buildDecisionResponse(item, { outcome, reason: opt.reason ?? '', reviewedSectionIds: reviewed, commandId: io.uuid(), expectedRevision: t.revision });
      if (!built.ok) { for (const p of built.problems) io.err(`factory: ${p}`); return EXIT.usage; }
      io.out(`${item.label} for task ${d.taskId} — "${t.spec.title}"`);
      io.out(`  ${d.reason}`);
      io.out(`  subject ${d.subjectHash}`);
      if (reviewed.length > 0) io.out(`  you confirm you reviewed: ${reviewed.join(', ')}`);
      const typed = (await io.ask(`Type "${verb}" to ${verb.replace('-', ' ')} as yourself: `)).trim();
      if (typed !== verb) { io.err('factory: not confirmed; nothing was sent.'); return EXIT.refused; }
      const r = expect(await io.client.post(`/v2/decisions/${decisionId}/responses`, built.body, io.uuid()), [202]) as { commandId: string; state: string };
      return await receipt(r);
    }
    io.err(`factory: unknown command "${verb}"`);
    io.err('Run `factory --help` for usage.');
    return EXIT.usage;
  } catch (e) {
    if (e instanceof Usage) { io.err(`factory: ${e.message}`); return EXIT.usage; }
    if (e instanceof Refused) {
      const p = (typeof e.result.body === 'object' && e.result.body !== null ? e.result.body : {}) as { code?: string; detail?: string; fieldErrors?: string[] };
      if (json) io.out(JSON.stringify({ status: e.result.status, ...p }, null, 2));
      io.err(`factory: ${p.code ?? `HTTP ${String(e.result.status)}`}${p.detail ? ` — ${p.detail}` : ''}`);
      for (const f of p.fieldErrors ?? []) io.err(`  ${f}`);
      return EXIT.refused;
    }
    throw e;
  }
}
