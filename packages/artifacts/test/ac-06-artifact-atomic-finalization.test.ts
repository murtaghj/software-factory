import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import pg from 'pg';
import { ArtifactError, finalKeyFor } from '../src/index.ts';
import { addStage, createHarness, produce, sha256, type Harness } from './harness.ts';

const doc = (n: number): Buffer => Buffer.from(JSON.stringify({ schemaVersion: '2.0', report: `result ${String(n)}` }));
const gate = (h: Harness) => h.producer(h.a); // a dependent gate evaluator bound to the same task

describe('AC-06 artifact atomic finalization', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness('ac06'); });
  afterAll(async () => { await h.close(); });

  it('a finalized, hash-verified artifact is readable by a dependent gate through its exact ref', async () => {
    const body = doc(1);
    const ref = await (await produce(h, h.service, h.a, body)).finalize();
    expect(ref).toMatchObject({ sha256: sha256(body), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: body.length });
    expect((await h.service.readVerified(gate(h), ref)).equals(body)).toBe(true);
    await expect(h.service.readVerified(gate(h), { ...ref, mediaType: 'text/plain' })).rejects.toMatchObject({ code: 'ref_mismatch' });
    await expect(h.service.readVerified(gate(h), { ...ref, sizeBytes: ref.sizeBytes + 1 })).rejects.toMatchObject({ code: 'ref_mismatch' });
  });

  it('an interrupted upload never becomes an artifact and its temporary object is swept after expiry', async () => {
    const ctx = h.producer(h.a);
    const r = await h.service.reserve(ctx, { taskId: h.a.taskId, stageRunId: h.a.logicalStageId, mediaType: 'application/json', schemaVersion: '2.0', maxBytes: 1000, classification: 'ordinary' });
    async function* interrupted() { yield Buffer.from('{"schemaVersion":"2.0","rep'); await Promise.resolve(); throw new Error('connection reset'); }
    await expect(h.service.upload(r.uploadCapability, interrupted())).rejects.toThrow('connection reset');
    const partial = doc(2);
    await expect(h.service.finalize(ctx, { uploadId: r.uploadId, expectedDigest: sha256(partial), expectedBytes: partial.length, producerId: ctx.actorId })).rejects.toBeInstanceOf(ArtifactError);
    // Nothing registered: a gate holding a guessed ref is refused.
    await expect(h.service.readVerified(gate(h), { artifactId: r.uploadId, sha256: sha256(partial), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: partial.length })).rejects.toMatchObject({ code: 'not_found' });
    // A reservation that was never finished is expired and its temporary key deleted.
    const r2 = await h.service.reserve(ctx, { taskId: h.a.taskId, stageRunId: h.a.logicalStageId, mediaType: 'application/json', schemaVersion: '2.0', maxBytes: 1000, classification: 'ordinary' });
    await h.service.upload(r2.uploadCapability, Buffer.from('{"schemaVersion":"2.0"}'));
    const tempKey = `tmp/${h.a.orgId}/${r2.uploadId}`;
    expect(await h.store.exists(tempKey)).toBe(true);
    h.clock.now += 2 * 60 * 60 * 1000;
    try {
      expect(await h.service.sweepExpiredUploads()).toBeGreaterThanOrEqual(1);
      expect(await h.store.exists(tempKey)).toBe(false);
      await expect(h.service.upload(r2.uploadCapability, Buffer.from('x'))).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      h.clock.now -= 2 * 60 * 60 * 1000;
    }
  });

  it('a crash after promotion but before registration leaves an orphan that no gate accepts; the orphan is swept', async () => {
    const crashing = h.make({ hooks: { afterPromote: () => Promise.reject(new Error('process killed before DB commit')) } });
    const body = doc(3);
    const p = await produce(h, crashing, h.a, body);
    await expect(p.finalize()).rejects.toThrow('process killed before DB commit');
    const key = finalKeyFor(h.a.orgId, sha256(body));
    expect(await h.store.exists(key)).toBe(true); // the object exists...
    // ...but existence without registration satisfies nothing.
    await expect(h.service.readVerified(gate(h), { artifactId: p.reservation.uploadId, sha256: sha256(body), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: body.length })).rejects.toMatchObject({ code: 'not_found' });
    h.clock.now = Date.now() + 1000;
    expect(await h.service.sweepOrphanObjects(0)).toContain(key);
    expect(await h.store.exists(key)).toBe(false);
  });

  it('a retry after the crash re-verifies the existing immutable object and registers it once; the sweep then keeps it', async () => {
    const crashing = h.make({ hooks: { afterPromote: () => Promise.reject(new Error('crash')) } });
    const body = doc(4);
    await expect((await produce(h, crashing, h.a, body)).finalize()).rejects.toThrow('crash');
    const ref = await (await produce(h, h.service, h.a, body)).finalize();
    expect((await h.service.readVerified(gate(h), ref)).equals(body)).toBe(true);
    h.clock.now = Date.now() + 1000;
    expect(await h.service.sweepOrphanObjects(0)).not.toContain(finalKeyFor(h.a.orgId, sha256(body)));
    expect((await h.service.readVerified(gate(h), ref)).equals(body)).toBe(true);
  });

  it('an existing immutable object whose bytes do not match its key is an integrity incident, not a reuse', async () => {
    const body = doc(5);
    const key = finalKeyFor(h.a.orgId, sha256(body));
    mkdirSync(dirname(join(h.storeRoot, key)), { recursive: true });
    writeFileSync(join(h.storeRoot, key), 'forged bytes');
    await expect((await produce(h, h.service, h.a, body)).finalize()).rejects.toMatchObject({ code: 'integrity_incident' });
  });

  it('digest, size, byte-limit and content mismatches are rejected and register nothing', async () => {
    const body = doc(6);
    const ctx = h.producer(h.a);
    const reserve = () => h.service.reserve(ctx, { taskId: h.a.taskId, stageRunId: h.a.logicalStageId, mediaType: 'application/json', schemaVersion: '2.0', maxBytes: 200, classification: 'ordinary' });
    let r = await reserve();
    await h.service.upload(r.uploadCapability, body);
    await expect(h.service.finalize(ctx, { uploadId: r.uploadId, expectedDigest: 'f'.repeat(64), expectedBytes: body.length, producerId: ctx.actorId })).rejects.toMatchObject({ code: 'digest_mismatch' });
    r = await reserve();
    await h.service.upload(r.uploadCapability, body);
    await expect(h.service.finalize(ctx, { uploadId: r.uploadId, expectedDigest: sha256(body), expectedBytes: body.length - 1, producerId: ctx.actorId })).rejects.toMatchObject({ code: 'size_mismatch' });
    r = await reserve();
    await expect(h.service.upload(r.uploadCapability, Buffer.alloc(201, 0x20))).rejects.toMatchObject({ code: 'too_large' });
    r = await reserve();
    const wrongSchema = Buffer.from(JSON.stringify({ schemaVersion: '1.0' }));
    await h.service.upload(r.uploadCapability, wrongSchema);
    await expect(h.service.finalize(ctx, { uploadId: r.uploadId, expectedDigest: sha256(wrongSchema), expectedBytes: wrongSchema.length, producerId: ctx.actorId })).rejects.toMatchObject({ code: 'content_mismatch' });
    r = await reserve();
    const notJson = Buffer.from('<html></html>');
    await h.service.upload(r.uploadCapability, notJson);
    await expect(h.service.finalize(ctx, { uploadId: r.uploadId, expectedDigest: sha256(notJson), expectedBytes: notJson.length, producerId: ctx.actorId })).rejects.toMatchObject({ code: 'content_mismatch' });
    const registered = await h.db.withTenant({ orgId: h.a.orgId }, (tx) => tx.query('SELECT 1 FROM factory.artifact WHERE sha256 = ANY($1)', [[sha256(body), sha256(wrongSchema), sha256(notJson)]]));
    expect(registered.rowCount).toBe(0);
  });

  it('finalization rejects a different producer, an unbound caller and a stage that is no longer active', async () => {
    const stage = await addStage(h.db, h.a, 'review');
    const body = doc(7);
    const p = await produce(h, h.service, stage, body);
    await expect(h.service.finalize({ ...p.ctx, actorId: 'runner:someone-else' }, { uploadId: p.reservation.uploadId, expectedDigest: sha256(body), expectedBytes: body.length, producerId: 'runner:someone-else' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.service.finalize({ ...p.ctx, taskId: h.b.taskId }, { uploadId: p.reservation.uploadId, expectedDigest: sha256(body), expectedBytes: body.length, producerId: p.ctx.actorId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.service.reserve(h.producer(h.a), { taskId: h.b.taskId, stageRunId: h.b.logicalStageId, mediaType: 'application/json', schemaVersion: '2.0', maxBytes: 10, classification: 'ordinary' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.service.reserve(h.human(h.a, h.a.taskId), { taskId: h.a.taskId, stageRunId: h.a.logicalStageId, mediaType: 'application/json', schemaVersion: '2.0', maxBytes: 10, classification: 'ordinary' })).rejects.toMatchObject({ code: 'forbidden' });
    const denials = await h.db.withTenant({ orgId: h.a.orgId }, (tx) => tx.query<{ action: string; resource_id: string }>("SELECT action, resource_id FROM factory.audit_event WHERE outcome = 'denied' AND resource_id = ANY($1)", [[p.reservation.uploadId, h.b.taskId]]));
    expect(denials.rows.map((r) => `${r.action} ${r.resource_id === h.b.taskId ? 'foreign-task' : 'upload'}`).sort()).toEqual(['artifact.finalize upload', 'artifact.finalize upload', 'artifact.reserve foreign-task']);
    await h.db.withTenant({ orgId: h.a.orgId }, (tx) => tx.query("UPDATE factory.stage_run SET status = 'evaluating' WHERE id = $1", [stage.stageRunId]));
    expect(await p.finalize()).toMatchObject({ sha256: sha256(body) }); // evaluating is still active
    const late = await produce(h, h.service, stage, doc(8));
    await h.db.withTenant({ orgId: h.a.orgId }, (tx) => tx.query("UPDATE factory.stage_run SET status = 'passed' WHERE id = $1", [stage.stageRunId]));
    await expect(late.finalize()).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.service.reserve(h.producer(h.a), { taskId: h.a.taskId, stageRunId: stage.logicalStageId, mediaType: 'application/json', schemaVersion: '2.0', maxBytes: 10, classification: 'ordinary' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('owner-scope reservations are closed unless current owner authority is verified', async () => {
    await expect(h.service.reserveOwned(h.human(h.a), { owner: { kind: 'organization_controller', controllerKind: 'emergency_stop' }, mediaType: 'application/json', schemaVersion: '2.0', maxBytes: 10, classification: 'restricted' })).rejects.toMatchObject({ code: 'forbidden' });
    const trusting = h.make({ ownerAuthority: { verify: () => Promise.resolve({ authorityRef: { kind: 'test-operator-grant' } }) } });
    await expect(trusting.reserveOwned(h.producer(h.a), { owner: { kind: 'organization_controller', controllerKind: 'emergency_stop' }, mediaType: 'application/json', schemaVersion: '2.0', maxBytes: 10, classification: 'restricted' })).rejects.toMatchObject({ code: 'forbidden' }); // stage workloads never
    const ok = await trusting.reserveOwned(h.human(h.a), { owner: { kind: 'organization_controller', controllerKind: 'emergency_stop' }, mediaType: 'application/json', schemaVersion: '2.0', maxBytes: 10, classification: 'restricted' });
    const row = await h.db.withTenant({ orgId: h.a.orgId }, (tx) => tx.query<{ task_id: string | null; stage_run_id: string | null; reservation_scope: string }>('SELECT task_id, stage_run_id, reservation_scope FROM factory.artifact_upload WHERE id = $1', [ok.uploadId]));
    expect(row.rows[0]).toEqual({ task_id: null, stage_run_id: null, reservation_scope: 'organization_controller' });
  });

  it('the orphan sweep never deletes an object referenced only by an embargoed registration it cannot see as runtime', async () => {
    const admin = new pg.Client({ connectionString: h.m.adminUrl });
    await admin.connect();
    const group = randomUUID();
    const body = doc(9);
    const key = finalKeyFor(h.a.orgId, sha256(body));
    try {
      await admin.query("INSERT INTO factory.security_group (org_id, id, name, authority_ref) VALUES ($1, $2, 'embargo-1', '{}')", [h.a.orgId, group]);
      await admin.query("INSERT INTO factory.artifact (org_id, id, sha256, media_type, schema_version, size_bytes, storage_key, producer_id, classification, finalized_at, retention_until, embargo_group_id) VALUES ($1,$2,$3,'application/json','2.0',$4,$5,'p','restricted',now(),now() + interval '1 day',$6)",
        [h.a.orgId, randomUUID(), sha256(body), body.length, key, group]);
    } finally { await admin.end(); }
    mkdirSync(dirname(join(h.storeRoot, key)), { recursive: true });
    writeFileSync(join(h.storeRoot, key), body);
    const invisible = await h.db.withTenant({ orgId: h.a.orgId }, (tx) => tx.query('SELECT 1 FROM factory.artifact WHERE storage_key = $1', [key]));
    expect(invisible.rowCount).toBe(0); // runtime cannot see the embargoed row...
    h.clock.now = Date.now() + 1000;
    expect(await h.service.sweepOrphanObjects(0)).not.toContain(key); // ...and the retention job still keeps the object
    expect(await h.store.exists(key)).toBe(true);
    await expect(h.make({ retention: undefined as never }).sweepOrphanObjects(0)).rejects.toMatchObject({ code: 'forbidden' }); // no retention role → fail closed
  });

  it('a registered object that is later corrupted or missing is never accepted', async () => {
    const body = doc(10);
    const ref = await (await produce(h, h.service, h.a, body)).finalize();
    const key = finalKeyFor(h.a.orgId, ref.sha256);
    writeFileSync(join(h.storeRoot, key), Buffer.from(body.toString().replace('result', 'RESULT')));
    await expect(h.service.readVerified(gate(h), ref)).rejects.toMatchObject({ code: 'integrity_incident' });
    await h.store.delete(key);
    await expect(h.service.readVerified(gate(h), ref)).rejects.toMatchObject({ code: 'artifact_unavailable' });
  });
});
