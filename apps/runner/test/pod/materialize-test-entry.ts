// The test image's entry (A-31, standing in for INT-02 and W-021): the same logic as the production entry, plus the
// fixture repository over file://. It is copied only into the test image and used by the fake tier's kubelet.
// FACTORY_TEST_VOLUME, FACTORY_TEST_GIT_BINARY and TERMINATION_MESSAGE_PATH exist so that a test can point the init step at a temporary
// directory and gate Git; the production entry reads neither.
import { GitRunner } from '@factory/workspace/pod';
import { runProcess } from '../../src/pod/materialize-run.ts';

const binary = process.env['FACTORY_TEST_GIT_BINARY'];
await runProcess({
  volume: process.env['FACTORY_TEST_VOLUME'] ?? '/workspace', allowFileRemote: true, allowFileTransport: true,
  ...(process.env['TERMINATION_MESSAGE_PATH'] === undefined ? {} : { messagePath: process.env['TERMINATION_MESSAGE_PATH'] }),
  ...(binary === undefined ? {} : { git: new GitRunner({ binary, allowFileTransport: true }) }),
});
