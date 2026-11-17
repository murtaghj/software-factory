// Wording for people. The API speaks in codes, ISO timestamps and micro-dollars; nothing in the pane
// should. Every code has a label here, and an unknown code is still turned into plain words.
import { label } from '@factory/client';

export type Tone = 'neutral' | 'active' | 'waiting' | 'success' | 'warning' | 'danger';

export const STATUS: Record<string, { label: string; tone: Tone }> = {
  accepted: { label: 'Accepted', tone: 'neutral' }, queued: { label: 'Queued', tone: 'neutral' }, running: { label: 'Running', tone: 'active' },
  waiting_input: { label: 'Needs input', tone: 'waiting' }, waiting_decision: { label: 'Waiting for review', tone: 'waiting' }, paused: { label: 'Paused', tone: 'waiting' },
  cancelling: { label: 'Cancelling', tone: 'warning' }, succeeded: { label: 'Done', tone: 'success' }, incomplete: { label: 'Stopped early', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};
export { label, relativeTime, timeLeft, usd } from '@factory/client';
export const statusOf = (status: string): { label: string; tone: Tone } => STATUS[status] ?? { label: label(status), tone: 'neutral' };

// A full, unambiguous time for tooltips and <time> titles.
export function fullTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
// "Dana (developer)" -> "Dana": the short name used on cards.
export function shortName(name: string): string {
  const cut = name.indexOf('(');
  return (cut > 0 ? name.slice(0, cut) : name).trim();
}

// What a decision asks of the person, in plain words ("Approve the plan"); the client's labels are for buttons.
const ASKED: Record<string, string> = { approve_plan: 'Approve the plan', confirm_intent: 'Confirm the intent', approve_rule_exception: 'Approve a rule exception' };
export const askOf = (action: string): string => ASKED[action] ?? label(action);
