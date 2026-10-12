// Every shared type of the extension, in one place. Types only: nothing here exists at runtime.

// ---- account ----

export interface Account {
  email: string;
  /** Plan type and seat tier, e.g. "Team · Standard". */
  plan: string;
  organization?: string;
}

// ---- logs and history ----

/** Token counts for one API response (or a sum of many). */
export interface TokenTotals {
  /** Uncached prompt tokens. */
  inputTokens: number;
  /** Prompt tokens written to the cache. */
  cacheCreationTokens: number;
  /** Prompt tokens served from the cache. */
  cacheReadTokens: number;
  /** Tokens the model generated. */
  outputTokens: number;
}

/** One assistant response as logged. */
export interface UsageRecord extends TokenTotals {
  messageId: string;
  timestamp: string;
  sessionId: string;
  workingDirectory: string;
  modelId: string;
  isSidechain: boolean;
}

/** Totals for one day, project and model. */
export interface Bucket extends TokenTotals {
  responseCount: number;
}

/** Totals per day -> working directory -> model. */
export type HistoryDays = Record<string, Record<string, Record<string, Bucket>>>;

/** The most recent response counted for a log file, used to merge repeated content blocks. */
interface LastResponse extends TokenTotals {
  messageId: string;
  day: string;
  workingDirectory: string;
  modelId: string;
}

/** How far a log file has been read. */
export interface FileState {
  /** Byte offset of the first unread complete line. */
  offset: number;
  lastResponse: LastResponse | null;
}

// ---- breakdown and skills ----

/** What a stretch of context is made of. The fixed baseline is not a kind: it is measured, not split. */
export type ContentKind = 'toolResults' | 'toolCalls' | 'assistantText' | 'assistantThinking' | 'userText' | 'attachments';

/** A tool call whose result has not been read yet. */
interface PendingToolUse {
  tool: string;
}

/** What has been read so far from one session log. Sizes and names only: chat text is never kept. */
export interface SessionTally {
  /** Byte offset of the first unread complete line (the cursor for iterateLineBatches). */
  offset: number;
  /** Distinct assistant responses seen so far. */
  turn: number;
  lastMessageId: string;
  /** Context tokens at the first response: the fixed part (system prompt, tools, memory) plus the first prompt. */
  baselineTokens: number | undefined;
  /** Context tokens at the latest response. */
  latestTokens: number | undefined;
  characters: Record<ContentKind, number>;
  /** Tool name -> characters of its results. */
  toolCharacters: Record<string, number>;
  /** Tool use id -> the call, until its result arrives. */
  pendingToolUses: Record<string, PendingToolUse>;
  /** Skill name -> times called in this session. */
  skillCounts: Record<string, number>;
}

interface BreakdownPart {
  kind: ContentKind;
  /** Estimated tokens. */
  tokens: number;
}

/** The context window split into the fixed baseline (exact) and the growth since (estimated by size). */
export interface Breakdown {
  baselineTokens: number;
  totalTokens: number;
  windowSize: number;
  /** Largest first. */
  parts: BreakdownPart[];
  /** Top [tool, estimated tokens] pairs of the tool results. */
  tools: NamedAmount[];
}

/** Day (YYYY-MM-DD, local) -> skill name -> times called. */
export type SkillDays = Record<string, Record<string, number>>;

/** Skill call counts per session id (kept after the chat is deleted, like the day counts). */
export type SkillSessions = Record<string, Record<string, number>>;

/** How far a log file has been read for skill calls. */
export interface SkillFileState {
  offset: number;
  /** Set when a version 1 file is loaded: the bytes before `offset` are read once more for the per-session counts only (the day counts already have them). */
  needsSessionBackfill?: boolean;
}

// ---- chats ----

/** One chat (session) found on disk. */
export interface Chat {
  /** Session id, which is also the log's file name. */
  id: string;
  /** The session's main log. */
  filePath: string;
  /** The project folder the session ran in. */
  workingDirectory: string;
  /** Claude Code's title, else the first prompt, else "(untitled)". */
  title: string;
  /** When the log last changed. */
  modifiedAtMs: number;
  /** Context fill at the session's last main-thread response (input + cache read + cache write). */
  contextTokens?: number;
  /** Model of that last response. */
  modelId?: string;
}

// ---- live feed ----

/** One usage window (the 5-hour or the weekly limit). */
export interface Limit {
  /** Used share, 0-100. */
  percent: number;
  /** When the window resets, in epoch seconds. */
  resetsAt?: number;
}

/**
 * The latest status Claude Code reported for one session. Every field except the ids is optional,
 * because payloads differ by plan and moment.
 */
