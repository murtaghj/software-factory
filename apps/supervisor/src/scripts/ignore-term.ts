// Ignores TERM: only KILL ends it.
process.on('SIGTERM', () => undefined);
setInterval(() => undefined, 1000);
