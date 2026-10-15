// Runs before anything else: Mugibot needs Node.js 22.13+ (for its built-in
// SQLite database). Say so plainly instead of failing with a cryptic error,
// and hide Node's "SQLite is an experimental feature" notice.

export function requireNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`\nMugibot needs Node.js 22.13 or newer, and this computer has ${process.version}.\n`
      + 'Install the LTS version from https://nodejs.org, then open a NEW Terminal window and try again.\n');
    process.exit(1);
  }
}

export function quietExperimentalWarnings() {
  const original = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w && w.name === 'ExperimentalWarning' && /sqlite/i.test(String(w.message))) return;
    for (const l of original) l(w);
  });
}

/** Open a page in the default browser (best effort; does nothing if it can't). */
export async function openBrowser(url) {
  if (process.env.NO_OPEN === '1' || process.env.CI) return;
  const { spawn } = await import('node:child_process');
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* no browser to open */ }
}

/** A friendly message for "that port is already taken". */
export function portHelp(e, port) {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`\nPort ${port} is already in use — is Mugibot already running in another Terminal window?\n`
      + 'Close that window (or press Ctrl+C in it) and try again.\n');
    process.exit(1);
  }
  throw e;
}
