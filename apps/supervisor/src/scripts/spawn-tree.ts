// A child in the group, and a grandchild that calls setsid and ignores TERM. The pids go to /tmp/spawn-tree.pids. For the k3s tier: the fake kubelet's group kill
// does not reach a process that left the group.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

process.on('SIGTERM', () => undefined); // the harness itself ignores TERM too
const child = spawn('sleep', ['31001'], { stdio: 'ignore' });
const grand = spawn('setsid', ['sh', '-c', 'trap "" TERM; exec sleep 31002'], { stdio: 'ignore', detached: true });
writeFileSync('/tmp/spawn-tree.pids', `${String(process.pid)} ${String(child.pid)} ${String(grand.pid)}\n`);
setInterval(() => undefined, 1000);
