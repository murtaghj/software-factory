export type RunnerErrorCode =
  | 'forbidden' | 'invalid_request' | 'conflict' | 'unknown_stage_run' | 'task_not_running' | 'stage_run_not_current' | 'run_cancelled'
  | 'budget_not_reserved' | 'budget_settled' | 'workspace_unavailable' | 'generation_limit' | 'restore_unavailable' | 'capacity_unavailable'
  | 'limits_exceed_cap' | 'allocation_contended' | 'stage_run_busy' | 'workspace_busy' | 'allocation_live' | 'not_supported' | 'not_found' | 'cancel_record_conflict';

const RETRYABLE: ReadonlySet<RunnerErrorCode> = new Set(['allocation_contended', 'stage_run_busy', 'workspace_busy', 'allocation_live']);

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: RunnerErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.details = details;
  }
}
