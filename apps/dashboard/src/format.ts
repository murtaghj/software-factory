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
export { label, relativeTime } from '@factory/client';
export const statusOf = (status: string): { label: string; tone: Tone } => STATUS[status] ?? { label: label(status), tone: 'neutral' };

// A full, unambiguous time for tooltips and <time> titles.
export function fullTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
export function usd(micro: number | undefined): string {
  return `$${((micro ?? 0) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
// "Dana (developer)" -> "Dana": the short name used on cards.
export function shortName(name: string): string {
  const cut = name.indexOf('(');
  return (cut > 0 ? name.slice(0, cut) : name).trim();
}
export function initials(name: string): string {
  const parts = shortName(name).split(' ').filter((p) => p.length > 0);
  const first = parts[0] ?? '?';
  const last = parts.length >= 2 ? parts[parts.length - 1] ?? '' : '';
  return (last ? `${first.charAt(0)}${last.charAt(0)}` : first.slice(0, 2)).toUpperCase();
}
// A stable colour per person, from their name, so the same person looks the same everywhere.
export function hueOf(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + (c.codePointAt(0) ?? 0)) % 360;
  return h;
}
