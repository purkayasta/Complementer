import test from 'node:test';
import assert from 'node:assert';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import type { Chat, LiveState } from '../src/types';
import * as viewModel from '../src/view-model';
import { LARGE_LOG_BYTES } from '../src/consts';
import { createSessionTally } from '../src/breakdown';

const NOW_MS = Date.parse('2026-10-11T12:00:00');
const WINDOW_SIZES = { 'claude-sonnet-5-5': 1000000 };

function chat(id: string, overrides: Partial<Chat> = {}): Chat {
  return { id, filePath: `/logs/${id}.jsonl`, workingDirectory: '/work/app', title: `Chat ${id}`, modifiedAtMs: NOW_MS, contextTokens: 100000, modelId: 'claude-sonnet-5-5', ...overrides };
}

function liveState(sessionId: string, overrides: Partial<LiveState> = {}): LiveState {
  return { sessionId, workingDirectory: '/work/app', contextPercent: 40, contextTokens: 400000, contextWindowSize: 1000000, updatedAt: NOW_MS, ...overrides };
}

/** A reset time that many minutes from NOW_MS, in epoch seconds. */
function minutesFromNow(minutes: number): number {
  return (NOW_MS + minutes * 60000) / 1000;
}

function bucketWithOutput(outputTokens: number) {
  return { inputTokens: 1, cacheCreationTokens: 2, cacheReadTokens: 3, outputTokens, responseCount: 1 };
}

const baseInputs = { liveStates: [], chats: [], workspaceFolders: ['/work/app'], selectedSessionId: undefined, windowSizes: WINDOW_SIZES, nowMs: NOW_MS };

test('formatters', () => {
  assert.strictEqual(viewModel.formatTokens(950), '950');
  assert.strictEqual(viewModel.formatTokens(45_300), '45.3k');
  assert.strictEqual(viewModel.formatTokens(12_400_000), '12.4M');
  assert.strictEqual(viewModel.formatTokens(3_100_000_000), '3.1B');
  assert.strictEqual(viewModel.formatPercent(41.6), '42%');
  assert.strictEqual(viewModel.formatUsd(2.456), '$2.46');
  assert.strictEqual(viewModel.formatResetIn(minutesFromNow(13), NOW_MS), '13m');
  assert.strictEqual(viewModel.formatResetIn(minutesFromNow(125), NOW_MS), '2h 5m');
  assert.strictEqual(viewModel.formatResetIn(minutesFromNow(5 * 24 * 60 + 30), NOW_MS), '5d');
  assert.strictEqual(viewModel.formatResetIn(minutesFromNow(-1), NOW_MS), '');
  assert.strictEqual(viewModel.formatResetIn(undefined, NOW_MS), '');
});

test('computeMeters follows the latest session in the workspace, using its live payload', () => {
  const meters = viewModel.computeMeters({ ...baseInputs, chats: [chat('a')], liveStates: [liveState('a', { fiveHourLimit: { percent: 60 }, costUsd: 1.5 })] });
  assert.strictEqual(meters.chat?.id, 'a');
  assert.strictEqual(meters.contextPercent, 40);
  assert.deepStrictEqual(meters.fiveHour, { percent: 60, hasReset: false });
  assert.strictEqual(meters.selectedSessionIsMissing, false);
});

test('computeMeters: a pinned session wins, and its context comes from its own log when it has not reported live', () => {
  const meters = viewModel.computeMeters({
    ...baseInputs,
    selectedSessionId: 'old',
    chats: [chat('new'), chat('old', { contextTokens: 87455 })],
    liveStates: [liveState('new', { fiveHourLimit: { percent: 20 } })],
  });
  assert.strictEqual(meters.chat?.id, 'old');
  assert.strictEqual(meters.liveSession, undefined);
  assert.ok(Math.abs((meters.contextPercent ?? 0) - 8.7455) < 1e-9); // 87,455 of a learned 1M window
  assert.deepStrictEqual(meters.fiveHour, { percent: 20, hasReset: false }); // limits belong to the account, not the session
});

test('computeMeters shows no context percent until the model window is known', () => {
  const meters = viewModel.computeMeters({ ...baseInputs, chats: [chat('a', { modelId: 'claude-opus-4-7' })] });
  assert.strictEqual(meters.chat?.id, 'a');
  assert.strictEqual(meters.contextPercent, undefined);
  assert.strictEqual(meters.contextTokens, undefined);
});

