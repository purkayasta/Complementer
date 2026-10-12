// Claude Code session logs -> per-day token totals. Fast path: only newly appended bytes are read,
// and lines are rejected on raw bytes before any decoding or JSON.parse.
import { promises as fsPromises, type Dirent } from 'node:fs';
import path from 'node:path';
import type { Bucket, FileState, HistoryDays, TokenTotals, UsageRecord } from './types';
import { USAGE_NEEDLE, TOKEN_KEYS, HISTORY_VERSION, INSIGHT_DAYS, DAY_MS, IDLE_LOG_MS, READ_CHUNK_BYTES, NEWLINE_BYTE } from './consts';
import { tryParseJson, loadWithBackup, toNonNegativeNumber, padTwoDigits, mapValues, writeAtomic, createQueue } from './utils';

/**
 * Local-time day (YYYY-MM-DD), so "today" matches what the user sees on their clock.
 * @returns null if the timestamp is not a valid date
 */
export function toDayKey(isoTimestamp: string): string | null {
  const date = new Date(isoTimestamp);
  return Number.isNaN(date.getTime()) ? null : `${date.getFullYear()}-${padTwoDigits(date.getMonth() + 1)}-${padTwoDigits(date.getDate())}`;
}

/**
 * Remove the entries of a day-keyed map that are older than the Insights window; nothing shows them. Offsets are kept
 * elsewhere, so the logs those days came from are never counted again.
 * @returns true if anything was removed
 */
export function dropOldDays(daysByKey: Record<string, unknown>, now: Date): boolean {
  const cutoff = toDayKey(new Date(now.getTime() - INSIGHT_DAYS * DAY_MS).toISOString()) ?? '';
  const oldKeys = Object.keys(daysByKey).filter((key) => key < cutoff);
  oldKeys.forEach((key) => delete daysByKey[key]);
  return oldKeys.length > 0;
}

/**
 * Callers pre-filter on the raw bytes (USAGE_NEEDLE), so a line that is not a usage record is only rejected here by shape.
 * @param line One JSONL line.
 */
export function parseUsageLine(line: string): UsageRecord | null {
  const entry = tryParseJson(line); // undefined for a truncated or foreign line
  if (!entry || entry.type !== 'assistant' || typeof entry.timestamp !== 'string') return null;
  const message = entry.message;
  const usage = message?.usage;
  if (!usage || typeof message.id !== 'string' || typeof message.model !== 'string' || message.model === '<synthetic>') return null;
  return {
    messageId: message.id,
    timestamp: entry.timestamp,
    sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
    workingDirectory: typeof entry.cwd === 'string' ? entry.cwd : '',
    modelId: message.model,
    isSidechain: entry.isSidechain === true,
    inputTokens: toNonNegativeNumber(usage.input_tokens),
    cacheCreationTokens: toNonNegativeNumber(usage.cache_creation_input_tokens),
    cacheReadTokens: toNonNegativeNumber(usage.cache_read_input_tokens),
    outputTokens: toNonNegativeNumber(usage.output_tokens),
  };
}

/**
 * Yield the complete lines of a file, one batch per 1 MB chunk, starting at cursor.offset. The cursor advances after the
 * caller has processed each batch, so progress survives an error. A partial trailing line is left for the next call.
 * Batching keeps the per-line cost to a plain loop (an async hop per line would be far slower).
 */
export async function* iterateLineBatches(filePath: string, cursor: { offset: number }): AsyncGenerator<Buffer[]> {
  const fileHandle = await fsPromises.open(filePath, 'r');
  try {
    const { size: fileSize } = await fileHandle.stat();
    let position = cursor.offset;
    let carryOver = Buffer.alloc(0);
    while (position < fileSize) {
      const bytesToRead = Math.min(READ_CHUNK_BYTES, fileSize - position);
      const chunk = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await fileHandle.read(chunk, 0, bytesToRead, position);
      if (!bytesRead) break;
      const readBytes = chunk.subarray(0, bytesRead);
      const buffer = carryOver.length ? Buffer.concat([carryOver, readBytes]) : readBytes;
      const lines: Buffer[] = [];
      let lineStart = 0;
      for (let newlineIndex = buffer.indexOf(NEWLINE_BYTE); newlineIndex !== -1; newlineIndex = buffer.indexOf(NEWLINE_BYTE, lineStart)) {
        lines.push(buffer.subarray(lineStart, newlineIndex));
        lineStart = newlineIndex + 1;
      }
      carryOver = Buffer.from(buffer.subarray(lineStart));
      position += bytesRead;
      yield lines;
      cursor.offset = position - carryOver.length;
    }
  } finally {
    await fileHandle.close();
  }
}

