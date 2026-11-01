// Object storage behind ArtifactStore (chapter 01: "S3-compatible object store behind ArtifactStore;
// immutable keys, integrity hashes"). FileObjectStore is the local-development implementation: a
// promotion to an immutable key is a conditional create (hard link), never an overwrite.
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, readdir, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

export class ObjectTooLarge extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) { super(`object exceeds ${String(maxBytes)} bytes`); this.name = 'ObjectTooLarge'; this.maxBytes = maxBytes; }
}
export class ObjectNotFound extends Error {
  readonly key: string;
  constructor(key: string) { super(`object ${key} not found`); this.name = 'ObjectNotFound'; this.key = key; }
}

export interface ObjectStore {
  putTemp(key: string, body: AsyncIterable<Uint8Array> | Uint8Array, maxBytes: number): Promise<{ bytes: number }>;
  read(key: string): AsyncIterable<Buffer>;
  // Conditional create of finalKey from tempKey: 'created', or 'exists' if the key already holds an object.
  promote(tempKey: string, finalKey: string): Promise<'created' | 'exists'>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<Array<{ key: string; modifiedAt: Date }>>;
  exists(key: string): Promise<boolean>;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export class FileObjectStore implements ObjectStore {
  readonly root: string;
  constructor(root: string) { this.root = root; }

  private path(key: string): string {
    if (!KEY.test(key) || key.split('/').some((p) => p === '..' || p === '.' || p === '')) throw new Error(`invalid object key ${key}`);
    return join(this.root, ...key.split('/'));
  }

  async putTemp(key: string, body: AsyncIterable<Uint8Array> | Uint8Array, maxBytes: number): Promise<{ bytes: number }> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) cb(new ObjectTooLarge(maxBytes)); else cb(null, chunk);
      },
    });
    const source = body instanceof Uint8Array ? Readable.from([body]) : Readable.from(body);
    try {
      await pipeline(source, limit, createWriteStream(path, { flags: 'w' }));
    } catch (e) {
      await rm(path, { force: true });
      throw e;
    }
    return { bytes };
  }

  async *read(key: string): AsyncIterable<Buffer> {
    const path = this.path(key);
    try { await stat(path); } catch { throw new ObjectNotFound(key); }
    for await (const chunk of createReadStream(path)) yield chunk as Buffer;
  }

  async promote(tempKey: string, finalKey: string): Promise<'created' | 'exists'> {
    const finalPath = this.path(finalKey);
    await mkdir(dirname(finalPath), { recursive: true });
    try {
      await link(this.path(tempKey), finalPath);
      return 'created';
    } catch (e) {
      if ((e as { code?: string }).code === 'EEXIST') return 'exists';
      throw e;
    } finally {
      await unlink(this.path(tempKey)).catch(() => undefined);
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try { await stat(this.path(key)); return true; } catch { return false; }
  }

  async list(prefix: string): Promise<Array<{ key: string; modifiedAt: Date }>> {
    const base = this.path(prefix.replace(/\/$/, ''));
    const out: Array<{ key: string; modifiedAt: Date }> = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Array<{ name: string; isDirectory: () => boolean }>;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else out.push({ key: relative(this.root, p).split(sep).join('/'), modifiedAt: (await stat(p)).mtime });
      }
    };
    await walk(base);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
}
