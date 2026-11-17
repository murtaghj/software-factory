// Inlines the OFL font files into a specimen so the HTML makes no external requests.
// usage: node build.mjs <name>   (reads _src/<name>.html, writes ../specimen-<name>.html)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const fonts = join(here, '..', '_fonts');
const FACES = {
  archivo: { family: 'Archivo', file: 'archivo/package/files/archivo-latin-wdth-normal.woff2', extra: 'font-weight:100 900;font-stretch:62% 125%;' },
  atkinson: { family: 'Atkinson Hyperlegible Next', file: 'atkinson-hyperlegible-next/package/files/atkinson-hyperlegible-next-latin-wght-normal.woff2', extra: 'font-weight:200 800;' },
  sofia: { family: 'Sofia Sans', file: 'sofia-sans/package/files/sofia-sans-latin-wght-normal.woff2', extra: 'font-weight:1 1000;' },
  sofiasc: { family: 'Sofia Sans Semi Condensed', file: 'sofia-sans-semi-condensed/package/files/sofia-sans-semi-condensed-latin-wght-normal.woff2', extra: 'font-weight:1 1000;' },
};
const name = process.argv[2];
let html = readFileSync(join(here, `${name}.html`), 'utf8');
html = html.replace(/\/\*@font:(\w+)\*\//g, (_, key) => {
  const f = FACES[key];
  const b64 = readFileSync(join(fonts, f.file)).toString('base64');
  return `@font-face{font-family:'${f.family}';font-style:normal;font-display:block;${f.extra}src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
});
const out = join(here, '..', `specimen-${name}.html`);
writeFileSync(out, html);
const external = html.match(/(?:src|href)=["']https?:[^"']+|url\(\s*["']?https?:[^)]+/g);
console.log(out, `${Math.round(html.length / 1024)} KB`, external ? `EXTERNAL REFS: ${external.join(', ')}` : 'no external requests');