/**
 * Pass `onLine` the text of each complete line appended since the cursor, if `isWanted` accepts its raw bytes first.
 * A file that shrank (truncated or replaced) is read from the start again after `onReset`. Unchanged files are never opened.
 * @returns true if the cursor moved
 */
export async function readNewLines(filePath: string, cursor: { offset: number }, isWanted: (line: Buffer) => boolean, onLine: (text: string) => void, onReset: () => void = () => {}): Promise<boolean> {
  const { size: fileSize } = await fsPromises.stat(filePath);
  const offsetBefore = cursor.offset;
  if (fileSize < offsetBefore) {
    cursor.offset = 0;
    onReset();
  }
  if (fileSize === cursor.offset) return false;
  for await (const lines of iterateLineBatches(filePath, cursor)) {
    for (const line of lines) if (isWanted(line)) onLine(line.toString('utf8'));
  }
  return cursor.offset !== offsetBefore;
}

/** Read the usage records appended to a log since the last call. */
export const readNewRecords = (filePath: string, fileState: FileState, onRecord: (record: UsageRecord) => void): Promise<boolean> =>
  readNewLines(
    filePath,
    fileState,
    (line) => line.includes(USAGE_NEEDLE),
    (text) => {
      const record = parseUsageLine(text);
      if (record) onRecord(record);
    },
    () => {
      fileState.lastResponse = null;
    },
  );

/** Convert the version 1 storage layout (terse keys) to the current one. */
function migrateHistoryV1(saved: any) {
  const days = mapValues(saved.days, (byProject) => mapValues(byProject, (byModel) => mapValues(byModel, (bucket) => ({ ...renameTotalsV1(bucket), responseCount: bucket.n }))));
  const fileStates = mapValues(saved.files, (state) => ({
    offset: state.off,
    lastResponse: state.last ? { ...renameTotalsV1(state.last), messageId: state.last.id, day: state.last.day, workingDirectory: state.last.cwd, modelId: state.last.model } : null,
  }));
  return { days, fileStates };
}

/** The version 1 token keys were terse (in, cc, cr, out). */
function renameTotalsV1(oldTotals: any): TokenTotals {
  return { inputTokens: oldTotals.in, cacheCreationTokens: oldTotals.cc, cacheReadTokens: oldTotals.cr, outputTokens: oldTotals.out };
}

/**
 * Write a saved-state file if it has unsaved changes (after dropping days nothing shows any more). If the write fails the
 * changes stay pending, so the next flush retries.
 */
export async function saveState(state: { hasUnsavedChanges: boolean }, filePath: string, daysByKey: Record<string, unknown>, snapshot: () => unknown) {
  if (dropOldDays(daysByKey, new Date())) state.hasUnsavedChanges = true;
  if (!state.hasUnsavedChanges) return;
  state.hasUnsavedChanges = false;
  try {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await writeAtomic(filePath, JSON.stringify(snapshot()));
  } catch (error) {
    state.hasUnsavedChanges = true;
    throw error;
  }
}

export class History {
  days: HistoryDays = {};

  fileStates: Record<string, FileState> = {};

  hasUnsavedChanges = false;

  readonly #enqueueSave = createQueue();

  constructor(private readonly filePath: string) {}

