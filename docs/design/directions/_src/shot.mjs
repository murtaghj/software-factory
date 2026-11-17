// Renders a local HTML file to a full-page PNG in headless Chrome.
// usage: node shot.mjs <file.html> <out.png> <light|dark> [width]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [file, out, scheme = 'light', width = '1280'] = process.argv.slice(2);
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'spec-'))}`, `--window-size=${width},900`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const waiting = new Map(); const requests = [];
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.method === 'Network.requestWillBeSent') requests.push(d.params.request.url); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d.result ?? d); waiting.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
await send('Network.enable');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
await send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: 900, deviceScaleFactor: 1, mobile: Number(width) < 600 });
await send('Page.navigate', { url: `${pathToFileURL(resolve(file)).href}?theme=${scheme}` });
await sleep(700);
await js('document.fonts.ready.then(() => true)');
await sleep(300);
const info = await js("JSON.stringify({h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, fonts: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family)})");
const { h } = JSON.parse(info);
const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Number(width), height: h, scale: 1 } });
writeFileSync(out, Buffer.from(r.data, 'base64'));
const outside = requests.filter((u) => !u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('about:'));
console.log(out, info, outside.length ? `EXTERNAL REQUESTS: ${outside.join(', ')}` : 'no external requests');
ws.close(); chrome.kill();