test('computeMeters reports a pinned session whose log is gone', () => {
  const meters = viewModel.computeMeters({ ...baseInputs, selectedSessionId: 'gone', chats: [chat('a')] });
  assert.strictEqual(meters.selectedSessionIsMissing, true);
  assert.strictEqual(meters.chat?.id, 'a'); // falls back to the latest in the workspace
});

test('computeInsights: ranges, streak, busiest day and per-day detail', () => {
  const historyDays = {
    '2026-10-11': { '/work/app': { 'claude-sonnet-5-5': bucketWithOutput(4) } },
    '2026-10-10': { '/work/app': { 'claude-sonnet-5-5': bucketWithOutput(94) }, '/work/other': { 'claude-opus-5': bucketWithOutput(0) } },
    '2026-10-08': { '/work/app': { 'claude-sonnet-5-5': bucketWithOutput(1) } },
  };
  const insights = viewModel.computeInsights(historyDays, new Date('2026-10-11T12:00:00'));
  assert.strictEqual(insights.days.length, 90);
  assert.strictEqual(insights.days[89].date, '2026-10-11');
  assert.strictEqual(insights.streakDays, 2); // the 11th and 10th; the 9th is empty
  assert.deepStrictEqual(insights.busiestDay, { date: '2026-10-10', totalTokens: 106 });
  assert.deepStrictEqual(insights.days[88].topProjects, [['app', 100], ['other', 6]]);
  const week = insights.ranges[7];
  assert.strictEqual(week.activeDays, 3);
  assert.strictEqual(week.outputTokens, 99);
  assert.deepStrictEqual(week.projects[0], ['app', 117]); // 10 + 100 + 7
  assert.deepStrictEqual(week.models.map(([modelId]) => modelId), ['claude-sonnet-5-5', 'claude-opus-5']);
  assert.strictEqual(viewModel.computeTodayTokens(historyDays, new Date('2026-10-11T12:00:00')), 10);
});

test('computeInsights: an empty today does not break the streak', () => {
  const bucket = { inputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, responseCount: 1 };
  const historyDays = { '2026-10-10': { '/w': { m: bucket } }, '2026-10-09': { '/w': { m: bucket } } };
  assert.strictEqual(viewModel.computeInsights(historyDays, new Date('2026-10-11T12:00:00')).streakDays, 2);
  assert.strictEqual(viewModel.computeInsights({}, new Date('2026-10-11T12:00:00')).busiestDay, undefined);
});

test('chatIndexDelayMs: normal logs refresh every 5 s, a log over 50 MB every 30 s', () => {
  assert.strictEqual(viewModel.chatIndexDelayMs(0), 5000);
  assert.strictEqual(viewModel.chatIndexDelayMs(LARGE_LOG_BYTES), 5000);
  assert.strictEqual(viewModel.chatIndexDelayMs(LARGE_LOG_BYTES + 1), 30000);
});

test('buildPanelState: chat rows carry their own context percent, newest first', () => {
  const meters = viewModel.computeMeters({ ...baseInputs, chats: [chat('a')], liveStates: [liveState('a')] });
  const state = viewModel.buildPanelState({
    meters,
    account: undefined,
    liveStates: [liveState('a')],
    isLiveEnabled: true,
    chats: [chat('old', { modifiedAtMs: NOW_MS - 1000, modelId: 'unknown-model' }), chat('a'), chat('fresh', { workingDirectory: '' })],
    workspaceFolders: ['/work/app'],
    windowSizes: WINDOW_SIZES,
    insights: viewModel.computeInsights({}, new Date(NOW_MS)),
    selectedSessionId: undefined,
    nowMs: NOW_MS,
    skillSessions: { a: { brainstorming: 3, 'code-review': 1, 'writing-plans': 2 } },
  });
  assert.deepStrictEqual(state.chats.find((row) => row.id === 'a')?.skills, [['brainstorming', 3], ['writing-plans', 2]]); // top two
  assert.strictEqual(state.chats.find((row) => row.id === 'old')?.skills, undefined);
  assert.deepStrictEqual(state.chats.map((row) => row.id).sort(), ['a', 'fresh', 'old']);
  assert.strictEqual(state.chats.find((row) => row.id === 'fresh')?.projectName, ''); // no folder recorded yet: ungrouped
  assert.deepStrictEqual(state.chats.map((row) => [row.id, row.isInWorkspace]).sort(), [['a', true], ['fresh', false], ['old', true]]); // 'fresh' has no folder yet
  assert.deepStrictEqual(state.chats.find((row) => row.id === 'a')?.context, { percent: 40 }); // live value
  assert.strictEqual(state.chats.find((row) => row.id === 'old')?.context, undefined); // unknown window: nothing shown
  assert.strictEqual(state.usage.context?.label, '40%');
  assert.strictEqual(state.usage.isLiveOff, false);
  assert.strictEqual(state.activeChatId, 'a');
});

