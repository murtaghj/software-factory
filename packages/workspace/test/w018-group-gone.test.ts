// groupGone: only ESRCH means a process group is gone. On macOS a group whose only members are exited children
// that nobody has reaped answers kill(-pgid, 0) with EPERM; under load that used to make a successful Git call
// fail as "group did not exit" and a push come back as outcome unknown.
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { groupGone } from '../src/git.ts';

// The leader (A) exits at once and is reaped by Node. B, A's child, leaves the group and lingers for `lingerS` seconds.
// C, B's child, stays in the group, exits after 0.3 s and becomes a zombie of B: the group then holds an unreaped
// zombie and nothing else, until B exits and C is reparented and reaped.
const SCRIPT = `
import os, sys, time
b = os.fork()
if b == 0:
    c = os.fork()
    if c == 0:
        time.sleep(0.3); os._exit(0)
    os.setpgid(0, 0)
    time.sleep(float(sys.argv[1])); os._exit(0)
os._exit(0)
`;

async function zombieGroup(lingerS: number): Promise<number> {
  const child = spawn('python3', ['-I', '-c', SCRIPT, String(lingerS)], { detached: true, stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise<void>((r) => child.on('exit', () => { r(); }));
  return pid;
}
const probe = (pgid: number): string => { try { process.kill(-pgid, 0); return 'alive'; } catch (e) { return (e as NodeJS.ErrnoException).code ?? 'error'; } };

describe('groupGone', () => {
  it('waits through a group that holds only an unreaped zombie and is gone once the zombie is reaped; ESRCH alone ends the wait', async () => {
    const g = await zombieGroup(2.5);
    await new Promise((r) => setTimeout(r, 900)); // C has exited and is B's zombie; B still lives, in its own group
    // The trap, as this platform shows it: the group is not reported gone (EPERM on macOS, success on Linux), never ESRCH.
    expect(['EPERM', 'alive']).toContain(probe(g));
    const t0 = performance.now();
    expect(await groupGone(g)).toBe(true); // keeps polling through EPERM, and returns true when B exits and the zombie goes
    expect(performance.now() - t0).toBeGreaterThan(500); // it really waited for the reap
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(probe(g)).toBe('ESRCH');
  }, 20_000);

  it('fails closed: a group that never goes is reported not gone at the deadline, an unknown pid is ESRCH, and no pid is trivially gone', async () => {
    const g = await zombieGroup(4);
    await new Promise((r) => setTimeout(r, 900));
    expect(await groupGone(g, 300)).toBe(false); // the zombie is still there at the deadline
    expect(await groupGone(g, 8000)).toBe(true); // control: given time it goes
    expect(await groupGone(2 ** 30)).toBe(true); // no such group: ESRCH
    expect(await groupGone(undefined)).toBe(true);
  }, 20_000);
});
