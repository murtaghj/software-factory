// Plain words for the API's codes, shared by every client (dashboard, CLI, agent tool). An unknown
// code is still turned into words rather than shown raw.
const LABELS: Record<string, string> = {
  // stages
  scope: 'Scope', plan: 'Plan', plan_review: 'Plan review', investigate: 'Investigate', evidence_review: 'Evidence review', deliver: 'Deliver', close: 'Close',
  // gates
  scope_accepted: 'Scope accepted', plan_peer_approved: 'Plan approved by a peer', review_passed: 'Independent review passed', outcome_recorded: 'Outcome recorded',
  // why something is waiting or stopped
  budget_exhausted: 'It ran out of budget', decision_expired: 'The review request expired', plan_rejected: 'The plan was rejected',
  // gate reasons
  criteria_mapped: 'Every criterion is covered', no_blocking_gaps: 'No blocking gaps', exact_subject_peer_approval: 'Approved by the assigned reviewer', no_blocking_findings: 'No blocking findings',
  criteria_unmapped: 'Some criteria are not covered', blocking_context_gap: 'Missing context blocks the work', reviewer_not_independent: 'The reviewer was not independent', unresolved_blocking_findings: 'Blocking findings are unresolved',
  decider_authority_revoked: 'The reviewer no longer has authority', no_eligible_independent_reviewer: 'No independent reviewer is available', plan_revised: 'The plan changed',
  // plan sections
  intent_scope: 'Intent and scope', current_state: 'Current state', design: 'Design', interfaces_data: 'Interfaces and data', implementation: 'Implementation', acceptance_tests: 'Acceptance tests',
  quality_security: 'Quality and security', delivery_recovery: 'Delivery and recovery', operations: 'Operations', risks_decisions: 'Risks and decisions', definition_of_done: 'Definition of done', review_ownership: 'Review and ownership',
};
export function label(code: string | undefined): string {
  if (!code) return '';
  const known = LABELS[code];
  if (known) return known;
  const words = code.replaceAll('_', ' ').replaceAll('-', ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const STEPS: Array<{ size: number; name: string }> = [{ size: 60, name: 'second' }, { size: 60, name: 'minute' }, { size: 24, name: 'hour' }, { size: 7, name: 'day' }, { size: 4.345, name: 'week' }, { size: 12, name: 'month' }, { size: Number.POSITIVE_INFINITY, name: 'year' }];
// "in 2 days", "3 minutes ago", "just now". Rounded down, so "in 2 days" never overstates.
export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  let amount = Math.abs(then - nowMs) / 1000;
  if (amount < 45) return then >= nowMs ? 'in a moment' : 'just now';
  let unit = 'second';
  for (const step of STEPS) {
    unit = step.name;
    if (amount < step.size) break;
    amount = amount / step.size;
  }
  const whole = Math.max(1, Math.floor(amount));
  const text = `${String(whole)} ${unit}${whole === 1 ? '' : 's'}`;
  return then >= nowMs ? `in ${text}` : `${text} ago`;
}

// "2 days left", or "Expired": how long a deadline has, in the same rounding as relativeTime. It is a
// phrase for a table cell; a sentence handles expiry itself (see reasonText).
export function timeLeft(iso: string, nowMs: number): string {
  const t = relativeTime(iso, nowMs);
  if (t === '') return '';
  if (t === 'just now' || t.endsWith(' ago')) return 'Expired';
  return `${t.slice('in '.length)} left`;
}

// "$12.34", from micro-dollars. Whole thousands are grouped.
export function usd(micro: number | undefined): string {
  return `$${((micro ?? 0) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
