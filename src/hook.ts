// Complementer statusLine passthrough for Windows (hook.sh does the same on macOS/Linux).
// argv[2] = extension storage directory. Saves the JSON Claude Code sends on stdin for the extension, then runs the
// user's original statusLine command with the same stdin, so their status line is unchanged.
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Everything Claude Code wrote to stdin. */
async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Run the user's own status line command with the payload on its stdin; its output goes straight to ours. */
function runOriginalCommand(command: string, payload: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
    child.stdin.on('error', () => {}); // the command may exit without reading
    child.stdin.end(payload);
  });
}

/** Write the payload where the extension watches, atomically. */
async function saveForExtension(storageDirectory: string, payload: string) {
  const sessionId = JSON.parse(payload).session_id;
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return;
  const liveDirectory = path.join(storageDirectory, 'live');
  await fsPromises.mkdir(liveDirectory, { recursive: true });
  const temporaryPath = path.join(liveDirectory, `.in.${process.pid}`);
  await fsPromises.writeFile(temporaryPath, payload);
  // Windows refuses to rename over a file the extension is reading; skip, the next render retries.
  await fsPromises.rename(temporaryPath, path.join(liveDirectory, sessionId + '.json')).catch(() => fsPromises.rm(temporaryPath, { force: true }));
}

async function main() {
  const storageDirectory = process.argv[2];
  const payload = await readStandardInput();
  const originalCommand = await fsPromises.readFile(path.join(storageDirectory, 'original-command'), 'utf8').catch(() => '');
  if (originalCommand) await runOriginalCommand(originalCommand, payload);
  await saveForExtension(storageDirectory, payload).catch(() => {}); // never let our bookkeeping break the status line
}

main().catch(() => {}); // a bookkeeping failure must never become a broken status line
