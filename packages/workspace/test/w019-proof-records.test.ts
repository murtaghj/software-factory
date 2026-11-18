// The proof and the quarantine record (W-019): `prepare` outside any transaction, `register` on the caller's, `read` counting only the runner's links.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listLinksByPurpose } from '@factory/database';
import { MAX_RECORD_BYTES, QUARANTINE_RECORD_SCHEMA, QUIESCENCE_PROOF_SCHEMA, WorkspaceError, quarantineRecord, quiescenceProof, type RecordDeps } from '../src/index.ts';
import { RUNNER, createEnv, type Env } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w019_records'); });
afterAll(async () => { await e.close(); });

const deps = (): RecordDeps => ({ db: e.db, artifacts: e.artifacts, runnerIdentity: RUNNER });
const proofBody = (allocationId: string, extra: Record<string, unknown> = {}) => ({ schema: QUIESCENCE_PROOF_SCHEMA, organizationId: e.a.orgId, allocationId, marker: 'x', ...extra });
const qBody = (allocationId: string) => ({ schema: QUARANTINE_RECORD_SCHEMA, organizationId: e.a.orgId, allocationId, marker: 'x' });
const input = (allocationId: string, body: Record<string, unknown>) => ({ orgId: e.a.orgId, taskId: e.a.taskId, allocationId, body });
const links = (purpose: string) => e.db.withTenant({ orgId: e.a.orgId }, (tx) => listLinksByPurpose(tx, e.a.orgId, purpose));
const denials = async (action: string): Promise<number> => Number((await e.db.withTenant({ orgId: e.a.orgId }, async (tx) => (await tx.query<{ n: string }>('SELECT count(*) AS n FROM factory.audit_event WHERE action = $1', [action])).rows[0]))?.n);

