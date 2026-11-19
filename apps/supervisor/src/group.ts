// The one place a negative pid is used. `process.kill(-1)` would signal every process of the session (under the fake kubelet, the developer's own), so the
// group id must be a real child's pid, above 1; a lint rule forbids a negative pid anywhere else.
export function killGroup(pgid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new RangeError('a process group id is a child pid above 1');
  try { process.kill(-pgid, signal); return true; } catch { return false; }
}
export function groupAlive(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}
