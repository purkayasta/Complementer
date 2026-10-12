// Enable/disable the live feed by chaining Claude Code's statusLine through hook.sh (macOS/Linux) or hook.js (Windows).
// The user's previous statusLine is saved and restored exactly; nothing is edited without the caller's consent.
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SetupPaths } from './types';
import { LOCK_STALE_MS, LOCK_WAIT_MS, LOCK_RETRY_MS, POSIX_HOOK_COMMAND, WINDOWS_HOOK_COMMAND, INSTALLED_HOOK_PATH } from './consts';
import { tryParseJson, tryReadText, shellQuote, ignoreMissingFile, writeAtomic } from './utils';

const isWindows = (paths: SetupPaths) => (paths.platform ?? process.platform) === 'win32';

const getHookName = (paths: SetupPaths) => (isWindows(paths) ? 'hook.js' : 'hook.sh');

const getHookPath = (paths: SetupPaths) => path.join(paths.storageDirectory, getHookName(paths));

/**
 * POSIX: if the hook file is gone (settings.json synced to another machine, extension data cleared), fall back to the
 * user's own command instead of leaving their status line blank. Windows paths cannot contain double quotes, so
 * double-quoting is safe for cmd and Git Bash alike there; that form has no fallback.
 */
export const buildHookCommand = (paths: SetupPaths, originalCommand = '') => {
  if (isWindows(paths)) return `node "${getHookPath(paths)}" "${paths.storageDirectory}"`;
  const hookPath = shellQuote(getHookPath(paths));
  const fallback = originalCommand ? `; else sh -c ${shellQuote(originalCommand)}` : '';
  return `if [ -f ${hookPath} ]; then sh ${hookPath} ${shellQuote(paths.storageDirectory)}${fallback}; fi`;
};

/** Whether `node` can be run from PATH (the Windows hook needs it). */
async function isNodeAvailable() {
  try {
    await promisify(execFile)('node', ['-v']);
    return true;
  } catch {
    return false;
  }
}

async function readSettings(settingsPath: string): Promise<Record<string, any>> {
  const text = await fsPromises.readFile(settingsPath, 'utf8').catch(ignoreMissingFile);
  if (text === undefined) return {};
  const settings = tryParseJson(text);
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) return settings;
  throw new Error(`${settingsPath} is not plain JSON; not touching it.`);
}

/**
 * Copy a file only when it differs, and never in place: a script that is being run right now must not be truncated.
 */
async function copyFileAtomic(sourcePath: string, destinationPath: string) {
  const [source, existing] = await Promise.all([fsPromises.readFile(sourcePath), fsPromises.readFile(destinationPath).catch(ignoreMissingFile)]);
  if (!existing || !source.equals(existing)) await writeAtomic(destinationPath, source);
}

/**
 * @param deadlineMs When to give up waiting.
 * @returns false when there is no settings folder yet (nobody else can be editing it)
 */
async function acquireLock(lockPath: string, deadlineMs: number): Promise<boolean> {
  try {
    await fsPromises.mkdir(lockPath);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT') return false;
    if (code !== 'EEXIST') throw error;
    const lockStats = await fsPromises.stat(lockPath).catch(() => undefined);
    if (lockStats && Date.now() - lockStats.mtimeMs > LOCK_STALE_MS) await fsPromises.rmdir(lockPath).catch(() => {});
    else if (Date.now() > deadlineMs) throw new Error('Another window is changing your settings right now; try again in a moment.');
    else await sleep(LOCK_RETRY_MS);
    return acquireLock(lockPath, deadlineMs);
  }
}

/**
 * Run `action` while holding a lock next to settings.json, so two VS Code windows (or a dev copy and the installed one)
 * never read-modify-write the file at the same time. mkdir is atomic everywhere; a lock left by a crash expires.
 */
async function withSettingsLock<T>(paths: SetupPaths, action: () => Promise<T>): Promise<T> {
  const lockPath = paths.settingsPath + '.complementer.lock';
  const isLocked = await acquireLock(lockPath, Date.now() + LOCK_WAIT_MS);
  try {
    return await action();
  } finally {
    if (isLocked) await fsPromises.rmdir(lockPath).catch(() => {});
  }
}

/**
 * Take a Complementer hook command apart, undoing the shell quoting (a quote in the home folder becomes '\'' ).
 * @param command A statusLine.command from settings.json.
 * @returns undefined unless it is exactly a Complementer hook command, from any install
 */
