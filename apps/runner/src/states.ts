// The allocation state machine: one edge table. Every pair not listed is refused (section 5).
import type { AllocationState } from '@factory/database';
import type { ServiceInterfaces } from '@factory/contracts';

export type RunHandle = ServiceInterfaces.RunHandle;

type Edge = readonly [AllocationState | 'none', AllocationState];
export const EDGES: readonly Edge[] = [
  ['none', 'desired'],
  ['desired', 'starting'],
  ['desired', 'quarantined'], ['starting', 'quarantined'],
  ['starting', 'running'],
  ['running', 'suspect'], ['suspect', 'running'],
  ['desired', 'stopping'], ['starting', 'stopping'], ['running', 'stopping'], ['suspect', 'stopping'],
  ['stopping', 'terminated'], ['stopping', 'quarantined'],
  ['running', 'finalizing'],
  ['finalizing', 'completed'], ['finalizing', 'stopping'], ['finalizing', 'quarantined'],
];

export const isLegalEdge = (from: AllocationState | 'none', to: AllocationState): boolean => EDGES.some(([f, t]) => f === from && t === to);
export function assertEdge(from: AllocationState | 'none', to: AllocationState): void {
  if (!isLegalEdge(from, to)) throw new Error(`illegal allocation transition ${from} -> ${to}`);
}
export const sourcesOf = (to: AllocationState): AllocationState[] => EDGES.filter(([f, t]) => t === to && f !== 'none').map(([f]) => f as AllocationState);

// A state in which the allocation still counts against `one_active_allocation`.
export const LIVE_STATES: readonly AllocationState[] = ['desired', 'starting', 'running', 'suspect', 'stopping', 'finalizing'];
export const isLive = (s: AllocationState): boolean => LIVE_STATES.includes(s);

// SI-14: RunHandle.state has six values and the allocation has nine.
export function handleState(state: AllocationState, cancelled: boolean): RunHandle['state'] {
  switch (state) {
    case 'desired': case 'starting': return 'accepted';
    case 'running': return 'running';
    case 'suspect': case 'stopping': case 'quarantined': return 'reconciling';
    case 'finalizing': return 'finalizing';
    case 'completed': return 'completed';
    case 'terminated': return cancelled ? 'cancelled' : 'reconciling';
  }
}
