let verbose = false;

export function setVerbose(v: boolean) {
  verbose = v;
}

export function log(msg: string) {
  if (verbose) process.stderr.write(`[adapter-acp] ${msg}\n`);
}

export function warn(msg: string) {
  process.stderr.write(`[adapter-acp WARN] ${msg}\n`);
}

export function error(msg: string) {
  process.stderr.write(`[adapter-acp ERROR] ${msg}\n`);
}
