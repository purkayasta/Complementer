// Pure functions (no VS Code, no I/O) that turn logs, live payloads and history into what the status bar and the
// Sessions panel show. Everything the user sees is decided here, so it can be unit-tested.
import path from 'node:path';
import { pickSessions, isInWorkspace, effectiveLimit, isStale } from './live';
import { toDayKey } from './logs';
import { incrementCount } from './utils';
import type { Account, Bucket, Breakdown, SessionTally, SkillDays, SkillSessions, Chat, HistoryDays, Insights, DayInsight, LiveState, MeterView, Meters, NamedAmount, PanelState, PanelTemplateValues, RangeInsight, TokenTotals, WindowState } from './types';
import { UUID_PATTERN, INSIGHT_DAYS, INSIGHT_RANGES, TOP_PROJECTS_PER_DAY, TOP_ENTRIES_PER_RANGE, TOP_TOOLS, TOP_SKILLS_PER_CHAT, TOP_SKILLS_PER_SESSION, CONTENT_KINDS } from './consts';

export function formatTokens(tokens: number) {
  if (tokens >= 1e9) return (tokens / 1e9).toFixed(1) + 'B';
  if (tokens >= 1e6) return (tokens / 1e6).toFixed(1) + 'M';
  if (tokens >= 1e3) return (tokens / 1e3).toFixed(1) + 'k';
  return String(Math.round(tokens));
}

export const formatPercent = (percent: number) => Math.round(percent) + '%';

/** Live session cost only, as reported by Claude Code. */
export const formatUsd = (dollars: number) => '$' + dollars.toFixed(2);

/** Time until a reset, like "13m", "2h 5m" or "5d"; '' when unknown or already past. */
export function formatResetIn(resetsAtEpochSeconds: number | undefined, nowMs: number) {
  if (!resetsAtEpochSeconds) return '';
  const minutes = Math.round((resetsAtEpochSeconds * 1000 - nowMs) / 60000);
  if (minutes <= 0) return '';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}

/**
 * Context use from a session's log tokens, or undefined until the model's window size is known (no guessing).
 * @param windowSizes Learned from live payloads: model id -> window size in tokens.
 */
function contextFromTokens(contextTokens: number | undefined, modelId: string | undefined, windowSizes: Record<string, number>): { percent: number; tokens: number; windowSize: number } | undefined {
  const windowSize = modelId ? windowSizes[modelId] : undefined;
  return contextTokens !== undefined && windowSize ? { percent: (contextTokens / windowSize) * 100, tokens: contextTokens, windowSize } : undefined;
}

/** Decide which session is shown (the pinned one, else the latest in this workspace) and what its meters read. */
export function computeMeters({ liveStates, chats, workspaceFolders, selectedSessionId, windowSizes, nowMs, ignoredSessionIds }: {
  liveStates: LiveState[];
  chats: Chat[];
  workspaceFolders: string[];
  selectedSessionId: string | undefined;
  windowSizes: Record<string, number>;
  nowMs: number;
  /** Sessions never followed automatically (the Activate helper), though their limits still count. */
  ignoredSessionIds?: ReadonlySet<string>;
}): Meters {
  const { contextSession: automaticSession, limitsSession } = pickSessions(liveStates, workspaceFolders, ignoredSessionIds);
  const selectedChat = selectedSessionId ? chats.find((chat) => chat.id === selectedSessionId) : undefined;
  const chat = selectedChat ?? findAutomaticChat(chats.filter((candidate) => !ignoredSessionIds?.has(candidate.id)), automaticSession, workspaceFolders);
  // A chat newer than the last live report (a brand-new session) has no payload yet: do not show the older session's meters for it.
  const liveSession = chat ? liveStates.find((state) => state.sessionId === chat.id) : automaticSession;
  const hasOutdatedPayload = Boolean(liveSession && chat && isStale(liveSession, nowMs) && chat.modifiedAtMs > liveSession.updatedAt);
  const derived = liveSession?.contextPercent === undefined || hasOutdatedPayload ? contextFromTokens(chat?.contextTokens, chat?.modelId, windowSizes) : undefined;
  return {
    liveSession,
    chat,
    limitsSession,
    fiveHour: effectiveLimit(limitsSession?.fiveHourLimit, nowMs),
    weekly: effectiveLimit(limitsSession?.weeklyLimit, nowMs),
    contextPercent: derived?.percent ?? liveSession?.contextPercent,
    contextTokens: derived?.tokens ?? liveSession?.contextTokens,
    contextWindowSize: derived?.windowSize ?? liveSession?.contextWindowSize,
    isContextEstimated: derived !== undefined,
    isContextStale: hasOutdatedPayload && derived === undefined,
    areLimitsStale: limitsSession ? isStale(limitsSession, nowMs) : false,
    selectedSessionIsMissing: Boolean(selectedSessionId) && !selectedChat,
  };
}

