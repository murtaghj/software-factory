// The termination-message parser and the receipt rules (hostile input). Statuses are injected through the fake.
import { describe, expect, it } from 'vitest';
import type { KubePod } from '../src/index.ts';
import { MAX_MESSAGE_BYTES, encodeReceiptMessage, encodeRefusalMessage, parseMaterializeStatus } from '../src/index.ts';
import { FakeKube } from '../src/testing.ts';
import { receiptStatusFor } from './pods.ts';

const RECEIPT = { generation: 1, headCommit: 'c'.repeat(40), treeDigest: 'ab'.repeat(32), gitVersion: 'git version 2.50.1 (Apple Git-155)' };
const GOOD = encodeReceiptMessage(RECEIPT);
const status = (message: string | undefined, exitCode: number, name = 'materialize'): ReturnType<typeof parseMaterializeStatus> =>
  parseMaterializeStatus({ status: { phase: 'Running', initContainerStatuses: [{ name, state: { terminated: { exitCode, ...(message === undefined ? {} : { message }) } } }] } });

describe('W-017 receipt rules', () => {
  it('control: the well-formed receipt with exit 0 is accepted, and so is a well-formed refusal with a non-zero exit', () => {
    expect(status(GOOD, 0)).toEqual({ kind: 'receipt', receipt: RECEIPT });
    expect(status(`${GOOD}\n`, 0)).toEqual({ kind: 'receipt', receipt: RECEIPT }); // the one line the entry writes may carry its newline
    expect(status(encodeRefusalMessage('target_exists', 'the generation directory already exists'), 1)).toMatchObject({ kind: 'refusal', code: 'target_exists' });
  });

  it('too long, not JSON, extra keys, missing keys and wrong shapes are refused', () => {
    expect(status(GOOD + ' '.repeat(MAX_MESSAGE_BYTES), 0)).toEqual({ kind: 'invalid', reason: 'too_long' });
    expect(status('x'.repeat(MAX_MESSAGE_BYTES + 1), 1)).toEqual({ kind: 'invalid', reason: 'too_long' });
    expect(status('fatal: unable to access https://git.example.test/org/repo.git/: 403', 0)).toEqual({ kind: 'invalid', reason: 'not_json' }); // log-like text
    expect(status('cloning into git...\nremote: Enumerating objects: 12', 1)).toEqual({ kind: 'invalid', reason: 'not_json' });
    const extra = JSON.parse(GOOD) as { receipt: Record<string, unknown> };
    extra.receipt['extra'] = 1;
    expect(status(JSON.stringify(extra), 0)).toMatchObject({ kind: 'invalid', reason: 'wrong_shape' });
    expect(status(JSON.stringify({ ...JSON.parse(GOOD) as object, extra: true }), 0)).toMatchObject({ kind: 'invalid' });
    for (const bad of ['null', '[]', '1', '"x"', '{}', '{"schema":"factory-pod-materialization/1"}', '{"schema":"other/1","ok":true,"receipt":{}}']) expect(status(bad, 0).kind).toBe('invalid');
  });

  it('wrong generation type, wrong commit or digest shape and an unprintable git version are refused', () => {
    const mut = (f: (r: Record<string, unknown>) => void): string => { const o = JSON.parse(GOOD) as { receipt: Record<string, unknown> }; f(o.receipt); return JSON.stringify(o); };
    expect(status(mut((r) => { r['generation'] = '1'; }), 0).kind).toBe('invalid');
    expect(status(mut((r) => { r['generation'] = 0; }), 0).kind).toBe('invalid');
    expect(status(mut((r) => { r['generation'] = 1.5; }), 0).kind).toBe('invalid');
    expect(status(mut((r) => { r['headCommit'] = 'C'.repeat(40); }), 0).kind).toBe('invalid');
    expect(status(mut((r) => { r['headCommit'] = 'c'.repeat(41); }), 0).kind).toBe('invalid');
    expect(status(mut((r) => { r['treeDigest'] = 'ab'.repeat(31); }), 0).kind).toBe('invalid');
    expect(status(mut((r) => { r['gitVersion'] = 'not git'; }), 0).kind).toBe('invalid');
    expect(status(mut((r) => { r['gitVersion'] = 'git version 2.50\u0007'; }), 0).kind).toBe('invalid');
    expect(status(mut((r) => { r['headCommit'] = 'd'.repeat(64); }), 0).kind).toBe('receipt'); // control: a 64-hex object id is fine
  });

  it('a receipt with exit code 1 and a refusal with exit code 0 are receipt_inconsistent', () => {
    expect(status(GOOD, 1)).toEqual({ kind: 'receipt_inconsistent', exitCode: 1 });
    expect(status(encodeRefusalMessage('commit_not_found', 'no such commit'), 0)).toEqual({ kind: 'receipt_inconsistent', exitCode: 0 });
    expect(status(GOOD, 0).kind).toBe('receipt');
  });

  it('a failed step that wrote only to stderr has an empty message (the File policy), and exit 0 with no message is invalid', () => {
    expect(status(undefined, 1)).toEqual({ kind: 'failed', exitCode: 1 });
    expect(status('', 2)).toEqual({ kind: 'failed', exitCode: 2 });
    expect(status(undefined, 0)).toEqual({ kind: 'invalid', reason: 'not_json' });
  });

  it('text that is JSON but not the canonical text the entry writes (duplicate keys, reordering, whitespace) is refused', () => {
    const dup = GOOD.replace('"ok":true', '"ok":true,"ok":true');
    expect(status(dup, 0).kind).toBe('invalid');
    expect(status(JSON.stringify(JSON.parse(GOOD), null, 1), 0)).toEqual({ kind: 'invalid', reason: 'not_canonical' });
    const forgedOrder = JSON.stringify({ ok: true, schema: 'factory-pod-materialization/1', receipt: RECEIPT });
    expect(status(forgedOrder, 0)).toEqual({ kind: 'invalid', reason: 'not_canonical' });
    expect(status(GOOD.replace('{"schema"', '{"__proto__":{},"schema"'), 0).kind).toBe('invalid');
  });

  it('a message on the harness container that is a perfect receipt is ignored; only the materialize init container is read', () => {
    const forged = { status: { phase: 'Running', initContainerStatuses: [{ name: 'materialize', state: { running: { startedAt: 'x' } } }],
      containerStatuses: [{ name: 'harness', state: { terminated: { exitCode: 0, message: GOOD } } }] } } as Pick<KubePod, 'status'>;
    expect(parseMaterializeStatus(forged)).toEqual({ kind: 'not_finished' });
    // As an init container under another name, it is also ignored.
    expect(status(GOOD, 0, 'harness-init')).toEqual({ kind: 'not_finished' });
    // Two init statuses named materialize are ambiguous, never "the first wins".
    const two = { status: { phase: 'Running', initContainerStatuses: [
      { name: 'materialize', state: { terminated: { exitCode: 0, message: GOOD } } }, { name: 'materialize', state: { terminated: { exitCode: 1 } } }] } } as Pick<KubePod, 'status'>;
    expect(parseMaterializeStatus(two)).toEqual({ kind: 'invalid', reason: 'ambiguous_status' });
    // Control: the same receipt on the materialize container is accepted.
    expect(status(GOOD, 0, 'materialize').kind).toBe('receipt');
  });

  it('through the fake: the kubelet cuts a long message at 4,096 bytes and the File policy keeps stderr out of it; the fallback policy (control) lets a log line in', () => {
    const kube = new FakeKube();
    const { pod, driver } = receiptStatusFor(kube);
    driver.initFinished(pod.metadata.name, { exitCode: 1, stderr: 'fatal: Authentication failed for https://token@example.test/' });
    expect(parseMaterializeStatus(kube.pods.get(pod.metadata.name) as KubePod)).toEqual({ kind: 'failed', exitCode: 1 }); // File: no log text arrives as a message
    const fb = receiptStatusFor(kube, 'FallbackToLogsOnError');
    fb.driver.initFinished(fb.pod.metadata.name, { exitCode: 1, stderr: 'fatal: Authentication failed for https://token@example.test/' });
    expect(parseMaterializeStatus(kube.pods.get(fb.pod.metadata.name) as KubePod)).toMatchObject({ kind: 'invalid', reason: 'not_json' }); // the forgery the pinned policy prevents
    expect(kube.pods.get(fb.pod.metadata.name)?.status.initContainerStatuses?.[0]?.state.terminated?.message).toContain('Authentication failed');
    const long = receiptStatusFor(kube);
    long.driver.initFinished(long.pod.metadata.name, { exitCode: 0, message: GOOD + ' '.repeat(5000) });
    const msg = kube.pods.get(long.pod.metadata.name)?.status.initContainerStatuses?.[0]?.state.terminated?.message ?? '';
    expect(Buffer.byteLength(msg)).toBe(4096);
    expect(parseMaterializeStatus(kube.pods.get(long.pod.metadata.name) as KubePod).kind).toBe('invalid');
  });

  it('parsing is linear: a status list far beyond its cap, and a 4 KiB message of nested brackets, are refused quickly', () => {
    const many = { status: { phase: 'Running', initContainerStatuses: Array.from({ length: 200_000 }, (_, i) => ({ name: `c${String(i)}`, state: {} })) } } as Pick<KubePod, 'status'>;
    const t0 = performance.now();
    expect(parseMaterializeStatus(many)).toEqual({ kind: 'not_finished' });
    expect(status('['.repeat(4000), 1).kind).toBe('invalid');
    expect(status(`{"a":${'['.repeat(2000)}${']'.repeat(2000)}}`, 0).kind).toBe('invalid');
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