  /** Totals and file offsets live in one file, so one atomic write keeps them consistent. */
  static async load(filePath: string) {
    const history = new History(filePath);
    // Offsets are lost with the totals, so a rescan of surviving logs (after the last good backup, if any) is the only consistent recovery.
    if (await loadWithBackup(filePath, (saved) => history.#adopt(saved))) history.hasUnsavedChanges = true;
    return history;
  }

  #adopt(saved: any): boolean {
    if (saved?.version === HISTORY_VERSION && saved.days && saved.fileStates) {
      this.days = saved.days;
      this.fileStates = saved.fileStates;
      return true;
    }
    if (saved?.version === 1 && saved.days && saved.files) {
      Object.assign(this, migrateHistoryV1(saved));
      this.hasUnsavedChanges = true;
      return true;
    }
    return false;
  }

  getBucket(day: string, workingDirectory: string, modelId: string): Bucket {
    const byProject = (this.days[day] ||= {});
    const byModel = (byProject[workingDirectory] ||= {});
    return (byModel[modelId] ||= { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, responseCount: 0 });
  }

  /**
   * One API response is logged once per content block with identical usage; count it once.
   * If a repeat carries larger numbers, only the difference is added.
   */
  addRecord(record: UsageRecord, fileState: FileState) {
    const last = fileState.lastResponse;
    if (last?.messageId === record.messageId) {
      const bucket = this.getBucket(last.day, last.workingDirectory, last.modelId);
      for (const key of TOKEN_KEYS) {
        const increase = record[key] - last[key];
        if (increase > 0) {
          bucket[key] += increase;
          last[key] += increase;
          this.hasUnsavedChanges = true;
        }
      }
      return;
    }
    const day = toDayKey(record.timestamp);
    if (!day) return;
    const bucket = this.getBucket(day, record.workingDirectory, record.modelId);
    for (const key of TOKEN_KEYS) bucket[key] += record[key];
    bucket.responseCount++;
    fileState.lastResponse = {
      messageId: record.messageId,
      day,
      workingDirectory: record.workingDirectory,
      modelId: record.modelId,
      inputTokens: record.inputTokens,
      cacheCreationTokens: record.cacheCreationTokens,
      cacheReadTokens: record.cacheReadTokens,
      outputTokens: record.outputTokens,
    };
    this.hasUnsavedChanges = true;
  }

  /** Saves run one after another: two writers on the same temporary file could leave a half-written history. */
  save() {
    return this.#enqueueSave(() => saveState(this, this.filePath, this.days, () => ({ version: HISTORY_VERSION, days: this.days, fileStates: this.fileStates })));
  }

  /**
   * Forget the last reply of logs that are gone or idle: it only matters while more blocks of that reply can still arrive.
   * The offset stays, so a log restored from the Trash is not counted twice.
   */
  async dropIdleLastResponses(nowMs: number) {
    await Promise.all(
      Object.entries(this.fileStates)
        .filter(([, fileState]) => fileState.lastResponse)
        .map(async ([filePath, fileState]) => {
          const modifiedAtMs = await fsPromises.stat(filePath).then(
            (stats) => stats.mtimeMs,
            (error) => (error.code === 'ENOENT' ? 0 : nowMs), // any other error: keep it
          );
          if (nowMs - modifiedAtMs <= IDLE_LOG_MS) return;
          fileState.lastResponse = null;
          this.hasUnsavedChanges = true;
        }),
    );
  }
}

/** Every session log: <projects>/<project>/*.jsonl and <projects>/<project>/<session>/subagents/*.jsonl */
export async function listLogFiles(projectsRoot: string): Promise<string[]> {
  const projectEntries = await readDirectory(projectsRoot);
  const logsPerProject = await Promise.all(projectEntries.filter((entry) => entry.isDirectory()).map((entry) => listProjectLogFiles(path.join(projectsRoot, entry.name))));
  return logsPerProject.flat();
}

/** The directory's entries, or none if it cannot be read. */
function readDirectory(directory: string): Promise<Dirent[]> {
  return fsPromises.readdir(directory, { withFileTypes: true }).catch(() => []);
}

/** The session logs of one project folder, including each session's subagent logs. */
async function listProjectLogFiles(projectDirectory: string): Promise<string[]> {
  const children = await readDirectory(projectDirectory);
  const mainLogs = children.filter((child) => child.isFile() && child.name.endsWith('.jsonl')).map((child) => path.join(projectDirectory, child.name));
  const subagentLogs = await Promise.all(children.filter((child) => child.isDirectory()).map((child) => listJsonlFiles(path.join(projectDirectory, child.name, 'subagents'))));
  return [...mainLogs, ...subagentLogs.flat()];
}

async function listJsonlFiles(directory: string): Promise<string[]> {
  const entries = await readDirectory(directory);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => path.join(directory, entry.name));
}

/** The session a log belongs to: its file name, or for a subagent log the session folder two levels up. */
export function getOwnSessionId(filePath: string): string {
  const isSubagentLog = path.basename(path.dirname(filePath)) === 'subagents';
  return isSubagentLog ? path.basename(path.dirname(path.dirname(filePath))) : path.basename(filePath, '.jsonl');
}

export class Scanner {
  readonly #enqueueScan = createQueue();

  constructor(
    private readonly projectsRoot: string,
    readonly history: History,
  ) {}

  /**
   * Scan the given files, or every log when none are given. Calls are serialised so offsets never race.
   * @returns true if any file had new data
   */
  scan(filePaths?: string[]): Promise<boolean> {
    return this.#enqueueScan(() => this.#scanFiles(filePaths));
  }

  async #scanFiles(filePaths?: string[]) {
    const filesToScan = filePaths ?? (await listLogFiles(this.projectsRoot));
    const hadNewData: boolean[] = [];
    for (const filePath of filesToScan) {
      const fileState = (this.history.fileStates[filePath] ||= { offset: 0, lastResponse: null });
      const ownSessionId = getOwnSessionId(filePath);
      // A resumed or forked chat can carry another session's replies (same message ids); they are counted in their own log.
      const hadNewRecords = await readNewRecords(filePath, fileState, (record) => {
        if (!record.sessionId || record.sessionId === ownSessionId) this.history.addRecord(record, fileState);
      }).catch(() => false); // file vanished between listing and reading
      hadNewData.push(hadNewRecords);
    }
    return hadNewData.some(Boolean);
  }
}
