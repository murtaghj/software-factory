// Posts the exit hint to the local endpoint in a tight loop, until the endpoint stops answering or TERM.
import http from 'node:http';

const base = new URL(process.env['FACTORY_SUPERVISOR_URL'] ?? 'http://127.0.0.1:8765');
process.on('SIGTERM', () => { process.exit(0); });
const once = (): Promise<boolean> => new Promise((resolve) => {
  const req = http.request({ hostname: base.hostname, port: base.port, path: '/v1/exit', method: 'POST', agent: false, timeout: 1000 }, (res) => { res.resume(); res.on('end', () => { resolve(true); }); });
  req.on('error', () => { resolve(false); });
  req.end('{}');
});
void (async (): Promise<void> => { for (;;) { if (!(await once())) await new Promise((r) => setTimeout(r, 50)); } })();