test('the panel script formats tokens exactly like the extension does (the webview cannot require view-model.js)', async () => {
  const source = await fsPromises.readFile(path.join(__dirname, '..', 'src', 'views', 'panel.js'), 'utf8');
  const functionSource = /function formatTokens[\s\S]*?\n}\n/.exec(source)?.[0] ?? '';
  const panelFormatTokens = vm.runInNewContext(`${functionSource}; formatTokens`);
  for (const tokens of [0, 999, 1000, 45_300, 999_999, 12_400_000, 3_100_000_000]) assert.strictEqual(panelFormatTokens(tokens), viewModel.formatTokens(tokens));
});

test('buildPanelState: live meters read as off when the hook is not in statusLine, even with old live files', () => {
  const build = (isLiveEnabled: boolean | undefined) =>
    viewModel.buildPanelState({
      meters: viewModel.computeMeters({ liveStates: [liveState('a')], chats: [], workspaceFolders: ['/work/app'], selectedSessionId: undefined, windowSizes: WINDOW_SIZES, nowMs: NOW_MS }),
      account: undefined,
      liveStates: [liveState('a')],
      isLiveEnabled,
      chats: [],
      workspaceFolders: ['/work/app'],
      windowSizes: WINDOW_SIZES,
      insights: viewModel.computeInsights({}, new Date(NOW_MS)),
      selectedSessionId: undefined,
      nowMs: NOW_MS,
    }).usage;
  assert.strictEqual(build(false).isLiveOff, true);
  assert.match(build(false).note, /Live meters are off/);
  assert.strictEqual(build(true).isLiveOff, false);
  assert.strictEqual(build(undefined).isLiveOff, false); // unknown: the live files decide
});

test('buildPanelState: live on but no payload yet says it is waiting and that only terminal sessions report', () => {
  const { note } = viewModel.buildPanelState({
    meters: viewModel.computeMeters({ liveStates: [], chats: [], workspaceFolders: [], selectedSessionId: undefined, windowSizes: WINDOW_SIZES, nowMs: NOW_MS }),
    account: undefined,
    liveStates: [],
    isLiveEnabled: true,
    chats: [],
    workspaceFolders: [],
    windowSizes: WINDOW_SIZES,
    insights: viewModel.computeInsights({}, new Date(NOW_MS)),
    selectedSessionId: undefined,
    nowMs: NOW_MS,
  }).usage;
  assert.match(note, /terminal session.*↻/);
});

test('computeBreakdown: parts add up to the growth, tools and biggest items are scaled the same way, unknowns show nothing', () => {
  const tally = createSessionTally();
  Object.assign(tally, { baselineTokens: 1000, latestTokens: 1600 });
  tally.characters.toolResults = 300;
  tally.characters.assistantText = 100;
  tally.toolCharacters = { Read: 200, Bash: 100 };
  tally.biggestResults = [{ tool: 'Read', target: 'a.ts', characters: 200, turn: 3 }];
  const breakdown = viewModel.computeBreakdown(tally, 10000);
  assert.ok(breakdown);
  assert.deepStrictEqual(breakdown.parts, [{ kind: 'toolResults', tokens: 450 }, { kind: 'assistantText', tokens: 150 }]); // 600 tokens over 400 characters
  assert.deepStrictEqual(breakdown.tools, [['Read', 300], ['Bash', 150]]);
  assert.deepStrictEqual(breakdown.biggestResults, [{ tool: 'Read', target: 'a.ts', tokens: 300, turn: 3 }]);
  assert.deepStrictEqual([breakdown.baselineTokens, breakdown.totalTokens, breakdown.windowSize], [1000, 1600, 10000]);
  assert.strictEqual(viewModel.computeBreakdown(tally, undefined), undefined); // window size unknown: never guess
  assert.strictEqual(viewModel.computeBreakdown({ ...tally, latestTokens: 900 }, 10000), undefined); // context shrank (compaction): no honest split
  assert.strictEqual(viewModel.computeBreakdown({ ...tally, latestTokens: 1000 }, 10000), undefined); // no growth yet
  assert.strictEqual(viewModel.computeBreakdown(createSessionTally(), 10000), undefined); // nothing read
});

