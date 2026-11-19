// A scripted harness (A-33, stands in for W-077): runs until TERM.
process.on('SIGTERM', () => { process.exit(0); });
setInterval(() => undefined, 1000);
