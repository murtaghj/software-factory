import type { QueueAdapter } from '../types.ts';
import { budgetAdapter } from './budget.ts';
import { decisionsAdapter } from './decisions.ts';
import { tasksAdapter } from './tasks.ts';

// Registration order is the tiebreak for the same item from two sources.
export const factoryAdapters = (): QueueAdapter[] => [decisionsAdapter, tasksAdapter, budgetAdapter];
