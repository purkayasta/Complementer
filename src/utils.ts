// Small shared helpers: non-throwing JSON and file reads, and tiny pure functions. Nothing in the extension uses the
// *Sync fs functions: the extension host's event loop is shared with every other extension, so blocking it is rude.
import fsPromises from 'node:fs/promises';
import { BACKUP_SUFFIX, UNREADABLE_SUFFIX } from './consts';

/** The file's text, or undefined if it cannot be read. */
export async function tryReadText(filePath: string): Promise<string | undefined> {
  try {
    return await fsPromises.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/** Whether anything (file, folder or dangling link) exists at the path. */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** The paths that exist, in the same order. */
export async function filterExistingPaths(filePaths: string[]): Promise<string[]> {
  const exists = await Promise.all(filePaths.map(pathExists));
  return filePaths.filter((filePath, index) => exists[index]);
}

/** Parse JSON without throwing, so callers can stay `const` instead of wrapping try/catch around a `let`. Undefined if the text is not valid JSON. */
export function tryParseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

export const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** Promise.catch handler: a missing file is fine (undefined), anything else is a real error. */
export function ignoreMissingFile(error: any): undefined {
  if (error.code === 'ENOENT') return undefined;
  throw error;
}

export function truncate(text: string, maxLength: number) {
  return text.length > maxLength ? text.slice(0, maxLength) + ` … (${text.length - maxLength} more chars)` : text;
}

export const toNonNegativeNumber = (value: unknown) => (typeof value === 'number' && value >= 0 && Number.isFinite(value) ? value : 0);

export const padTwoDigits = (value: number) => String(value).padStart(2, '0');

/** Object.entries -> transform -> Object.fromEntries. */
export function mapValues(source: Record<string, any>, transform: (value: any) => any): Record<string, any> {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, transform(value)]));
}

export const toFiniteNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** @param error Anything a catch block can receive. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Add to a named counter. The own-property check keeps names like "constructor" from reading the prototype. */
export function incrementCount(counts: Record<string, number>, name: string, amount = 1) {
  counts[name] = (Object.hasOwn(counts, name) ? counts[name] : 0) + amount;
}

/**
 * Replace a file without ever leaving it half-written. A symlink keeps pointing at its target (the real file is
 * replaced) and the file keeps its permissions, since settings.json may hold tokens and may live in a dotfiles repo.
 */
export async function writeAtomic(filePath: string, content: string | Buffer) {
  const targetPath = await fsPromises.realpath(filePath).catch(() => filePath);
  const mode = await fsPromises.stat(targetPath).then(
    (stats) => stats.mode & 0o777,
    () => undefined,
  );
  const temporaryPath = `${targetPath}.${process.pid}.complementer.tmp`;
  try {
    await fsPromises.writeFile(temporaryPath, content);
    if (mode !== undefined && process.platform !== 'win32') await fsPromises.chmod(temporaryPath, mode); // writeFile's own mode is cut by the umask
    await fsPromises.rename(temporaryPath, targetPath);
  } catch (error) {
    await fsPromises.rm(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * Load a saved state file. `adopt` takes the parsed JSON and returns whether it was a known layout. A good file is copied
 * to a backup; an unreadable one is set aside and the last good backup is tried instead (a missing file is a fresh start).
 * @returns true if the state came from the backup, so the caller should save it again
 */
export async function loadWithBackup(filePath: string, adopt: (saved: any) => boolean): Promise<boolean> {
  const text = await tryReadText(filePath);
  if (text === undefined) return false;
  if (adopt(tryParseJson(text))) {
    await fsPromises.copyFile(filePath, filePath + BACKUP_SUFFIX).catch(() => {});
    return false;
  }
  await fsPromises.rename(filePath, filePath + UNREADABLE_SUFFIX).catch(() => {});
  const backupText = await tryReadText(filePath + BACKUP_SUFFIX);
  return backupText !== undefined && adopt(tryParseJson(backupText));
}

/**
 * Save a map of costs. Windows share the file but not memory, so by default the saved values are merged in first (the
 * highest wins, costs only rise) and the merge also lands in `costs`. Pass shouldMerge false after removing entries.
 */
export async function writeCosts(filePath: string, costs: Record<string, number>, shouldMerge: boolean) {
  if (shouldMerge) {
    const saved = tryParseJson((await tryReadText(filePath)) ?? '');
    for (const [key, value] of Object.entries<any>(saved ?? {})) if (typeof value === 'number' && value > (costs[key] ?? 0)) costs[key] = value;
  }
  await writeAtomic(filePath, JSON.stringify(costs));
}
