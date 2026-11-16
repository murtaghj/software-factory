// @factory/client — the API client and client-side decision logic shared by the dashboard, the CLI
// and the MCP server. Browser-safe: no Node built-ins. It holds no rules of its own; the API and
// the workflow decide.
export * from './http.ts';
export * from './inbox.ts';
export * from './queue.ts';
export * from './work.ts';
export * from './wording.ts';
