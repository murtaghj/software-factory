// The supervisor's process exit codes (section 6, "The supervisor"). One table, so a test can show there is no duplicate
// and so the runner's tests and the supervisor read the same numbers.
export const SUPERVISOR_EXIT = {
  ok: 0,
  bad_arguments: 64,        // boot: arguments, runner URL or CA file refused
  duplicate_writer: 65,     // acquire: another pod holds the permit
  denied: 66,               // acquire: any other final denial
  gate_failed: 68,          // gating: a deny target accepted, or the listener never answered, within the bound
  workspace_unreadable: 69, // preparing: the workspace view failed
  fenced: 70,               // running: lease lost or no renewal confirmed by the fence time
  terminated: 143,          // TERM in any state but ending
} as const;
export type SupervisorExit = keyof typeof SUPERVISOR_EXIT;