/** The session to show when nothing is pinned: the newest chat in this workspace, else the one that last reported live. */
function findAutomaticChat(chats: Chat[], liveSession: LiveState | undefined, workspaceFolders: string[]): Chat | undefined {
  const newest = chats.filter((chat) => isInWorkspace(chat.workingDirectory, workspaceFolders)).reduce(newerChat, undefined);
  return newest ?? chats.find((chat) => chat.id === liveSession?.sessionId);
}

/** Reducer: keep whichever of two chats was modified last. */
function newerChat(newest: Chat | undefined, candidate: Chat): Chat {
  return !newest || candidate.modifiedAtMs > newest.modifiedAtMs ? candidate : newest;
}

export const projectName = (workingDirectory: string) => path.basename(workingDirectory) || workingDirectory;

const totalTokensOf = (bucket: Bucket): number => bucket.inputTokens + bucket.cacheCreationTokens + bucket.cacheReadTokens + bucket.outputTokens;

/** Reducer: add an amount to the running total of its name. */
function addToTotals(totals: Record<string, number>, [name, amount]: NamedAmount): Record<string, number> {
  return { ...totals, [name]: (Object.hasOwn(totals, name) ? totals[name] : 0) + amount };
}

/** Add up values that share a name, largest first. */
function topByName(namedAmounts: NamedAmount[], limit: number): NamedAmount[] {
  return Object.entries(namedAmounts.reduce(addToTotals, {}))
    .sort((first, second) => second[1] - first[1])
    .slice(0, limit);
}

/** A session's skills, most used first. */
export const topSessionSkills = (skillCounts: Record<string, number>): NamedAmount[] => topByName(Object.entries(skillCounts), TOP_SKILLS_PER_SESSION);

/**
 * Split the context's growth since the first response by the size of what was added. Baseline and total are measured;
 * each part is the growth shared out by characters, so the parts add up to it exactly (an estimate, labelled as one).
 * @returns undefined when the window size is unknown or the context has not grown (never guess)
 */
export function computeBreakdown(tally: SessionTally, windowSize: number | undefined): Breakdown | undefined {
  const { baselineTokens, latestTokens } = tally;
  const totalCharacters = CONTENT_KINDS.reduce((sum, kind) => sum + tally.characters[kind], 0);
  if (!windowSize || baselineTokens === undefined || latestTokens === undefined || totalCharacters <= 0) return undefined;
  const growthTokens = latestTokens - baselineTokens;
  if (growthTokens <= 0) return undefined;
  const tokensPerCharacter = growthTokens / totalCharacters;
  return {
    baselineTokens,
    totalTokens: latestTokens,
    windowSize,
    parts: CONTENT_KINDS.map((kind) => ({ kind, tokens: tally.characters[kind] * tokensPerCharacter }))
      .filter((part) => part.tokens > 0)
      .sort((first, second) => second.tokens - first.tokens),
    tools: topByName(
      Object.entries(tally.toolCharacters).map(([tool, characters]): NamedAmount => [tool, characters * tokensPerCharacter]),
      TOP_TOOLS,
    ),
  };
}

/** The last `count` local days, oldest first. */
function lastDayKeys(now: Date, count: number): string[] {
  return [...Array(count).keys()].map((offset) => toDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (count - 1 - offset)).toISOString()) ?? '');
}

/** The project's name and its total tokens that day. */
function projectTotalOf(workingDirectory: string, byModel: Record<string, Bucket>): NamedAmount {
  return [projectName(workingDirectory), Object.values(byModel).reduce((sum, bucket) => sum + totalTokensOf(bucket), 0)];
}

function summariseDay(date: string, byProject: Record<string, Record<string, Bucket>> | undefined): DayInsight {
  const projectTotals = Object.entries(byProject ?? {}).map(([workingDirectory, byModel]) => projectTotalOf(workingDirectory, byModel));
  const totalTokens = projectTotals.reduce((sum, [, tokens]) => sum + tokens, 0);
  if (!totalTokens) return { date, totalTokens: 0 };
  const outputTokens = Object.values(byProject ?? {}).flatMap((byModel) => Object.values(byModel)).reduce((sum, bucket) => sum + bucket.outputTokens, 0);
  return { date, totalTokens, outputTokens, topProjects: topByName(projectTotals, TOP_PROJECTS_PER_DAY) };
}

