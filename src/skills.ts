// Skill calls found in the session logs, counted per day. Kept in a file of its own (skills.json, with its own read
// offsets) so the token history is never touched. Names and counts only: no chat content.
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import type { SkillDays, SkillSessions, SkillFileState } from './types';
import { SKILL_CALL_NEEDLE, SKILLS_VERSION, NAME_PATTERN } from './consts';
import { getOwnSessionId, iterateLineBatches, toDayKey } from './logs';
import { tryParseJson, tryReadText, incrementCount } from './utils';

/**
 * Callers pre-filter on the raw bytes (SKILL_CALL_NEEDLE), so a line that merely mentions the words is rejected here by shape.
 * @param line One JSONL line.
 * @returns the local day and the skills an assistant line calls through the Skill tool, or null for any other line
 */
export function parseSkillUses(line: string): { day: string; sessionId: string; skills: string[] } | null {
  const entry = tryParseJson(line); // undefined for a truncated or foreign line
  if (entry?.type !== 'assistant' || typeof entry.timestamp !== 'string' || !Array.isArray(entry.message?.content)) return null;
  const day = toDayKey(entry.timestamp);
  const skills: string[] = entry.message.content
    .filter((block: any) => block?.type === 'tool_use' && block.name === 'Skill' && typeof block.input?.skill === 'string' && NAME_PATTERN.test(block.input.skill))
    .map((block: any) => block.input.skill);
  return day && skills.length ? { day, sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '', skills } : null;
}

export class SkillHistory {
  days: SkillDays = {};

  sessions: SkillSessions = {};

  fileStates: Record<string, SkillFileState> = {};

  hasUnsavedChanges = false;

  pendingScans: Promise<unknown> = Promise.resolve();

  pendingSaves: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** A missing file is a fresh start; an unreadable or other-version one is set aside and rebuilt from the logs on disk. */
  static async load(filePath: string) {
    const history = new SkillHistory(filePath);
    const text = await tryReadText(filePath);
    if (text === undefined) return history;
    const saved = tryParseJson(text);
    if (saved?.version === SKILLS_VERSION && saved.days && saved.fileStates && saved.sessions) {
      history.days = saved.days;
      history.sessions = saved.sessions;
      history.fileStates = saved.fileStates;
    } else if (saved?.version === 1 && saved.days && saved.fileStates) {
      // Version 1 had no per-session counts: keep the day counts and read each log once more for the sessions only.
      history.days = saved.days;
      history.fileStates = Object.fromEntries(Object.entries<SkillFileState>(saved.fileStates).map(([logPath, fileState]) => [logPath, { ...fileState, needsSessionBackfill: true }]));
      history.hasUnsavedChanges = true;
    } else {
      await fsPromises.rename(filePath, filePath + '.bad').catch(() => {});
    }
    return history;
  }

  /**
   * Count the skill calls appended to the given logs since they were last read. Calls are serialised so offsets never race.
   * @returns true if any file had new data
   */
  scan(filePaths: string[]): Promise<boolean> {
    const scanResult = this.pendingScans.then(() => this.#scanFiles(filePaths));
    this.pendingScans = scanResult.catch(() => {});
    return scanResult;
  }

  async #scanFiles(filePaths: string[]): Promise<boolean> {
    const hadNewData: boolean[] = [];
    for (const filePath of filePaths) hadNewData.push(await this.#scanFile(filePath));
    return hadNewData.some(Boolean);
  }

  async #scanFile(filePath: string): Promise<boolean> {
    const fileState = (this.fileStates[filePath] ||= { offset: 0 });
    const ownSessionId = getOwnSessionId(filePath);
    try {
      const { size: fileSize } = await fsPromises.stat(filePath);
      if (fileState.needsSessionBackfill) await this.#backfillSessions(filePath, fileState, ownSessionId, fileSize);
      const offsetBefore = fileState.offset;
      if (fileSize < fileState.offset) fileState.offset = 0; // truncated or replaced: start over
      if (fileSize === fileState.offset) return false;
      for await (const lines of iterateLineBatches(filePath, fileState)) {
        for (const line of lines) {
          if (!line.includes(SKILL_CALL_NEEDLE)) continue;
          const uses = parseSkillUses(line.toString('utf8'));
          // A resumed or forked chat carries another session's replies; they are counted in their own log.
          if (uses && (!uses.sessionId || uses.sessionId === ownSessionId)) this.#addUses(uses.day, uses.skills, ownSessionId);
        }
      }
      const hadNewData = fileState.offset !== offsetBefore;
      if (hadNewData) this.hasUnsavedChanges = true; // offsets are saved too, or the next start would count the same calls again
      return hadNewData;
    } catch {
      return false; // the file vanished between listing and reading
    }
  }

  /** Version 1 migration: count the already-read bytes (before fileState.offset) into the sessions only. */
  async #backfillSessions(filePath: string, fileState: SkillFileState, ownSessionId: string, fileSize: number) {
    delete fileState.needsSessionBackfill;
    this.hasUnsavedChanges = true;
    if (fileSize < fileState.offset) return; // replaced since: the normal scan starts it over
    const cursor = { offset: 0 };
    for await (const lines of iterateLineBatches(filePath, cursor)) {
      let lineEnd = cursor.offset; // the cursor moves only after the batch is handled
      for (const line of lines) {
        lineEnd += line.length + 1;
        if (lineEnd > fileState.offset) return; // from here on the day counts have not read it either
        if (!line.includes(SKILL_CALL_NEEDLE)) continue;
        const uses = parseSkillUses(line.toString('utf8'));
        if (uses && (!uses.sessionId || uses.sessionId === ownSessionId)) this.#addUses(uses.day, uses.skills, ownSessionId, false);
      }
    }
  }

  #addUses(day: string, skills: string[], sessionId: string, countDay = true) {
    const sessionCounts = (this.sessions[sessionId] ||= {});
    for (const skill of skills) incrementCount(sessionCounts, skill);
    if (!countDay) return;
    const dayCounts = (this.days[day] ||= {});
    for (const skill of skills) incrementCount(dayCounts, skill);
  }

  /** Saves run one after another: two writers on the same temporary file could leave a half-written file. */
  save() {
    const result = this.pendingSaves.then(() => this.#saveNow());
    this.pendingSaves = result.catch(() => {});
    return result;
  }

  async #saveNow() {
    if (!this.hasUnsavedChanges) return;
    this.hasUnsavedChanges = false;
    const temporaryPath = this.filePath + '.tmp';
    try {
      await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fsPromises.writeFile(temporaryPath, JSON.stringify({ version: SKILLS_VERSION, days: this.days, sessions: this.sessions, fileStates: this.fileStates }));
      await fsPromises.rename(temporaryPath, this.filePath);
    } catch (error) {
      this.hasUnsavedChanges = true; // retry on the next flush
      throw error;
    }
  }
}
