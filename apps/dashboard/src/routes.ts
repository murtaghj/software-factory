// Hash routes of the single pane. Every place a person needs is one of these; nothing links out to
// another tool for factory state.
export type Route =
  | { page: 'work' } | { page: 'inbox' } | { page: 'projects' } | { page: 'budget' }
  | { page: 'project'; applicationId: string } | { page: 'task'; taskId: string } | { page: 'decision'; decisionId: string }
  | { page: 'not_found' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter((p) => p.length > 0);
  const [a, b] = parts;
  if (parts.length === 0 || (a === 'work' && parts.length === 1)) return { page: 'work' };
  if (parts.length === 1 && (a === 'inbox' || a === 'projects' || a === 'budget')) return { page: a };
  if (parts.length === 2 && b !== undefined && UUID.test(b)) {
    if (a === 'projects') return { page: 'project', applicationId: b };
    if (a === 'tasks') return { page: 'task', taskId: b };
    if (a === 'decisions') return { page: 'decision', decisionId: b };
  }
  return { page: 'not_found' };
}
export const href = {
  work: '#/work', inbox: '#/inbox', projects: '#/projects', budget: '#/budget',
  project: (id: string): string => `#/projects/${id}`, task: (id: string): string => `#/tasks/${id}`, decision: (id: string): string => `#/decisions/${id}`,
};
export const NAV: Array<{ label: string; href: string; pages: Array<Route['page']> }> = [
  { label: 'My work', href: href.work, pages: ['work'] },
  { label: 'Inbox', href: href.inbox, pages: ['inbox', 'decision'] },
  { label: 'Projects', href: href.projects, pages: ['projects', 'project'] },
  { label: 'Budget', href: href.budget, pages: ['budget'] },
];
