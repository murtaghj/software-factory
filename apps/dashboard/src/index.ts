// @factory/dashboard — task, review, environment and application views (W-014: task/stage/gate).
export * from './sse.ts';
export * from './store.ts';
export * from './stream.ts';
export * from './view-model.ts';
export { EXPIRES_SOON_MS, INBOX_PATH, PLAN_SECTION_IDS, buildDecisionResponse, fetchInbox, inboxModel, type BuiltResponse, type InboxItem, type InboxModel, type ResponseInput } from '@factory/client';
export { BOARD_COLUMNS, COLUMN_LABELS, DISMISS_LABEL, QUEUE_ACK_PATH, QUEUE_PATH, actionOf, degradedNote, needLabel, parseQueue, queueHeadline, reasonOf, reasonText, rulesText, sourceLabel, type Board, type MyWork, type Queue, type QueueItem, type TaskCard } from '@factory/client';
export { TaskDetail, FreshnessBanner, DecisionInbox, BoardView, QueueView, type QueueLinks } from './components.tsx';
export * from './auth.ts';
export * from './routes.ts';
export * from './shell.tsx';
export { App, type AppConfig, type AppDeps } from './app.tsx';
