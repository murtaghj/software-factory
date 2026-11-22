const zlib = require('node:zlib');
const t = (name, f) => { try { const r = f(); console.log(name, 'OK', JSON.stringify(r)); } catch (e) { console.log(name, 'THROW', e.constructor.name, e.code, e.message.slice(0,80)); } };
const empty = zlib.deflateSync(Buffer.alloc(0));
t('empty blob, maxOutputLength 0', () => zlib.inflateSync(empty, { maxOutputLength: 0 }).length);
t('empty blob, maxOutputLength 1', () => { const r = zlib.inflateSync(empty, { maxOutputLength: 1, info: true }); return [r.buffer.length, r.engine.bytesWritten, empty.length]; });
for (const n of [1, 100, 16384, 16385, 65536, 1<<20]) {
  const body = Buffer.alloc(n, 7);
  const c = zlib.deflateSync(body);
  t(`exact size ${n}`, () => { const r = zlib.inflateSync(c, { maxOutputLength: n, info: true }); return [r.buffer.length, r.engine.bytesWritten, c.length]; });
}
const b = Buffer.alloc(50000, 1); const c2 = Buffer.concat([zlib.deflateSync(b), Buffer.from('junkjunkjunk')]);
t('exact + trailing', () => { const r = zlib.inflateSync(c2, { maxOutputLength: 50000, info: true }); return [r.buffer.length, r.engine.bytesWritten, c2.length]; });
t('gzip into inflateSync', () => zlib.inflateSync(zlib.gzipSync(Buffer.from('x'))).length);
t('raw into inflateSync', () => zlib.inflateSync(zlib.deflateRawSync(Buffer.from('x'))).length);
const c3 = Buffer.from(zlib.deflateSync(Buffer.from('hello world'))); c3[c3.length-1] ^= 1;
t('bad adler', () => zlib.inflateSync(c3).toString());