export interface LiveState {
  sessionId: string;
  workingDirectory: string;
  /** Display name, e.g. "Sonnet 5.5". */
  modelName?: string;
  modelId?: string;
  contextPercent?: number;
  /** Tokens. */
  contextWindowSize?: number;
  /** Tokens currently in the context. */
  contextTokens?: number;
  fiveHourLimit?: Limit;
  weeklyLimit?: Limit;
  costUsd?: number;
  /** Epoch milliseconds the payload was written. */
  updatedAt: number;
}

/** A live payload that tells us a model's context window size. */
export type WindowSizeReport = LiveState & { modelId: string; contextWindowSize: number };

// ---- setup ----

export interface SetupPaths {
  /** Claude Code's settings.json. */
  settingsPath: string;
  /** Where the hook, the backup and the live files live. */
  storageDirectory: string;
  /** The extension's compiled folder, to copy the hook from. */
  sourceDirectory?: string;
  /** Overrides process.platform (for tests). */
  platform?: string;
}

// ---- view model ----

/** A name (project or model) and an amount of tokens. */
export type NamedAmount = [name: string, amount: number];

export interface WindowState {
  percent: number;
  /** Whether the window's reset time has already passed. */
  hasReset: boolean;
}

/** Everything known about the session being shown. */
export interface Meters {
  /** The session's live payload, if it has reported. */
  liveSession: LiveState | undefined;
  /** The session's log, if found. */
  chat: Chat | undefined;
  /** The newest payload carrying plan limits (limits are account-wide). */
  limitsSession: LiveState | undefined;
  fiveHour: WindowState | undefined;
  weekly: WindowState | undefined;
  /** Undefined until the model's window size is known. */
  contextPercent: number | undefined;
  contextTokens: number | undefined;
  contextWindowSize: number | undefined;
  isStale: boolean;
  /** The pinned session's log no longer exists. */
  selectedSessionIsMissing: boolean;
}

/** One bar in the panel. */
export interface MeterView {
  percent: number;
  /** Text shown at the right of the bar. */
  label: string;
  /** Small text under the bar. */
  caption: string;
}

export interface DayInsight {
  /** YYYY-MM-DD, local time. */
  date: string;
  totalTokens: number;
  outputTokens?: number;
  /** Up to three [project, tokens] pairs. */
  topProjects?: NamedAmount[];
}

export interface RangeInsight extends TokenTotals {
  /** Cost Claude Code reported live on these days, like "$4.20"; absent when none was recorded. */
  costLabel?: string;
  /** Top five [project, tokens] pairs. */
  projects: NamedAmount[];
  /** Top five [model id, tokens] pairs. */
  models: NamedAmount[];
  /** Top five [skill, times called] pairs. */
  skills: NamedAmount[];
}

export interface Insights {
  /** The last 60 days, oldest first. */
  days: DayInsight[];
  /** Rollups for 1, 7 and 30 days. */
  ranges: Record<number, RangeInsight>;
  streakDays: number;
  busiestDay?: { date: string; totalTokens: number };
}

// ---- panel ----

export interface PanelChat {
  id: string;
  title: string;
  /** Folder name; empty until the session's log records a folder (a brand-new session). */
  projectName: string;
  /** Full folder path, the group key (two folders can share a name); empty like projectName. */
  projectPath: string;
  /** Whether the folder is inside an open workspace folder. */
  isInWorkspace: boolean;
  modifiedAtMs: number;
  context?: { percent: number };
  /** The session cost Claude Code reported live; absent when this chat never reported one. */
  costLabel?: string;
  /** The chat's most used skills, most used first. */
  skills?: NamedAmount[];
}

interface PanelUsage {
  context?: MeterView;
  fiveHour?: MeterView;
  weekly?: MeterView;
  session?: { title: string; isPinned: boolean };
  /** Undefined until the window size is known and the context has grown since the first response. */
  breakdown?: Breakdown;
  /** [skill, times called] pairs of the shown session, most used first; empty when none. */
  skills?: NamedAmount[];
  /** When the 5-hour and weekly numbers were last received (epoch ms); undefined when there are none. */
  limitsUpdatedAtMs?: number;
  isStale: boolean;
  isLiveOff: boolean;
  note: string;
}

export interface PanelState {
  account?: Account;
  usage: PanelUsage;
  chats: PanelChat[];
  insights: Insights;
  activeChatId?: string;
}

/** What the panel's script posts back to the extension. */
export interface PanelMessage {
  type: 'ready' | 'newChat' | 'select' | 'enable' | 'refreshLimits' | 'open' | 'read' | 'delete' | 'deletePermanently';
  /** A session id. */
  id?: string | null;
}

/** Values substituted into the template's {{placeholders}}. */
export interface PanelTemplateValues {
  /** Lets exactly our script run (the Content-Security-Policy allows nothing else). */
  nonce: string;
  /** The webview's own origin, for the stylesheet. */
  cspSource: string;
  styleUri: string;
  scriptUri: string;
}
