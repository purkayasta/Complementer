// What Claude Code tells us: the live feed (the statusLine payload it passes to hook.sh, one small file per session)
// and the signed-in account (the profile it caches in ~/.claude.json: display fields only, no credentials).
import fs from 'node:fs';
import path from 'node:path';
import type { Account, Limit, LiveState, WindowState } from './types';
import { STALE_AFTER_MS, KEEP_FILES_FOR_MS, WATCH_DEBOUNCE_MS } from './consts';
import { tryParseJson, toFiniteNumber, capitalize } from './utils';

const fsPromises = fs.promises;

/** @param rawLimit `rate_limits.five_hour` or `rate_limits.seven_day` from the payload */
function parseLimit(rawLimit: any): Limit | undefined {
  const percent = toFiniteNumber(rawLimit?.used_percentage);
  return percent === undefined ? undefined : { percent, resetsAt: toFiniteNumber(rawLimit.resets_at) };
}

/**
 * @param text The payload JSON.
 * @returns null if it is not a payload with a session id
 */
export function parsePayload(text: string, updatedAt: number): LiveState | null {
  const payload = tryParseJson(text);
  if (!payload || typeof payload.session_id !== 'string') return null;
  const contextWindow = payload.context_window ?? {};
  const currentUsage = contextWindow.current_usage;
  const contextTokens = currentUsage
    ? (toFiniteNumber(currentUsage.input_tokens) ?? 0) + (toFiniteNumber(currentUsage.cache_creation_input_tokens) ?? 0) + (toFiniteNumber(currentUsage.cache_read_input_tokens) ?? 0)
    : undefined;
  return {
    sessionId: payload.session_id,
    workingDirectory: typeof payload.cwd === 'string' ? payload.cwd : '',
    modelName: typeof payload.model?.display_name === 'string' ? payload.model.display_name : undefined,
    modelId: typeof payload.model?.id === 'string' ? payload.model.id : undefined,
    contextPercent: toFiniteNumber(contextWindow.used_percentage),
    contextWindowSize: toFiniteNumber(contextWindow.context_window_size),
    contextTokens,
    fiveHourLimit: parseLimit(payload.rate_limits?.five_hour),
    weeklyLimit: parseLimit(payload.rate_limits?.seven_day),
    costUsd: toFiniteNumber(payload.cost?.total_cost_usd),
    updatedAt,
  };
}

/** True if `childPath` is `folderPath` or inside it. Windows paths compare case-insensitively with either slash style. */
export function isWithin(childPath: string, folderPath: string, ignoreCase = process.platform === 'win32') {
  const normalise = (value: string) => (ignoreCase ? value.replace(/\\/g, '/').toLowerCase() : value).replace(/\/+$/, '');
  const child = normalise(childPath);
  const folder = normalise(folderPath);
  return child === folder || child.startsWith(folder + '/');
}

/** Reducer: keep whichever of two live states was written last. */
function newerSession(newest: LiveState | undefined, candidate: LiveState): LiveState {
  return !newest || candidate.updatedAt > newest.updatedAt ? candidate : newest;
}

/** Context comes from the session in this workspace; plan limits are account-wide, so any newest payload will do. */
export function pickSessions(states: Iterable<LiveState>, workspaceFolders: string[]): { contextSession: LiveState | undefined; limitsSession: LiveState | undefined } {
  const allStates = [...states];
  return {
    contextSession: allStates.filter((state) => workspaceFolders.some((folder) => isWithin(state.workingDirectory, folder))).reduce(newerSession, undefined),
    limitsSession: allStates.filter((state) => state.fiveHourLimit || state.weeklyLimit).reduce(newerSession, undefined),
  };
}

/** A window whose reset time has passed is no longer at its old value. */
export function effectiveLimit(limit: Limit | undefined, nowMs: number): WindowState | undefined {
  if (!limit) return undefined;
  const hasReset = limit.resetsAt !== undefined && limit.resetsAt * 1000 <= nowMs;
  return { percent: hasReset ? 0 : limit.percent, hasReset };
}

export const isStale = (state: LiveState, nowMs: number) => nowMs - state.updatedAt > STALE_AFTER_MS;

export class LiveFeed {
  /** Keyed by file name. */
  states = new Map<string, LiveState>();

  watcher: fs.FSWatcher | undefined;

