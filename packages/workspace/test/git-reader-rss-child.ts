// Runs snapshot and exportPack on one candidate and reports the peak resident memory of this process (W-020a, the memory test).
import { openCandidate } from '../src/git-reader/index.ts';

const args = JSON.parse(process.argv[2] ?? '{}') as { mount: string; orgId: string; workspaceId: string; generation: number; out: string };
const reader = openCandidate(Buffer.from(args.mount), { orgId: args.orgId, workspaceId: args.workspaceId, generation: args.generation });
try {
  const s = await reader.snapshot();
  const e = await reader.exportPack(args.out);
  process.stdout.write(JSON.stringify({ ok: true, maxRssKb: process.resourceUsage().maxRSS, files: s.counts.committedFiles, objects: e.objects, bytes: e.bytes }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e) }));
} finally { reader.close(); }
