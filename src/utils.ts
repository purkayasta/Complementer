// Small shared helpers: non-throwing JSON and file reads, and tiny pure functions. Nothing in the extension uses the
// *Sync fs functions: the extension host's event loop is shared with every other extension, so blocking it is rude.
import fsPromises from 'node:fs/promises';

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