  flushTimer: NodeJS.Timeout | undefined;

  pendingFiles = new Set<string>();

  /**
   * @param directory Where the hook writes <sessionId>.json files.
   * @param onChange Called after files were re-read.
   */
  constructor(
    private readonly directory: string,
    private readonly onChange: () => void,
  ) {}

  async start() {
    await fsPromises.mkdir(this.directory, { recursive: true });
    await this.reloadAll();
    try {
      this.watcher = fs.watch(this.directory, (_eventType, fileName) => {
        if (!fileName) return;
        this.pendingFiles.add(fileName);
        this.flushTimer ||= setTimeout(() => this.flushPending(), WATCH_DEBOUNCE_MS);
      });
      this.watcher.on('error', () => {});
    } catch {
      // watching is best effort; the extension's periodic refresh still calls reloadAll()
    }
  }

  async flushPending() {
    this.flushTimer = undefined;
    const fileNames = [...this.pendingFiles];
    this.pendingFiles.clear();
    for (const fileName of fileNames) await this.loadFile(fileName);
    this.onChange();
  }

  /** Re-read every file; also the fallback when watching is unavailable. */
  async reloadAll() {
    for (const fileName of await fsPromises.readdir(this.directory).catch(() => [])) await this.loadFile(fileName);
  }

  async loadFile(fileName: string) {
    if (!fileName.endsWith('.json') || fileName.startsWith('.')) return;
    const filePath = path.join(this.directory, fileName);
    try {
      const stats = await fsPromises.stat(filePath);
      if (Date.now() - stats.mtimeMs > KEEP_FILES_FOR_MS) {
        await fsPromises.unlink(filePath).catch(() => {});
        this.states.delete(fileName);
        return;
      }
      const state = parsePayload(await fsPromises.readFile(filePath, 'utf8'), stats.mtimeMs);
      if (state) this.states.set(fileName, state);
    } catch {
      this.states.delete(fileName); // removed or unreadable
    }
  }

  dispose() {
    this.watcher?.close();
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }
}

// ---- account ----

/** "claude_team" -> "Team", "team_standard" -> "Team Standard" */
const prettifyIdentifier = (identifier: string) => identifier.replace(/^claude_/, '').split('_').filter(Boolean).map(capitalize).join(' ');

/**
 * @param claudeConfig The parsed ~/.claude.json
 * @returns undefined when not signed in with an account (for example an API key)
 */
export function parseAccount(claudeConfig: any): Account | undefined {
  const account = claudeConfig?.oauthAccount;
  if (typeof account?.emailAddress !== 'string') return undefined;
  const planType = typeof account.organizationType === 'string' ? prettifyIdentifier(account.organizationType) : '';
  const prettySeatTier = typeof account.seatTier === 'string' ? prettifyIdentifier(account.seatTier) : '';
  const seatTier = prettySeatTier.toLowerCase().startsWith(planType.toLowerCase() + ' ') ? prettySeatTier.slice(planType.length + 1) : prettySeatTier; // "Team Standard" -> "Standard"
  const plan = [planType, seatTier].filter(Boolean).join(' · ') || (typeof account.billingType === 'string' ? prettifyIdentifier(account.billingType) : '');
  return { email: account.emailAddress, plan, organization: typeof account.organizationName === 'string' ? account.organizationName : undefined };
}

export async function readAccount(claudeConfigPath: string): Promise<Account | undefined> {
  try {
    return parseAccount(JSON.parse(await fsPromises.readFile(claudeConfigPath, 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * ~/.claude.json holds all of Claude Code's config and can be large, so it is only parsed when its modification time changed.
 * @param previousModifiedAtMs The modifiedAtMs returned by the last call.
 * @returns undefined if the file has not changed
 */
export async function readAccountIfChanged(claudeConfigPath: string, previousModifiedAtMs: number | undefined): Promise<{ account: Account | undefined; modifiedAtMs: number } | undefined> {
  const stats = await fsPromises.stat(claudeConfigPath).catch(() => undefined);
  const modifiedAtMs = stats?.mtimeMs ?? 0; // 0: no file
  if (modifiedAtMs === previousModifiedAtMs) return undefined;
  return { account: stats ? await readAccount(claudeConfigPath) : undefined, modifiedAtMs };
}