test('topSessionSkills: most used first, at most five', () => {
  const counts = { alpha: 1, beta: 7, gamma: 3, delta: 2, epsilon: 5, zeta: 4 };
  assert.deepStrictEqual(viewModel.topSessionSkills(counts), [['beta', 7], ['epsilon', 5], ['zeta', 4], ['gamma', 3], ['delta', 2]]);
  assert.deepStrictEqual(viewModel.topSessionSkills({}), []);
});

test('computeInsights: top skills follow the range and add up across days', () => {
  const skillDays = { '2026-10-11': { 'code-review': 3, brainstorming: 1 }, '2026-10-05': { brainstorming: 1 }, '2026-09-01': { 'code-review': 10 } };
  const insights = viewModel.computeInsights({}, new Date('2026-10-11T12:00:00'), skillDays);
  assert.deepStrictEqual(insights.ranges[7].skills, [['code-review', 3], ['brainstorming', 2]]);
  assert.deepStrictEqual(insights.ranges[30].skills[0], ['code-review', 3]); // 1 September is 40 days back
  assert.deepStrictEqual(insights.ranges[90].skills[0], ['code-review', 13]);
  assert.deepStrictEqual(viewModel.computeInsights({}, new Date('2026-10-11T12:00:00')).ranges[7].skills, []); // no skill file yet
});

test('buildPanelState: the breakdown and the session skills ride along in usage, and are absent when empty', () => {
  const build = (extra: object) =>
    viewModel.buildPanelState({
      meters: viewModel.computeMeters({ ...baseInputs, chats: [chat('a')], liveStates: [liveState('a')] }),
      account: undefined,
      liveStates: [liveState('a')],
      isLiveEnabled: true,
      chats: [chat('a')],
      workspaceFolders: ['/work/app'],
      windowSizes: WINDOW_SIZES,
      insights: viewModel.computeInsights({}, new Date(NOW_MS)),
      selectedSessionId: undefined,
      nowMs: NOW_MS,
      ...extra,
    }).usage;
  const breakdown = { baselineTokens: 1, totalTokens: 2, windowSize: 10, parts: [], tools: [], biggestResults: [] };
  assert.strictEqual(build({ breakdown, sessionSkills: [['code-review', 2]] }).breakdown, breakdown);
  assert.deepStrictEqual(build({ breakdown, sessionSkills: [['code-review', 2]] }).skills, [['code-review', 2]]);
  assert.strictEqual(build({}).breakdown, undefined);
  assert.strictEqual(build({ sessionSkills: [] }).skills, undefined); // nothing to list: the panel hides the section
});

test('names that match object internals (constructor, toString) are counted like any other', () => {
  assert.deepStrictEqual(viewModel.topSessionSkills({ constructor: 2, toString: 1 }), [['constructor', 2], ['toString', 1]]);
  const insights = viewModel.computeInsights({}, new Date('2026-10-11T12:00:00'), { '2026-10-11': { constructor: 3 }, '2026-10-10': { constructor: 1 } });
  assert.deepStrictEqual(insights.ranges[7].skills, [['constructor', 4]]);
});

test('computeMeters: the Activate helper session feeds the limits but is never the session that is followed', () => {
  const helper = { ...liveState('helper'), workingDirectory: '/work/app', updatedAt: NOW_MS, fiveHourLimit: { percent: 10 }, weeklyLimit: { percent: 31 } };
  const ownChat = { id: 'mine', title: 'Mine', filePath: '/log/mine.jsonl', workingDirectory: '/work/app', modifiedAtMs: NOW_MS - 1000, modelId: 'm', contextTokens: 100 } as Chat;
  const meters = viewModel.computeMeters({ liveStates: [helper], chats: [ownChat], workspaceFolders: ['/work/app'], selectedSessionId: undefined, windowSizes: { m: 1000 }, nowMs: NOW_MS, ignoredSessionIds: new Set(['helper']) });
  assert.strictEqual(meters.chat?.id, 'mine');
  assert.strictEqual(meters.fiveHour?.percent, 10);
  assert.strictEqual(meters.contextPercent, 10);
});