export function parseHookCommand(command: unknown): { hookPath: string; storageDirectory: string } | undefined {
  if (typeof command !== 'string') return undefined;
  const posix = POSIX_HOOK_COMMAND.exec(command);
  const [hookPath, storageDirectory] = posix ? [posix[1], posix[2]].map((word) => word.replace(/'\\''/g, "'")) : (WINDOWS_HOOK_COMMAND.exec(command) ?? []).slice(1);
  return hookPath && storageDirectory && INSTALLED_HOOK_PATH.test(hookPath) ? { hookPath, storageDirectory } : undefined;
}

/**
 * Whether this install's own hook is in the command. Compared against the command we would write, not the raw path:
 * shell quoting changes a path that contains a quote.
 */
const isOwnHookCommand = (paths: SetupPaths, command: unknown): command is string => typeof command === 'string' && (parseHookCommand(command)?.hookPath === getHookPath(paths) || command.includes(getHookPath(paths)));

/** Whether this install's hook is in the user's statusLine right now; undefined if settings.json cannot be read. */
export async function isHookEnabled(paths: SetupPaths): Promise<boolean | undefined> {
  try {
    return isOwnHookCommand(paths, (await readSettings(paths.settingsPath)).statusLine?.command);
  } catch {
    return undefined;
  }
}

/** What enabling would do, for the consent dialog. Also hands back the settings it read, so the caller does not read them twice. */
export async function planEnable(paths: SetupPaths): Promise<{ isAlreadyEnabled: boolean; commandBefore: string; commandAfter: string; settings: Record<string, any> }> {
  const settings = await readSettings(paths.settingsPath);
  const statusLine = settings.statusLine;
  if (isOwnHookCommand(paths, statusLine?.command)) {
    return { isAlreadyEnabled: true, commandBefore: statusLine.command, commandAfter: statusLine.command, settings };
  }
  // Another copy's hook is not the user's status line: saving it as the "original" would lose their real one.
  if (parseHookCommand(statusLine?.command)) {
    throw new Error(`Your statusLine already points at another copy of Complementer (${statusLine.command}). Edit statusLine in ${paths.settingsPath} back to your own command, then try again. Not touching it.`);
  }
  if (statusLine && statusLine.type !== 'command') throw new Error('Your statusLine is not a command type; not touching it.');
  return { isAlreadyEnabled: false, commandBefore: statusLine ? statusLine.command : '(none)', commandAfter: buildHookCommand(paths, typeof statusLine?.command === 'string' ? statusLine.command : ''), settings };
}

export function enableStatusLine(paths: SetupPaths): Promise<{ changed: boolean }> {
  return withSettingsLock(paths, async () => {
    const { isAlreadyEnabled, commandAfter, settings } = await planEnable(paths);
    // The Windows hook runs under `node`; refuse rather than break the user's status line if it is missing.
    if (isWindows(paths) && !isAlreadyEnabled && !(await isNodeAvailable())) throw new Error('Live meters on Windows need `node` on PATH.');
    await fsPromises.mkdir(path.join(paths.storageDirectory, 'live'), { recursive: true });
    if (paths.sourceDirectory) await copyFileAtomic(path.join(paths.sourceDirectory, getHookName(paths)), getHookPath(paths)); // refresh the copy after extension upgrades
    if (isAlreadyEnabled) return { changed: false };

    const previousStatusLine = settings.statusLine;
    await writeAtomic(path.join(paths.storageDirectory, 'statusline-backup.json'), JSON.stringify({ hadStatusLine: !!previousStatusLine, value: previousStatusLine ?? null }));
    await writeAtomic(path.join(paths.storageDirectory, 'original-command'), previousStatusLine?.command ?? '');
    settings.statusLine = { ...previousStatusLine, type: 'command', command: commandAfter };
    await writeAtomic(paths.settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return { changed: true };
  });
}

export function disableStatusLine(paths: SetupPaths): Promise<{ changed: boolean }> {
  return withSettingsLock(paths, async () => {
    const settings = await readSettings(paths.settingsPath);
    const statusLine = settings.statusLine;
    if (!isOwnHookCommand(paths, statusLine?.command)) return { changed: false };
    const backup = tryParseJson((await tryReadText(path.join(paths.storageDirectory, 'statusline-backup.json'))) ?? '');
    if (backup) {
      const hadStatusLine = backup.hadStatusLine ?? backup.had; // `had` is the key older versions wrote
      if (hadStatusLine) settings.statusLine = backup.value;
      else delete settings.statusLine;
    } else {
      // The exact backup is gone or unreadable: the saved command is enough to put the user's status line back.
      const originalCommand = ((await tryReadText(path.join(paths.storageDirectory, 'original-command'))) ?? '').trim();
      if (originalCommand) settings.statusLine = { ...statusLine, command: originalCommand };
      else delete settings.statusLine;
    }
    await writeAtomic(paths.settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return { changed: true };
  });
}
