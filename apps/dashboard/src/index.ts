// @factory/dashboard — task, review, environment and application views (W-014: task/stage/gate).
export * from './sse.ts';
export * from './store.ts';
export * from './stream.ts';
export * from './view-model.ts';
export { EXPIRES_SOON_MS, INBOX_PATH, PLAN_SECTION_IDS, buildDecisionResponse, fetchInbox, inboxModel, type BuiltResponse, type InboxItem, type InboxModel, type ResponseInput } from '@factory/client';
export { TaskDetail, FreshnessBanner, DecisionInbox } from './components.tsx';
