// P-08 (docs/plan-additions.md): the dashboard as a single pane, driven as a browser would drive
// it. The real App is mounted in a simulated DOM against the real API and the local issuer's
// sign-in flow. A reviewer signs in, finds the inbox, approves a plan by ticking the sections, and
// the developer then sees the task finish — without leaving the app.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import type * as ReactModule from 'react';
import type * as ReactDomClient from 'react-dom/client';
import type * as Dashboard from '@factory/dashboard';

type Root = ReactDomClient.Root;
type AppDeps = Dashboard.AppDeps;
import { DASHBOARD_CLIENT_ID, createSystemHarness, type SystemHarness, type SystemUser } from '../src/index.ts';
import { createTask, getTask, pendingDecision, waitStatus } from './support.ts';

const ORIGIN = 'http://localhost:4173';

describe('P-08 single pane of glass', () => {
  let h: SystemHarness;
  let dana: SystemUser;
  let riley: SystemUser;
  let dom: JSDOM;
  let root: Root | undefined;
  // React DOM decides at import time whether it is in a browser, so the simulated DOM is installed
  // first and React, React DOM and the app are imported after it.
  let act: typeof ReactModule.act;
  let createElement: typeof ReactModule.createElement;
  let createRoot: typeof ReactDomClient.createRoot;
  let App: typeof Dashboard.App;
  beforeAll(async () => {
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: `${ORIGIN}/` });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
    ({ act, createElement } = await import('react'));
    ({ createRoot } = await import('react-dom/client'));
    ({ App } = await import('@factory/dashboard'));
    h = await createSystemHarness('p08', { dashboardOrigin: ORIGIN, temporal: {} });
    dana = await h.user([{ role: 'contributor', scope: [h.applicationId] }], 'Dana');
    riley = await h.user([{ role: 'reviewer', scope: [h.applicationId] }], 'Riley');
  }, 300_000);
  afterEach(async () => { const r = root; root = undefined; if (r) await act(async () => { r.unmount(); await Promise.resolve(); }); });
  afterAll(async () => { await h.close(); dom.window.close(); });

  // A tab: its own sessionStorage and address bar. `visit` loads the app at a URL.
  type Tab = { deps: AppDeps; assigned: string[]; text: () => string; visit: (url?: string) => Promise<void>; go: (hash: string) => Promise<void> };
  const newTab = (): Tab => {
    const mem = new Map<string, string>();
    const at = { href: `${ORIGIN}/`, hash: '' };
    const listeners = new Set<() => void>();
    const assigned: string[] = [];
    const container = dom.window.document.getElementById('root') as unknown as Element;
    const deps: AppDeps = {
      config: { apiUrl: h.apiUrl, auth: { issuer: h.issuer.issuer, clientId: DASHBOARD_CLIENT_ID, redirectUri: `${ORIGIN}/` } },
      storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); }, removeItem: (k) => { mem.delete(k); } },
      location: { get href() { return at.href; }, get hash() { return at.hash; }, assign: (url) => { assigned.push(url); }, replaceHash: (hash) => { at.hash = hash; at.href = `${ORIGIN}/${hash}`; }, onHashChange: (l) => { listeners.add(l); return () => { listeners.delete(l); }; } },
      // Requests carry the dashboard's origin, as a browser would send it.
      fetchImpl: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), origin: ORIGIN } }),
      pollMs: 150,
    };
    return {
      deps, assigned, text: () => container.textContent,
      visit: async (url) => { if (url) { at.href = url; at.hash = new URL(url).hash; } if (root) { const r = root; await act(async () => { r.unmount(); await Promise.resolve(); }); } const next = createRoot(container); root = next; await act(async () => { next.render(createElement(App, { deps })); await Promise.resolve(); }); },
      go: async (hash) => { at.hash = hash; at.href = `${ORIGIN}/${hash}`; await act(async () => { for (const l of listeners) l(); await Promise.resolve(); }); },
    };
  };
  const until = async (probe: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 200; i += 1) { await h.temporal?.dispatch(); await act(async () => { await new Promise((r) => setTimeout(r, 50)); }); if (probe()) return; }
    throw new Error(`timed out waiting for ${what}; page shows: ${dom.window.document.body.textContent.slice(0, 300)}`);
  };
  const button = (label: string): HTMLButtonElement => { const b = [...dom.window.document.querySelectorAll('button')].find((x) => x.textContent === label); if (!b) throw new Error(`no "${label}" button`); return b; };
  const click = (el: { click: () => void }): Promise<void> => act(async () => { el.click(); await Promise.resolve(); });
  // Types into a controlled React field: set the DOM value through the prototype setter (so React
  // sees a change), then fire the input event.
  const type = (el: Element, value: string): Promise<void> => act(async () => {
    const proto = el.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked with .call on the element below
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  // Signs in through the issuer the way a person would: follow the redirect, pick an account, come back.
  const signIn = async (tab: Tab, who: SystemUser, startAt = ''): Promise<void> => {
    await tab.visit(`${ORIGIN}/${startAt}`);
    expect(tab.text()).toContain('Sign in to see your work');
    await click(button('Sign in'));
    await until(() => tab.assigned.length > 0, 'the redirect to the login provider');
    const authorize = new URL(tab.assigned.at(-1) ?? '');
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${h.issuer.issuer}/authorize`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const picker = await (await fetch(authorize)).text();
    expect(picker).toContain(who.name);
    authorize.searchParams.set('login_hint', who.subject);
    const back = (await fetch(authorize, { redirect: 'manual' })).headers.get('location') ?? '';
    expect(back.startsWith(`${ORIGIN}/?code=`)).toBe(true);
    await tab.visit(back);
    await until(() => tab.text().includes('Sign out'), 'the signed-in app');
  };

  it('a reviewer signs in, is sent to what waits on them, approves a plan in the app, and the developer sees it finish', async () => {
    const taskId = await createTask(h, dana, { title: 'Why do refunds double-post?' });
    const decision = await pendingDecision(h, dana, taskId);
    await waitStatus(h, dana, taskId, ['waiting_decision']);

    const tab = newTab();
    await signIn(tab, riley, '#/inbox'); // started on the inbox: sign-in returns there
    expect(tab.deps.location.href).toBe(`${ORIGIN}/#/inbox`); // the code is gone from the address bar
    await until(() => tab.text().includes('1 waiting on you.'), 'the inbox');
    const nav = [...dom.window.document.querySelectorAll('nav a')].map((a) => a.textContent);
    expect(nav).toEqual(['My work', 'Inbox1 waiting on you', 'Projects', 'Budget']); // the count sits on the inbox link; the bar replaced the sidebar, so projects are listed on their own page
    expect(dom.window.document.querySelector('nav a[aria-current="page"]')?.textContent).toBe('Inbox1 waiting on you');
    expect(tab.text()).toContain('Riley');
    // The inbox says which task, which project and who is asking, in words.
    await until(() => tab.text().includes('Why do refunds double-post?') && tab.text().includes('Dana') && tab.text().includes('Asked by'), 'the inbox item context');
    expect(tab.text()).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no raw timestamps
    expect(tab.text()).not.toContain('plan_review');

    // My work says the same thing first.
    await tab.go('#/work');
    await until(() => tab.text().includes('Dana is blocked on you'), 'my work');
    expect([...dom.window.document.querySelectorAll('tr.first a.key')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['Review now', `#/decisions/${decision.id}`]]);
    // The line draws the stations of the task's plan, with the gate marked and Riley's row number on it.
    expect([...dom.window.document.querySelectorAll('ol.line > li .name')].map((n) => n.textContent)).toEqual(['Scope', 'Plan', 'Plan review', 'Investigate', 'Evidence review', 'Deliver', 'Close']);
    expect(dom.window.document.querySelector('ol.line > li.gate .name')?.textContent).toBe('Plan review');
    expect(dom.window.document.querySelector('ol.line > li.gate .tok.amber')?.textContent).toBe('1, blocked on you');

    // Review and answer: approval without every section is refused in place.
    await tab.go(`#/decisions/${decision.id}`);
    await until(() => tab.text().includes('Sections of the plan'), 'the decision page');
    const boxes = [...dom.window.document.querySelectorAll('input[type="checkbox"]')] as unknown as HTMLInputElement[];
    expect(boxes).toHaveLength(12);
    expect(boxes.every((b) => !b.checked)).toBe(true); // never pre-ticked
    const reason = dom.window.document.querySelector('textarea');
    if (!reason) throw new Error('no reason field');
    await type(reason, 'Read in full; the plan covers the retry path.');
    await click(boxes[0] as HTMLInputElement);
    expect(tab.text()).toContain('1 of 12 read');
    expect([...dom.window.document.querySelectorAll('ol.line > li')].map((li) => li.getAttribute('data-state'))).toEqual(['done', 'done', 'current', 'pending', 'pending', 'pending', 'pending']); // the task's own line heads the review
    await click(button('Approve plan'));
    expect(tab.text()).toContain('Approval needs every section reviewed');
    expect((await h.call(riley, 'GET', `/v2/decisions/${decision.id}`)).body).toMatchObject({ state: 'pending' });
    for (const b of boxes.slice(1)) await click(b);
    expect(tab.text()).toContain('12 of 12 read');
    await click(button('Approve plan'));
    await until(() => tab.text().includes('Your answer was sent.'), 'the confirmation');
    await until(() => tab.text().includes('Nothing is waiting on you') || !dom.window.document.querySelector('nav .count'), 'the inbox count to clear');

    // The developer's own tab: same app, their view. The task finishes while they watch.
    const mine = newTab();
    await signIn(mine, dana, `#/tasks/${taskId}`);
    await until(() => mine.text().includes('Status: succeeded'), 'the task to finish');
    expect(mine.text()).toContain('Why do refunds double-post?');
    expect(mine.text()).toContain('Outcome recorded');
    expect(mine.text()).toContain('7 of 7 stages done');
    expect([...dom.window.document.querySelectorAll('ol.line li')].map((li) => li.getAttribute('data-state'))).toEqual(Array(7).fill('done'));
    expect(dom.window.document.querySelector('form[aria-label="Task actions"]')).toBeNull(); // nothing to do to a finished task
    await mine.go('#/projects');
    await until(() => mine.text().includes('Orders API'), 'the project list');
    await mine.go(`#/projects/${h.applicationId}`);
    await until(() => dom.window.document.querySelector('[data-column="done"] .count-pill')?.textContent === '1', 'the board');
    expect(dom.window.document.querySelector('[data-column="done"] .card-title')?.textContent).toBe('Why do refunds double-post?');
    await mine.go('#/budget');
    await until(() => mine.text().includes('No monthly allowance is set for you.'), 'the budget page');
    expect((await getTask(h, dana, taskId)).status).toBe('succeeded');
  }, 180_000);

  it('a developer pauses and cancels from the task page, with a reason, through ordinary commands', async () => {
    const taskId = await createTask(h, dana, { title: 'Trace the slow export' });
    await waitStatus(h, dana, taskId, ['waiting_decision']);
    const tab = newTab();
    await signIn(tab, dana, `#/tasks/${taskId}`);
    await until(() => tab.text().includes('Waiting on Riley to review the plan'), 'the task page');
    expect([...dom.window.document.querySelectorAll('ol.line li')].map((li) => li.getAttribute('data-state'))).toEqual(['done', 'done', 'current', 'pending', 'pending', 'pending', 'pending']);
    expect(button('Pause').disabled).toBe(true); // no reason yet
    const reason = dom.window.document.querySelector('form[aria-label="Task actions"] input');
    if (!reason) throw new Error('no reason field');
    await type(reason, 'No longer needed');
    await click(button('Cancel task'));
    await until(() => tab.text().includes('Status: cancelled'), 'the cancellation');
    const commands = await h.tx(async (t) => (await t.query<{ kind: string; principal_id: string; state: string; payload: { reason: string } }>('SELECT kind, principal_id, state, payload FROM factory.command WHERE task_id = $1', [taskId])).rows);
    expect(commands).toEqual([{ kind: 'cancel', principal_id: dana.principalId, state: 'applied', payload: expect.objectContaining({ reason: 'No longer needed' }) as unknown }]);
  }, 120_000);

  it('a forged or replayed sign-in response is refused, an expired session asks to sign in again, and unknown pages say so', async () => {
    const tab = newTab();
    await tab.visit(`${ORIGIN}/?code=${randomUUID()}&state=not-mine`);
    await until(() => tab.text().includes('does not belong to a sign-in started in this tab'), 'the refusal');
    expect(tab.text()).not.toContain('Sign out');

    const signedIn = newTab();
    await signIn(signedIn, dana);
    await signedIn.go('#/nowhere/at/all');
    await until(() => signedIn.text().includes('There is no such page.'), 'the not-found page');
    await signedIn.go(`#/projects/${randomUUID()}`);
    await until(() => signedIn.text().includes('does not exist, or you do not have access to it'), 'the inaccessible project');
    // The token stops being accepted (here: replaced by one the API rejects).
    signedIn.deps.storage.setItem('factory.session', JSON.stringify({ accessToken: 'not-a-token', expiresAt: Date.now() + 3_600_000 }));
    await signedIn.visit(`${ORIGIN}/#/work`);
    await until(() => signedIn.text().includes('Your session ended. Sign in again to continue.'), 'the sign-in prompt');
    expect(signedIn.deps.storage.getItem('factory.session')).toBeNull();
  }, 120_000);
});