describe('quiescence proof and quarantine record: prepare, register, read', () => {
  it('the runner identity prepares, registers once and reads its own record back equal; a second register under the lock answers exists', async () => {
    const id = randomUUID();
    expect((await e.db.withTenant({ orgId: e.a.orgId }, (tx) => quiescenceProof.read(tx, deps(), e.a.orgId, id))).kind).toBe('absent');
    const h = await quiescenceProof.prepare(deps(), RUNNER, input(id, proofBody(id)));
    const first = await e.db.withTenant({ orgId: e.a.orgId }, (tx) => quiescenceProof.register(tx, deps(), h));
    expect(first.kind).toBe('registered');
    const second = await e.db.withTenant({ orgId: e.a.orgId }, (tx) => quiescenceProof.register(tx, deps(), h));
    expect(second).toEqual({ kind: 'exists', ref: first.ref });
    expect(await links(`quiescence_proof/${id}`)).toHaveLength(1);
    const read = await quiescenceProof.readChecked(deps(), e.a.orgId, e.a.taskId, id);
    expect(read.kind).toBe('present');
    expect(read.kind === 'present' && read.body['marker']).toBe('x'); // control: the runner's record is read back equal
  });

  it('prepare refuses any identity but the runner\'s, and the audit row is there although the caller then rolled back its own transaction', async () => {
    const id = randomUUID();
    const before = await denials('workspace.quiescence_proof.prepare');
    await expect(quiescenceProof.prepare(deps(), 'service:worker', input(id, proofBody(id)))).rejects.toMatchObject({ code: 'forbidden' });
    await e.db.withTenant({ orgId: e.a.orgId }, () => Promise.reject(new Error('rolled back'))).catch(() => undefined);
    expect(await denials('workspace.quiescence_proof.prepare')).toBe(before + 1);
    expect(await links(`quiescence_proof/${id}`)).toHaveLength(0);
  });

  it('register on a transaction that rolls back leaves no link; control: the retry registers', async () => {
    const id = randomUUID();
    const h = await quiescenceProof.prepare(deps(), RUNNER, input(id, proofBody(id)));
    await e.db.withTenant({ orgId: e.a.orgId }, async (tx) => { await quiescenceProof.register(tx, deps(), h); throw new Error('rollback'); }).catch(() => undefined);
    expect(await links(`quiescence_proof/${id}`)).toHaveLength(0);
    expect((await e.db.withTenant({ orgId: e.a.orgId }, (tx) => quiescenceProof.register(tx, deps(), h))).kind).toBe('registered');
  });

  it('the reader ignores a link another producer wrote and a body that names another allocation; two runner-produced links are a hard error', async () => {
    const id = randomUUID();
    // Another producer, same purpose: not the runner's, so absent.
    const body = Buffer.from(JSON.stringify(proofBody(id)));
    const object = await e.artifacts.putControllerObject(e.a.orgId, body);
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => e.artifacts.registerControllerArtifact(tx, { orgId: e.a.orgId, taskId: e.a.taskId, producerId: 'service:intruder', object, mediaType: 'application/json', schemaVersion: '1.0', classification: 'ordinary', purpose: `quiescence_proof/${id}` }));
    expect((await e.db.withTenant({ orgId: e.a.orgId }, (tx) => quiescenceProof.read(tx, deps(), e.a.orgId, id))).kind).toBe('absent');
    // The runner's link whose body names another allocation (a mis-registration): readChecked treats it as absent.
    const other = randomUUID();
    const wrong = await e.artifacts.putControllerObject(e.a.orgId, Buffer.from(JSON.stringify(proofBody(other))));
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => e.artifacts.registerControllerArtifact(tx, { orgId: e.a.orgId, taskId: e.a.taskId, producerId: RUNNER, object: wrong, mediaType: 'application/json', schemaVersion: '1.0', classification: 'ordinary', purpose: `quiescence_proof/${id}` }));
    expect((await quiescenceProof.readChecked(deps(), e.a.orgId, e.a.taskId, id)).kind).toBe('absent');
    expect((await e.db.withTenant({ orgId: e.a.orgId }, (tx) => quiescenceProof.read(tx, deps(), e.a.orgId, id))).kind).toBe('present'); // control: the link itself is the runner's
    // A second runner-produced link: the lock was bypassed.
    const second = await e.artifacts.putControllerObject(e.a.orgId, Buffer.from(JSON.stringify(proofBody(id, { marker: 'y' }))));
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => e.artifacts.registerControllerArtifact(tx, { orgId: e.a.orgId, taskId: e.a.taskId, producerId: RUNNER, object: second, mediaType: 'application/json', schemaVersion: '1.0', classification: 'ordinary', purpose: `quiescence_proof/${id}` }));
    await expect(e.db.withTenant({ orgId: e.a.orgId }, (tx) => quiescenceProof.read(tx, deps(), e.a.orgId, id))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a body over 64 KiB, a body for another allocation and a body with no schema are refused; control: a body just under the cap is accepted', async () => {
    const id = randomUUID();
    await expect(quiescenceProof.prepare(deps(), RUNNER, input(id, proofBody(id, { pad: 'x'.repeat(MAX_RECORD_BYTES) })))).rejects.toBeInstanceOf(WorkspaceError);
    await expect(quiescenceProof.prepare(deps(), RUNNER, input(id, proofBody(randomUUID())))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(quiescenceProof.prepare(deps(), RUNNER, input(id, { ...proofBody(id), schema: 'something-else/1' }))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(quiescenceProof.prepare(deps(), RUNNER, input(id, proofBody(id, { pad: 'x'.repeat(MAX_RECORD_BYTES - 400) })))).resolves.toBeDefined();
  });

  it('a handle cannot be built outside the module: a hand-made object, or one kind\'s handle given to the other, is refused', async () => {
    const id = randomUUID();
    const real = await quiescenceProof.prepare(deps(), RUNNER, input(id, proofBody(id)));
    const forged = { ...real };
    await expect(e.db.withTenant({ orgId: e.a.orgId }, (tx) => quiescenceProof.register(tx, deps(), forged))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(e.db.withTenant({ orgId: e.a.orgId }, (tx) => quarantineRecord.register(tx, deps(), real))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(Object.isFrozen(real)).toBe(true);
    expect((await e.db.withTenant({ orgId: e.a.orgId }, (tx) => quiescenceProof.register(tx, deps(), real))).kind).toBe('registered'); // control
  });

  it('the same functions for the quarantine record, which is restricted', async () => {
    const id = randomUUID();
    await expect(quarantineRecord.prepare(deps(), 'service:worker', input(id, qBody(id)))).rejects.toMatchObject({ code: 'forbidden' });
    const h = await quarantineRecord.prepare(deps(), RUNNER, input(id, qBody(id)));
    expect((await e.db.withTenant({ orgId: e.a.orgId }, (tx) => quarantineRecord.register(tx, deps(), h))).kind).toBe('registered');
    expect((await e.db.withTenant({ orgId: e.a.orgId }, (tx) => quarantineRecord.register(tx, deps(), h))).kind).toBe('exists');
    expect((await links(`quarantine_record/${id}`))[0]?.classification).toBe('restricted');
    expect((await quarantineRecord.readChecked(deps(), e.a.orgId, e.a.taskId, id)).kind).toBe('present');
  });
});
