// The production entry of the `materialize` init container (W-017, 17b): https remotes only. The `file` transport
// exists only in the test image's own entry (A-31); nothing about this process can be switched into it by an
// argument or an environment variable.
import { runProcess } from './materialize-run.ts';

await runProcess({ volume: '/workspace', allowFileRemote: false });