function sumTokens(rows: { bucket: Bucket }[], key: keyof TokenTotals): number {
  return rows.reduce((sum, row) => sum + row.bucket[key], 0);
}

/**
 * Raise each real session's saved cost to what Claude Code reports live; the raise is also added to `day`'s cost.
 * Mutates both records. A resumed session starts counting from 0 again, so it adds nothing until it passes its old high.
 * @returns whether anything changed
 */
export function learnCosts(liveStates: LiveState[], sessionCosts: Record<string, number>, dayCosts: Record<string, number>, day: string): boolean {
  const raised = liveStates.filter((state) => UUID_PATTERN.test(state.sessionId) && state.costUsd !== undefined && state.costUsd > (sessionCosts[state.sessionId] ?? 0));
  for (const state of raised) {
    const costUsd = state.costUsd as number;
    incrementCount(dayCosts, day, costUsd - (sessionCosts[state.sessionId] ?? 0));
    sessionCosts[state.sessionId] = costUsd;
  }
  return raised.length > 0;
}

function summariseRange(dates: string[], historyDays: HistoryDays, skillDays: SkillDays, dayCosts: Record<string, number>): RangeInsight {
  const rows = dates.flatMap((date) =>
    Object.entries(historyDays[date] ?? {}).flatMap(([workingDirectory, byModel]) => Object.entries(byModel).map(([modelId, bucket]) => ({ project: projectName(workingDirectory), modelId, bucket }))),
  );
  return {
    inputTokens: sumTokens(rows, 'inputTokens'),
    cacheCreationTokens: sumTokens(rows, 'cacheCreationTokens'),
    cacheReadTokens: sumTokens(rows, 'cacheReadTokens'),
    outputTokens: sumTokens(rows, 'outputTokens'),
    costLabel: dates.some((date) => dayCosts[date] !== undefined) ? formatUsd(dates.reduce((sum, date) => sum + (dayCosts[date] ?? 0), 0)) : undefined,
    projects: topByName(rows.map((row): NamedAmount => [row.project, totalTokensOf(row.bucket)]), TOP_ENTRIES_PER_RANGE),
    models: topByName(rows.map((row): NamedAmount => [row.modelId, totalTokensOf(row.bucket)]), TOP_ENTRIES_PER_RANGE),
    skills: topByName(dates.flatMap((date) => Object.entries(skillDays[date] ?? {})), TOP_ENTRIES_PER_RANGE),
  };
}

/**
 * Consecutive active days ending today (or yesterday, if today has nothing yet).
 * @param days Oldest first.
 */
function countStreak(days: DayInsight[]): number {
  const newestFirst = [...days].reverse();
  const skipToday = newestFirst[0].totalTokens ? 0 : 1;
  const firstGap = newestFirst.slice(skipToday).findIndex((day) => !day.totalTokens);
  return firstGap === -1 ? newestFirst.length - skipToday : firstGap;
}

/** Daily totals for the last 60 days plus 1/7/30-day rollups (by project and model). */
export function computeInsights(historyDays: HistoryDays, now: Date, skillDays: SkillDays = {}, dayCosts: Record<string, number> = {}): Insights {
  const dates = lastDayKeys(now, INSIGHT_DAYS);
  const days = dates.map((date) => summariseDay(date, historyDays[date]));
  const busiest = days.reduce((best, day) => (day.totalTokens > best.totalTokens ? day : best), days[0]);
  return {
    days,
    ranges: Object.fromEntries(INSIGHT_RANGES.map((count) => [count, summariseRange(dates.slice(-count), historyDays, skillDays, dayCosts)])),
    streakDays: countStreak(days),
    busiestDay: busiest.totalTokens ? { date: busiest.date, totalTokens: busiest.totalTokens } : undefined,
  };
}

function toLimitView(windowState: WindowState | undefined, resetsAtEpochSeconds: number | undefined, nowMs: number): MeterView | undefined {
  if (!windowState) return undefined;
  const resetIn = formatResetIn(resetsAtEpochSeconds, nowMs);
  return {
    percent: windowState.percent,
    label: windowState.hasReset ? 'reset' : formatPercent(windowState.percent),
    caption: resetIn ? `Resets in ${resetIn}` : windowState.hasReset ? 'Window has reset' : '',
  };
}

