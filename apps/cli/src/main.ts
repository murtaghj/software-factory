#!/usr/bin/env node
// Entry point: wires the real terminal, file system and API client into run().
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { FactoryClient } from '@factory/client';
import { EXIT, USAGE, run } from './cli.ts';

const argv = process.argv.slice(2);
const baseUrl = process.env.FACTORY_API_URL;
const token = process.env.FACTORY_TOKEN;
if (argv.length === 0 || argv.includes('--help')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(argv.length === 0 ? EXIT.usage : EXIT.ok);
}
if (!baseUrl || !token) {
  process.stderr.write('factory: set FACTORY_API_URL and FACTORY_TOKEN\n');
  process.exit(EXIT.usage);
}
const code = await run(argv, {
  client: new FactoryClient({ baseUrl, token: () => token }),
  out: (line) => { process.stdout.write(`${line}\n`); },
  err: (line) => { process.stderr.write(`${line}\n`); },
  isTTY: process.stdin.isTTY && process.stdout.isTTY,
  ask: async (question) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(question); } finally { rl.close(); } },
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text, { flag: 'wx' }),
  now: () => Date.now(),
  uuid: () => randomUUID(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});
process.exit(code);