function statusNote(meters: Meters, hasLiveFeed: boolean, hasLiveData: boolean): string {
  if (!hasLiveFeed && !meters.fiveHour) return 'Live meters are off. Click to enable exact values.';
  // Claude Code's chat panel never runs the status line, so only terminal sessions fill the meters.
  if (!hasLiveData) return 'Limits need a Claude terminal session. Press ↻ to start one briefly (a few tokens).';
  // A chat that only ran in the chat panel (a new one, for example) has no payload of its own: its context is read from the log, without cost.
  if (meters.chat && (meters.isContextEstimated || !meters.liveSession)) return 'Context is estimated from the chat log. Press ↻ for its exact context and cost.';
  if (meters.areLimitsStale && meters.isContextStale) return 'Stale: press ↻ to refresh.';
  if (meters.areLimitsStale) return 'Limits are stale: press ↻ to refresh.';
  return meters.isContextStale ? 'Context is stale: press ↻ to refresh.' : '';
}

/** Everything the Sessions panel draws. */
export function buildPanelState({ meters, account, liveStates, isLiveEnabled, chats, workspaceFolders, windowSizes, insights, selectedSessionId, nowMs, breakdown, sessionSkills = [], skillSessions = {}, sessionCosts = {} }: {
  meters: Meters;
  account: Account | undefined;
  liveStates: LiveState[];
  /** Whether our hook is in the user's statusLine; undefined when that is unknown (then old live files decide). */
  isLiveEnabled: boolean | undefined;
  chats: Chat[];
  workspaceFolders: string[];
  windowSizes: Record<string, number>;
  insights: Insights;
  selectedSessionId: string | undefined;
  nowMs: number;
  breakdown?: Breakdown;
  /** [skill, times called] pairs of the shown session, most used first. */
  sessionSkills?: NamedAmount[];
  /** Saved skill counts of every session, for the chat list. */
  skillSessions?: SkillSessions;
  /** Saved cost per session id, for chats whose live payload is gone. */
  sessionCosts?: Record<string, number>;
}): PanelState {
  const liveBySessionId = new Map(liveStates.map((state) => [state.sessionId, state]));
  const panelChats = chats
    .map((chat) => {
      const costUsd = liveBySessionId.get(chat.id)?.costUsd ?? sessionCosts[chat.id];
      const skills = topByName(Object.entries(skillSessions[chat.id] ?? {}), TOP_SKILLS_PER_CHAT);
      const percent = liveBySessionId.get(chat.id)?.contextPercent ?? contextFromTokens(chat.contextTokens, chat.modelId, windowSizes)?.percent;
      return { id: chat.id, title: chat.title, projectName: chat.workingDirectory ? projectName(chat.workingDirectory) : '', projectPath: chat.workingDirectory, isInWorkspace: isInWorkspace(chat.workingDirectory, workspaceFolders), modifiedAtMs: chat.modifiedAtMs, context: percent === undefined ? undefined : { percent }, costLabel: costUsd === undefined ? undefined : formatUsd(costUsd), skills: skills.length ? skills : undefined };
    })
    .sort((first, second) => second.modifiedAtMs - first.modifiedAtMs);
  const hasLiveFeed = isLiveEnabled ?? liveStates.length > 0;
  return {
    account,
    usage: {
      context:
        meters.contextPercent === undefined
          ? undefined
          : {
              percent: meters.contextPercent,
              label: formatPercent(meters.contextPercent),
              caption: meters.contextTokens !== undefined && meters.contextWindowSize ? `${meters.contextTokens.toLocaleString()} / ${meters.contextWindowSize.toLocaleString()} tokens` : '',
            },
      fiveHour: toLimitView(meters.fiveHour, meters.limitsSession?.fiveHourLimit?.resetsAt, nowMs),
      weekly: toLimitView(meters.weekly, meters.limitsSession?.weeklyLimit?.resetsAt, nowMs),
      session: meters.chat ? { title: meters.chat.title, isPinned: Boolean(selectedSessionId) } : undefined,
      breakdown,
      skills: sessionSkills.length ? sessionSkills : undefined,
      limitsUpdatedAtMs: meters.limitsSession?.updatedAt,
      areLimitsStale: meters.areLimitsStale,
      isContextStale: meters.isContextStale,
      isLiveOff: !hasLiveFeed,
      note: statusNote(meters, hasLiveFeed, liveStates.length > 0),
    },
    chats: panelChats,
    insights,
    activeChatId: meters.chat?.id,
  };
}

/** Tokens used on the day of `now`, across every project and model. */
export function computeTodayTokens(historyDays: HistoryDays, now: Date): number {
  const today = toDayKey(now.toISOString()) ?? '';
  return summariseDay(today, historyDays[today]).totalTokens;
}

/** Fill the panel.html template's {{placeholders}}; the browser script itself is views/panel.ts. */
export function renderPanelHtml(template: string, values: PanelTemplateValues): string {
  const replacements = new Map(Object.entries(values));
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name) => replacements.get(name) ?? placeholder);
}
