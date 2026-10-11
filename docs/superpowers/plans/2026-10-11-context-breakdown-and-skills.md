# Context breakdown and skill usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show what fills the selected session's context (a stacked bar in Usage plus collapsed Details with biggest items and skills used) and the most-used skills across all sessions in Insights.

**Architecture:** `src/breakdown.ts` reads the selected session's log incrementally into an in-memory `SessionTally` (sizes and names only). `src/skills.ts` keeps per-day skill counts in its own `skills.json` with its own read offsets (token history untouched). Pure functions in `view-model.ts` turn both into panel state; the webview script renders it with DOM calls only.

**Tech Stack:** TypeScript (strict, CommonJS), `node:test`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-11-context-breakdown-and-skills-design.md`

## Global Constraints

- No pricing table or cost estimates, no backend, no telemetry, no network calls, no new dependencies.
- Async only: no `*Sync` fs or child_process calls. Reads go through `iterateLineBatches`.
- `const` over `let` (a `let` only for genuine loop state). No one- or two-letter identifiers except `i`, `j`, `id`, `fs`, `os`, `vm`. Functions verb-first camelCase, types PascalCase, constants UPPER_SNAKE.
- Shared types go in `src/types.ts` (`import type`), module-level constants in `src/consts.ts` (except in `src/views/panel.ts`, which runs in the browser and keeps its own).
- Decisions live in `view-model.ts` (pure); `extension.ts` stays wiring.
- The webview renders with `textContent`/DOM calls only. Tool names, file paths, commands and skill names come from log files and are never inserted as HTML. No inline styles: use classes or `style.setProperty`.
- Chat content is never stored. `skills.json` holds skill names and counts only.
- Never guess: with an unknown window size, a single response, or non-positive growth, show no breakdown.
- A persisted shape needs tests for load, save and wrong version (`skills.json`).
- **No commit steps in this plan:** `CLAUDE.md` says do not commit or push unless asked. Leave changes in the working tree.
- Run `npm run lint`, `npm run check` and `npm test` before saying work is done. Say that a real VS Code run, Linux and Windows were not verified.

## Review Focus

Failure modes the spec implies that no happy-path test exercises (each is pinned by a named test below):

1. A user message or tool result whose text contains `"name":"Skill"` must not count as a skill call (Task 4, `parseSkillUses`).
2. A skill or tool name from a log that is HTML (`<img src=x>`) or collides with object internals (`__proto__`, `constructor`) must neither render as HTML nor corrupt counts (Tasks 2, 4, 6).
3. A resumed or forked chat carries another session's replies: its skill calls must be counted once, in their own log (Task 4).
4. The context shrinks after a compaction: growth is not positive, so no breakdown shows, while "Skills used" still does (Tasks 3, 6).
5. A log that is truncated or replaced, or that vanishes while selected, must not crash or double-count the tally (Tasks 2, 7).

---

### Task 1: Shared types, constants and one helper

**Files:**
- Modify: `src/types.ts` (new section after `FileState`; `RangeInsight`; `PanelUsage`)
- Modify: `src/consts.ts`
- Modify: `src/utils.ts`
- Modify: `src/logs.ts:215` (export `getOwnSessionId`)

**Interfaces:**
- Produces: types `ContentKind`, `PendingToolUse`, `ToolResultSize`, `SessionTally`, `BreakdownPart`, `BiggestResult`, `Breakdown`, `SkillDays`, `SkillFileState`; `RangeInsight.skills`; `PanelUsage.breakdown?` / `PanelUsage.skills?`; constants `SKILL_CALL_NEEDLE`, `ATTACHMENT_NEEDLE`, `SKILLS_VERSION`, `NAME_PATTERN`, `TARGET_FIELDS`, `TARGET_MAX_LENGTH`, `TOP_BIGGEST_RESULTS`, `TOP_TOOLS`, `TOP_SKILLS_PER_SESSION`, `CONTENT_KINDS`; helper `incrementCount(counts, name, amount?)`; `getOwnSessionId(filePath)` exported.

- [ ] **Step 1: Add the types to `src/types.ts`**

Insert after the `FileState` interface (before `// ---- chats ----`):

```ts
// ---- breakdown and skills ----

/** What a stretch of context is made of. The fixed baseline is not a kind: it is measured, not split. */
export type ContentKind = 'toolResults' | 'toolCalls' | 'assistantText' | 'assistantThinking' | 'userText' | 'attachments';

/** A tool call whose result has not been read yet. */
export interface PendingToolUse {
  tool: string;
  /** The file, command or pattern the call was about, cut short. */
  target: string;
  turn: number;
}

export interface ToolResultSize {
  tool: string;
  target: string;
  characters: number;
  turn: number;
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
  /** The largest tool results, largest first. */
  biggestResults: ToolResultSize[];
  /** Skill name -> times called in this session. */
  skillCounts: Record<string, number>;
}

export interface BreakdownPart {
  kind: ContentKind;
  /** Estimated tokens. */
  tokens: number;
}

export interface BiggestResult {
  tool: string;
  target: string;
  /** Estimated tokens. */
  tokens: number;
  turn: number;
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
  biggestResults: BiggestResult[];
}

/** Day (YYYY-MM-DD, local) -> skill name -> times called. */
export type SkillDays = Record<string, Record<string, number>>;

/** How far a log file has been read for skill calls. */
export interface SkillFileState {
  offset: number;
}
```

In `RangeInsight`, after `models: NamedAmount[];` add:

```ts
  /** Top five [skill, times called] pairs. */
  skills: NamedAmount[];
```

In `PanelUsage`, after `costLabel?: string;` add:

```ts
  /** Undefined until the window size is known and the context has grown since the first response. */
  breakdown?: Breakdown;
  /** [skill, times called] pairs of the shown session, most used first; empty when none. */
  skills?: NamedAmount[];
```

- [ ] **Step 2: Add the constants to `src/consts.ts`**

Change the type import to `import type { ContentKind, TokenTotals } from './types';` and add a section after `// ---- Session logs ----`'s block (before `// ---- Chat index ----`):

```ts
// ---- Breakdown and skills ----

export const SKILL_CALL_NEEDLE = Buffer.from('"name":"Skill"');
export const ATTACHMENT_NEEDLE = Buffer.from('"type":"attachment"');
export const SKILLS_VERSION = 1;
export const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/; // tool and skill names from logs: no markup, and never "__proto__"
export const TARGET_FIELDS = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'skill'];
export const TARGET_MAX_LENGTH = 80;
export const TOP_BIGGEST_RESULTS = 5;
export const TOP_TOOLS = 5;
export const TOP_SKILLS_PER_SESSION = 5;
export const CONTENT_KINDS = ['toolResults', 'toolCalls', 'assistantText', 'assistantThinking', 'userText', 'attachments'] as const satisfies ContentKind[];
```

- [ ] **Step 3: Add `incrementCount` to `src/utils.ts`** (after `mapValues`)

```ts
/** Add to a named counter. The own-property check keeps names like "constructor" from reading the prototype. */
export function incrementCount(counts: Record<string, number>, name: string, amount = 1) {
  counts[name] = (Object.hasOwn(counts, name) ? counts[name] : 0) + amount;
}
```

- [ ] **Step 4: Export `getOwnSessionId`** in `src/logs.ts`: change `function getOwnSessionId(` to `export function getOwnSessionId(`.

- [ ] **Step 5: Make the build compile**

`RangeInsight.skills` is now required, so `computeInsights` and the panel test's `RANGE` constant no longer type-check. Do the minimum here so Task 1 ends green; Tasks 5 and 6 fill them in properly:

- In `src/view-model.ts`, in `summariseRange`'s returned object add `skills: [],`.
- In `test/panel.test.ts`, in the `RANGE` constant add `skills: []` at the end of the object.

Run: `npm run check && npm test`
Expected: PASS (69 tests, no behaviour change).

---

### Task 2: The session tally (`src/breakdown.ts`)

**Files:**
- Create: `src/breakdown.ts`
- Create: `test/breakdown.test.ts`
- Modify: `test/helpers.ts` (new line builders)

**Interfaces:**
- Consumes: `iterateLineBatches(filePath, cursor)` from `logs.ts`; `SessionTally` and friends; `incrementCount`, `tryParseJson`, `toNonNegativeNumber` from `utils.ts`; constants from Task 1.
- Produces: `createSessionTally(): SessionTally`, `addEntry(tally: SessionTally, entry: any): void`, `readSessionTally(filePath: string, tally: SessionTally): Promise<boolean>` (true when new bytes were read); test helpers `buildAssistantBlockLine(messageId, block, options?)`, `buildSkillLine(skill, options?)`, `buildToolResultLine(toolUseId, content)`.

- [ ] **Step 1: Add the test helpers** to `test/helpers.ts` (after `buildUserLine`)

```ts
/**
 * An assistant log line with one content block. With contextTokens it carries usage (input + cache tokens = the context
 * size); without it the line has no usage, so the token scanner ignores it.
 */
export function buildAssistantBlockLine(
  messageId: string,
  block: object,
  { contextTokens, sessionId = 'session-1', isSidechain = false }: { contextTokens?: number; sessionId?: string; isSidechain?: boolean } = {},
): string {
  const usage = { input_tokens: contextTokens ?? 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 };
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-11T10:00:00.000Z',
    sessionId,
    cwd: '/p/a',
    isSidechain,
    message: { id: messageId, model: ASSISTANT_MODEL, content: [block], ...(contextTokens === undefined ? {} : { usage }) },
  });
}

/** An assistant line in which the Skill tool is called. */
export function buildSkillLine(skill: string, options: { contextTokens?: number; sessionId?: string } = {}): string {
  return buildAssistantBlockLine(`skill-${skill}`, { type: 'tool_use', id: `toolu-${skill}`, name: 'Skill', input: { skill } }, options);
}

/** A user line carrying one tool result. */
export function buildToolResultLine(toolUseId: string, content: unknown): string {
  return JSON.stringify({ type: 'user', cwd: '/p/a', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } });
}
```

- [ ] **Step 2: Write the failing tests** in `test/breakdown.test.ts`

```ts
import test from 'node:test';
import assert from 'node:assert';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createSessionTally, addEntry, readSessionTally } from '../src/breakdown';
import { createTemporaryDirectory, writeTextFile, buildUserLine, buildAssistantBlockLine, buildToolResultLine, buildSkillLine } from './helpers';

function tallyOf(lines: string[]) {
  const tally = createSessionTally();
  for (const line of lines) addEntry(tally, JSON.parse(line));
  return tally;
}

test('the baseline is the first response; what comes after is growth, measured by kind', () => {
  const tally = tallyOf([
    buildUserLine('hello there'), // before the first response: part of the baseline, not growth
    buildAssistantBlockLine('r1', { type: 'text', text: 'abcde' }, { contextTokens: 1000 }),
    buildAssistantBlockLine('r1', { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/a/big.ts' } }, { contextTokens: 1000 }),
    buildToolResultLine('t1', 'x'.repeat(300)),
    buildUserLine('thanks'),
    buildAssistantBlockLine('r2', { type: 'text', text: 'ok' }, { contextTokens: 1500 }),
  ]);
  assert.strictEqual(tally.baselineTokens, 1000);
  assert.strictEqual(tally.latestTokens, 1500);
  assert.strictEqual(tally.turn, 2); // r1 was logged once per content block but is one response
  assert.strictEqual(tally.characters.userText, 6);
  assert.strictEqual(tally.characters.toolResults, 300);
  assert.strictEqual(tally.characters.assistantText, 7);
  assert.strictEqual(tally.characters.toolCalls, JSON.stringify({ file_path: '/p/a/big.ts' }).length);
  assert.deepStrictEqual(tally.toolCharacters, { Read: 300 });
  assert.deepStrictEqual(tally.biggestResults, [{ tool: 'Read', target: '/p/a/big.ts', characters: 300, turn: 1 }]);
  assert.deepStrictEqual(tally.pendingToolUses, {}); // the result arrived
});

test('tool results may be a list of blocks; thinking, attachments and sidechain lines are handled', () => {
  const tally = tallyOf([
    buildAssistantBlockLine('r1', { type: 'text', text: 'a' }, { contextTokens: 100 }),
    JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', content: 'zzzz' } }),
    buildAssistantBlockLine('r2', { type: 'thinking', thinking: 'hmmm' }, { contextTokens: 120 }),
    buildAssistantBlockLine('r2', { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls\n  -la' } }, { contextTokens: 120 }),
    buildToolResultLine('t2', [{ type: 'text', text: 'abc' }, { type: 'image', source: {} }, { type: 'text', text: 'de' }]),
    buildAssistantBlockLine('side', { type: 'text', text: 'ignored' }, { contextTokens: 9999, isSidechain: true }),
  ]);
  assert.strictEqual(tally.characters.assistantThinking, 4);
  assert.ok(tally.characters.attachments > 4); // the attachment object, measured as JSON
  assert.strictEqual(tally.characters.toolResults, 5);
  assert.strictEqual(tally.latestTokens, 120); // the sidechain response did not move it
  assert.strictEqual(tally.biggestResults[0].target, 'ls -la'); // whitespace collapsed
});

test('attachments and messages before the first response belong to the baseline', () => {
  const tally = tallyOf([JSON.stringify({ type: 'attachment', attachment: { type: 'date', content: 'x'.repeat(50) } }), buildUserLine('first prompt')]);
  assert.strictEqual(tally.characters.attachments, 0);
  assert.strictEqual(tally.characters.userText, 0);
  assert.strictEqual(tally.baselineTokens, undefined);
});

test('skills are counted per session, and names that are markup or collide with object internals are kept out of the counts', () => {
  const tally = tallyOf([
    buildAssistantBlockLine('r1', { type: 'text', text: 'a' }, { contextTokens: 100 }),
    buildSkillLine('code-review'),
    buildSkillLine('code-review'),
    buildSkillLine('constructor'),
    buildSkillLine('<img src=x onerror=1>'),
    buildSkillLine('__proto__'),
    buildAssistantBlockLine('r3', { type: 'tool_use', id: 't9', name: '<b>x</b>', input: {} }, { contextTokens: 110 }),
    buildToolResultLine('t9', 'abc'),
  ]);
  assert.deepStrictEqual(Object.entries(tally.skillCounts), [['code-review', 2], ['constructor', 1]]);
  assert.deepStrictEqual(tally.toolCharacters, { other: 3 }); // an unsafe tool name is reported as "other"
});

test('only the largest tool results are kept', () => {
  const lines = Array.from({ length: 8 }, (_, i) => [buildAssistantBlockLine(`r${i}`, { type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `/f${i}` } }, { contextTokens: 100 + i }), buildToolResultLine(`t${i}`, 'x'.repeat((i + 1) * 10))]).flat();
  const tally = tallyOf([buildAssistantBlockLine('r', { type: 'text', text: 'a' }, { contextTokens: 100 }), ...lines]);
  assert.deepStrictEqual(tally.biggestResults.map((result) => result.characters), [80, 70, 60, 50, 40]);
});

test('readSessionTally reads only appended lines, waits for a partial line, and starts over on a shorter file', async () => {
  const directory = await createTemporaryDirectory();
  const logPath = path.join(directory, 's.jsonl');
  const second = buildAssistantBlockLine('r2', { type: 'text', text: 'defgh' }, { contextTokens: 20 });
  await writeTextFile(logPath, buildAssistantBlockLine('r1', { type: 'text', text: 'abc' }, { contextTokens: 10 }) + '\n');
  const tally = createSessionTally();
  assert.strictEqual(await readSessionTally(logPath, tally), true);
  assert.strictEqual(await readSessionTally(logPath, tally), false); // nothing new: stat only
  await fsPromises.appendFile(logPath, second.slice(0, 40));
  assert.strictEqual(await readSessionTally(logPath, tally), false); // a half-written line is left for later
  await fsPromises.appendFile(logPath, second.slice(40) + '\n');
  assert.strictEqual(await readSessionTally(logPath, tally), true);
  assert.strictEqual(tally.characters.assistantText, 8);
  await writeTextFile(logPath, buildAssistantBlockLine('r9', { type: 'text', text: 'z' }, { contextTokens: 5 }) + '\n'); // replaced by a shorter file
  assert.strictEqual(await readSessionTally(logPath, tally), true);
  assert.strictEqual(tally.characters.assistantText, 1);
  assert.strictEqual(tally.baselineTokens, 5);
  await assert.rejects(readSessionTally(path.join(directory, 'gone.jsonl'), tally)); // the caller decides what a vanished log means
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: build FAILS: `Cannot find module '../src/breakdown'`.

- [ ] **Step 4: Implement `src/breakdown.ts`**

```ts
// One session log -> running sizes of what fills its context. Sizes and names only: chat text is never kept.
// Sizes are measured in characters; view-model.ts scales them to the measured growth in tokens.
import { promises as fsPromises } from 'node:fs';
import type { ContentKind, SessionTally } from './types';
import { ASSISTANT_NEEDLE, USER_NEEDLE, ATTACHMENT_NEEDLE, NAME_PATTERN, TARGET_FIELDS, TARGET_MAX_LENGTH, TOP_BIGGEST_RESULTS, CONTENT_KINDS } from './consts';
import { iterateLineBatches } from './logs';
import { tryParseJson, toNonNegativeNumber, incrementCount } from './utils';

export function createSessionTally(): SessionTally {
  return {
    offset: 0,
    turn: 0,
    lastMessageId: '',
    baselineTokens: undefined,
    latestTokens: undefined,
    characters: Object.fromEntries(CONTENT_KINDS.map((kind) => [kind, 0])) as Record<ContentKind, number>,
    toolCharacters: {},
    pendingToolUses: {},
    biggestResults: [],
    skillCounts: {},
  };
}

const lengthOf = (value: unknown): number => (typeof value === 'string' ? value.length : 0);

/** A tool name safe to show; anything else is reported as "other". */
const toToolName = (name: unknown): string => (typeof name === 'string' && NAME_PATTERN.test(name) ? name : 'other');

function describeTarget(input: any): string {
  const field = TARGET_FIELDS.find((name) => typeof input?.[name] === 'string');
  return field ? input[field].replace(/\s+/g, ' ').slice(0, TARGET_MAX_LENGTH) : '';
}

/** A tool result is a string or a list of blocks; only text blocks have a size (images are skipped). */
function measureToolResult(content: unknown): number {
  if (typeof content === 'string') return content.length;
  return Array.isArray(content) ? content.reduce((sum, block) => sum + (block?.type === 'text' ? lengthOf(block.text) : 0), 0) : 0;
}

function recordContextTokens(tally: SessionTally, usage: any) {
  const total = toNonNegativeNumber(usage?.input_tokens) + toNonNegativeNumber(usage?.cache_creation_input_tokens) + toNonNegativeNumber(usage?.cache_read_input_tokens);
  if (!total) return;
  tally.baselineTokens = tally.baselineTokens ?? total;
  tally.latestTokens = total;
}

function addToolUse(tally: SessionTally, block: any) {
  const input = block.input ?? {};
  tally.characters.toolCalls += JSON.stringify(input).length;
  if (block.name === 'Skill' && typeof input.skill === 'string' && NAME_PATTERN.test(input.skill)) incrementCount(tally.skillCounts, input.skill);
  if (typeof block.id === 'string') tally.pendingToolUses[block.id] = { tool: toToolName(block.name), target: describeTarget(input), turn: tally.turn };
}

function addAssistantBlock(tally: SessionTally, block: any) {
  if (block?.type === 'text') tally.characters.assistantText += lengthOf(block.text);
  else if (block?.type === 'thinking') tally.characters.assistantThinking += lengthOf(block.thinking);
  else if (block?.type === 'tool_use') addToolUse(tally, block);
}

function addAssistantEntry(tally: SessionTally, message: any) {
  if (typeof message?.id !== 'string' || message.model === '<synthetic>') return;
  if (message.id !== tally.lastMessageId) {
    tally.turn++;
    tally.lastMessageId = message.id;
  }
  recordContextTokens(tally, message.usage);
  for (const block of Array.isArray(message.content) ? message.content : []) addAssistantBlock(tally, block);
}

function addToolResult(tally: SessionTally, block: any) {
  const characters = measureToolResult(block.content);
  const pending = tally.pendingToolUses[block.tool_use_id];
  delete tally.pendingToolUses[block.tool_use_id];
  const tool = pending?.tool ?? 'other';
  tally.characters.toolResults += characters;
  incrementCount(tally.toolCharacters, tool, characters);
  if (!pending) return;
  tally.biggestResults = [...tally.biggestResults, { tool, target: pending.target, characters, turn: pending.turn }].sort((first, second) => second.characters - first.characters).slice(0, TOP_BIGGEST_RESULTS);
}

/** Before the first response everything is part of the baseline, so user messages and attachments only count after it. */
function addUserEntry(tally: SessionTally, message: any) {
  if (tally.baselineTokens === undefined || !message) return;
  if (typeof message.content === 'string') {
    tally.characters.userText += message.content.length;
    return;
  }
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type === 'tool_result') addToolResult(tally, block);
    else if (block?.type === 'text') tally.characters.userText += lengthOf(block.text);
  }
}

/** Add one parsed log line. Subagent (sidechain) lines are skipped: they are not in the main context. */
export function addEntry(tally: SessionTally, entry: any): void {
  if (entry.isSidechain === true) return;
  if (entry.type === 'assistant') addAssistantEntry(tally, entry.message);
  else if (entry.type === 'user') addUserEntry(tally, entry.message);
  else if (entry.type === 'attachment' && tally.baselineTokens !== undefined) tally.characters.attachments += JSON.stringify(entry.attachment ?? {}).length;
}

const isContentLine = (line: Buffer): boolean => [ASSISTANT_NEEDLE, USER_NEEDLE, ATTACHMENT_NEEDLE].some((needle) => line.includes(needle));

/**
 * Read what the log gained since the last call.
 * @returns true if new complete lines were read
 */
export async function readSessionTally(filePath: string, tally: SessionTally): Promise<boolean> {
  const { size: fileSize } = await fsPromises.stat(filePath); // unchanged logs are never opened
  if (fileSize < tally.offset) Object.assign(tally, createSessionTally()); // truncated or replaced: start over
  if (fileSize === tally.offset) return false;
  const offsetBefore = tally.offset;
  for await (const lines of iterateLineBatches(filePath, tally)) {
    for (const line of lines) {
      if (!isContentLine(line)) continue;
      const entry = tryParseJson(line.toString('utf8'));
      if (entry) addEntry(tally, entry);
    }
  }
  return tally.offset !== offsetBefore;
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npm test 2>&1 | grep -E "breakdown|^ℹ (tests|pass|fail)"` and `npm run lint && npm run check`
Expected: all new tests PASS, `fail 0`, lint and check clean.

---

### Task 3: Turn a tally into a `Breakdown` (pure)

**Files:**
- Modify: `src/view-model.ts`
- Modify: `test/view-model.test.ts`

**Interfaces:**
- Consumes: `SessionTally`, `Breakdown`, `NamedAmount`; `CONTENT_KINDS`, `TOP_TOOLS`, `TOP_SKILLS_PER_SESSION`; the existing private `topByName`.
- Produces: `computeBreakdown(tally: SessionTally, windowSize: number | undefined): Breakdown | undefined`; `topSessionSkills(skillCounts: Record<string, number>): NamedAmount[]`.

- [ ] **Step 1: Write the failing tests** (append to `test/view-model.test.ts`; add `import { createSessionTally } from '../src/breakdown';` to its imports)

```ts
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
  const counts = { a: 1, b: 7, c: 3, d: 2, e: 5, f: 4 };
  assert.deepStrictEqual(viewModel.topSessionSkills(counts), [['b', 7], ['e', 5], ['f', 4], ['c', 3], ['d', 2]]);
  assert.deepStrictEqual(viewModel.topSessionSkills({}), []);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | tail -15`
Expected: FAIL: `viewModel.computeBreakdown is not a function` (build error: property does not exist).

- [ ] **Step 3: Implement in `src/view-model.ts`**

Add `Breakdown` and `SessionTally` to the `import type { ... } from './types'` list, and `TOP_TOOLS, TOP_SKILLS_PER_SESSION, CONTENT_KINDS` to the `./consts` import. Add after `topByName`:

```ts
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
    biggestResults: tally.biggestResults.map(({ tool, target, characters, turn }) => ({ tool, target, tokens: characters * tokensPerCharacter, turn })),
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test 2>&1 | grep -E "computeBreakdown|topSessionSkills|^ℹ (pass|fail)"` and `npm run lint && npm run check`
Expected: PASS, `fail 0`.

---

### Task 4: Skill counts across all sessions (`src/skills.ts`)

**Files:**
- Create: `src/skills.ts`
- Create: `test/skills.test.ts`

**Interfaces:**
- Consumes: `getOwnSessionId`, `iterateLineBatches`, `toDayKey` from `logs.ts`; `SkillDays`, `SkillFileState`; `SKILL_CALL_NEEDLE`, `SKILLS_VERSION`, `NAME_PATTERN`; `tryParseJson`, `tryReadText`, `incrementCount`; test helpers from Task 2.
- Produces: `parseSkillUses(line: string): { day: string; sessionId: string; skills: string[] } | null`; class `SkillHistory` with `days: SkillDays`, `fileStates`, `static load(filePath): Promise<SkillHistory>`, `scan(filePaths: string[]): Promise<boolean>` (serialised; true when any file had new bytes), `save(): Promise<void>`.

- [ ] **Step 1: Write the failing tests** in `test/skills.test.ts`

```ts
import test from 'node:test';
import assert from 'node:assert';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { parseSkillUses, SkillHistory } from '../src/skills';
import { toDayKey } from '../src/logs';
import { createTemporaryDirectory, writeTextFile, buildUserLine, buildSkillLine, buildToolResultLine, buildAssistantBlockLine } from './helpers';

const DAY = toDayKey('2026-10-11T10:00:00.000Z') as string;

test('parseSkillUses counts only assistant tool_use blocks that call Skill with a safe name', () => {
  assert.deepStrictEqual(parseSkillUses(buildSkillLine('code-review')), { day: DAY, sessionId: 'session-1', skills: ['code-review'] });
  assert.strictEqual(parseSkillUses(buildUserLine('{"name":"Skill"}')), null); // the words appear in a user message
  assert.strictEqual(parseSkillUses(buildToolResultLine('t', '"name":"Skill"')), null); // and in a tool result
  assert.strictEqual(parseSkillUses(buildAssistantBlockLine('m', { type: 'text', text: '"name":"Skill"' })), null); // and in assistant text
  assert.strictEqual(parseSkillUses(buildAssistantBlockLine('m', { type: 'tool_use', id: 't', name: 'Read', input: { skill: 'x' } })), null); // another tool
  assert.strictEqual(parseSkillUses(buildSkillLine('<img src=x onerror=1>')), null);
  assert.strictEqual(parseSkillUses(buildSkillLine('__proto__')), null);
  assert.strictEqual(parseSkillUses('{"type":"assistant","timesta'), null); // a truncated line
});

test('SkillHistory counts per day, skips another session\'s replies, reads only new bytes, and survives save and load', async () => {
  const directory = await createTemporaryDirectory();
  const logPath = path.join(directory, 'sess-own.jsonl'); // the session id is the file name
  const lines = [buildSkillLine('code-review', { sessionId: 'sess-own' }), buildSkillLine('code-review', { sessionId: 'sess-other' }), buildSkillLine('constructor', { sessionId: 'sess-own' }), buildUserLine('{"name":"Skill"}')];
  await writeTextFile(logPath, lines.join('\n') + '\n');
  const history = new SkillHistory(path.join(directory, 'skills.json'));
  assert.strictEqual(await history.scan([logPath]), true);
  assert.deepStrictEqual(history.days, { [DAY]: { 'code-review': 1, constructor: 1 } }); // the resumed chat's reply is counted in its own log
  assert.strictEqual(await history.scan([logPath]), false);
  await fsPromises.appendFile(logPath, buildSkillLine('code-review', { sessionId: 'sess-own' }) + '\n');
  assert.strictEqual(await history.scan([logPath]), true);
  assert.strictEqual(history.days[DAY]['code-review'], 2);
  assert.strictEqual(await history.scan([path.join(directory, 'gone.jsonl')]), false); // a log that vanished is not an error
  await history.save();
  const reloaded = await SkillHistory.load(path.join(directory, 'skills.json'));
  assert.deepStrictEqual(reloaded.days, history.days);
  assert.strictEqual(await reloaded.scan([logPath]), false); // offsets were saved, so nothing is counted twice
});

test('a skills file of another version is set aside and rebuilt from the logs', async () => {
  const directory = await createTemporaryDirectory();
  const filePath = path.join(directory, 'skills.json');
  await writeTextFile(filePath, JSON.stringify({ version: 99, days: { '2026-01-01': { old: 1 } }, fileStates: {} }));
  const history = await SkillHistory.load(filePath);
  assert.deepStrictEqual(history.days, {});
  await fsPromises.access(filePath + '.bad');
  assert.strictEqual((await SkillHistory.load(path.join(directory, 'missing.json'))).hasUnsavedChanges, false); // no file: a fresh one
});

test('an unchanged history does not rewrite its file', async () => {
  const directory = await createTemporaryDirectory();
  const history = new SkillHistory(path.join(directory, 'skills.json'));
  await history.save();
  await assert.rejects(fsPromises.access(path.join(directory, 'skills.json')));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | tail -10`
Expected: build FAILS: `Cannot find module '../src/skills'`.

- [ ] **Step 3: Implement `src/skills.ts`**

```ts
// Skill calls found in the session logs, counted per day. Kept in a file of its own (skills.json, with its own read
// offsets) so the token history is never touched. Names and counts only: no chat content.
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import type { SkillDays, SkillFileState } from './types';
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
    if (saved?.version === SKILLS_VERSION && saved.days && saved.fileStates) {
      history.days = saved.days;
      history.fileStates = saved.fileStates;
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
    const offsetBefore = fileState.offset;
    const ownSessionId = getOwnSessionId(filePath);
    try {
      const { size: fileSize } = await fsPromises.stat(filePath);
      if (fileSize < fileState.offset) fileState.offset = 0; // truncated or replaced: start over
      if (fileSize === fileState.offset) return false;
      for await (const lines of iterateLineBatches(filePath, fileState)) {
        for (const line of lines) {
          if (!line.includes(SKILL_CALL_NEEDLE)) continue;
          const uses = parseSkillUses(line.toString('utf8'));
          // A resumed or forked chat carries another session's replies; they are counted in their own log.
          if (uses && (!uses.sessionId || uses.sessionId === ownSessionId)) this.#addUses(uses.day, uses.skills);
        }
      }
    } catch {
      return false; // the file vanished between listing and reading
    }
    const hadNewData = fileState.offset !== offsetBefore;
    this.hasUnsavedChanges ||= hadNewData; // offsets are saved too, or the next start would count the same calls again
    return hadNewData;
  }

  #addUses(day: string, skills: string[]) {
    const counts = (this.days[day] ||= {});
    for (const skill of skills) incrementCount(counts, skill);
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
      await fsPromises.writeFile(temporaryPath, JSON.stringify({ version: SKILLS_VERSION, days: this.days, fileStates: this.fileStates }));
      await fsPromises.rename(temporaryPath, this.filePath);
    } catch (error) {
      this.hasUnsavedChanges = true; // retry on the next flush
      throw error;
    }
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test 2>&1 | grep -E "skills|parseSkillUses|^ℹ (pass|fail)"` and `npm run lint && npm run check`
Expected: PASS, `fail 0`. (If `||=` on a class field trips the linter, write `if (hadNewData) this.hasUnsavedChanges = true;` instead.)

---

### Task 5: Insights and panel state carry skills and the breakdown (pure)

**Files:**
- Modify: `src/view-model.ts` (`summariseRange`, `computeInsights`, `buildPanelState`)
- Modify: `test/view-model.test.ts`

**Interfaces:**
- Consumes: `SkillDays`, `Breakdown`, `NamedAmount`; `topSessionSkills` (Task 3).
- Produces: `computeInsights(historyDays, now, skillDays?: SkillDays)` where each `RangeInsight` has `skills`; `buildPanelState({... breakdown?: Breakdown, sessionSkills?: NamedAmount[]})` filling `usage.breakdown` and `usage.skills`.

- [ ] **Step 1: Write the failing tests** (append to `test/view-model.test.ts`)

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | tail -15`
Expected: FAIL (`ranges[7].skills` is `[]` where `[['code-review', 3], ['brainstorming', 2]]` is expected; `breakdown` property missing).

- [ ] **Step 3: Implement in `src/view-model.ts`**

Add `SkillDays` to the `import type` list. Change `summariseRange` to take the skill days and return them (replace the `skills: [],` stub from Task 1):

```ts
function summariseRange(dates: string[], historyDays: HistoryDays, skillDays: SkillDays): RangeInsight {
```

and inside its returned object, after `models: ...,`:

```ts
    skills: topByName(dates.flatMap((date) => Object.entries(skillDays[date] ?? {})), TOP_ENTRIES_PER_RANGE),
```

Change `computeInsights`'s signature and its `ranges` line:

```ts
export function computeInsights(historyDays: HistoryDays, now: Date, skillDays: SkillDays = {}): Insights {
```
```ts
    ranges: Object.fromEntries(INSIGHT_RANGES.map((count) => [count, summariseRange(dates.slice(-count), historyDays, skillDays)])),
```

In `buildPanelState`, add `breakdown, sessionSkills = []` to the destructured parameters and to the type:

```ts
  breakdown?: Breakdown;
  /** [skill, times called] pairs of the shown session, most used first. */
  sessionSkills?: NamedAmount[];
```

and in the returned `usage` object, after `costLabel: ...,`:

```ts
      breakdown,
      skills: sessionSkills.length ? sessionSkills : undefined,
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test 2>&1 | grep -E "computeInsights|buildPanelState|^ℹ (pass|fail)"` and `npm run lint && npm run check`
Expected: PASS, `fail 0`.

---

### Task 6: The panel draws the bar, the Details and Top skills

**Files:**
- Modify: `src/views/panel.ts`
- Modify: `src/views/panel.css`
- Modify: `test/panel.test.ts`

**Interfaces:**
- Consumes: `PanelState.usage.breakdown` / `.skills`, `RangeInsight.skills`, types `Breakdown`, `ContentKind`, `NamedAmount` (via `import()` types).
- Produces: nothing for later tasks.

No change to `panel.html`: the bar, the toggle and the Details are drawn inside the Context meter by the script.

- [ ] **Step 1: Write the failing tests** in `test/panel.test.ts`

Change the type import to `import type { Breakdown, DayInsight, PanelState, RangeInsight } from '../src/types';`. Replace the `skills: []` stub added to `RANGE` in Task 1 with `skills: [['code-review', 19], ['docs-graph', 9]]`. Add after the `RANGE` constant:

```ts
const BREAKDOWN = {
  baselineTokens: 1000,
  totalTokens: 1600,
  windowSize: 10000,
  parts: [{ kind: 'toolResults', tokens: 450 }, { kind: 'assistantText', tokens: 150 }],
  tools: [['Read', 300], ['Bash', 150]],
  biggestResults: [{ tool: 'Read', target: '<img src=x onerror=1>', tokens: 300, turn: 3 }],
} satisfies Breakdown;
```

Append these tests:

```ts
test('context breakdown: a bar and legend by default, details on demand, log names only as text', async () => {
  const { elementsById, sendState } = await loadPanel();
  sendState({ ...STATE, usage: { ...STATE.usage, breakdown: BREAKDOWN, skills: [['code-review', 8], ['docs-graph', 4]] } });
  const meters = elementsById.meters;
  assert.strictEqual(findAll(meters, hasClass('breakdown-segment')).length, 3); // baseline and two parts
  const segmentWidths = findAll(meters, hasClass('breakdown-segment')).map((segment) => parseFloat(segment.styleProperties.width));
  assert.strictEqual(segmentWidths.reduce((sum, width) => sum + width, 0), 100); // the bar is the whole used context, however full the window is
  assert.deepStrictEqual(findAll(meters, hasClass('breakdown-stack'))[0].styleProperties, {}); // full width: no width of its own
  assert.match(findAll(meters, hasClass('breakdown-legend'))[0].textContent, /Baseline 1\.0k · Tool results ~450 · Assistant text ~150/);
  assert.strictEqual(findAll(meters, hasClass('details')).length, 0); // collapsed by default
  findAll(meters, hasClass('details-toggle'))[0].listeners.click();
  const details = findAll(meters, hasClass('details'))[0];
  assert.match(details.textContent, /Baseline \(fixed\)1\.0k/);
  assert.match(details.textContent, /Read~300/); // per-tool subtotal
  assert.match(details.textContent, /Biggest items/);
  assert.match(details.textContent, /turn 3/);
  assert.match(details.textContent, /Skills used/);
  assert.match(details.textContent, /code-review×8/);
  assert.match(details.textContent, /The split is an estimate/);
  assert.ok(details.textContent.includes('<img src=x onerror=1>')); // shown as text...
  assert.strictEqual(findAll(meters, (element) => element.tagName === 'img').length, 0); // ...never as markup
  findAll(meters, hasClass('details-toggle'))[0].listeners.click();
  assert.strictEqual(findAll(meters, hasClass('details')).length, 0); // and closes again
});

test('context breakdown: skills alone still get a Details toggle, nothing at all gets none', async () => {
  const { elementsById, sendState } = await loadPanel();
  sendState({ ...STATE, usage: { ...STATE.usage, skills: [['code-review', 2]] } });
  assert.strictEqual(findAll(elementsById.meters, hasClass('breakdown-segment')).length, 0); // no breakdown without a window size or growth
  assert.strictEqual(findAll(elementsById.meters, hasClass('details-toggle')).length, 1);
  sendState(STATE);
  assert.strictEqual(findAll(elementsById.meters, hasClass('details-toggle')).length, 0);
});

test('insights list the most used skills for the chosen range, and nothing when there are none', async () => {
  const { elementsById, sendState } = await loadPanel();
  sendState(STATE);
  const text = elementsById['insights-body'].textContent;
  assert.match(text, /Top skills/);
  assert.match(text, /code-review×19/);
  assert.match(text, /Counts uses, not tokens/);
  const noSkills = { ...RANGE, skills: [] };
  sendState({ ...STATE, insights: { ...STATE.insights, ranges: { 7: noSkills, 30: noSkills, 90: noSkills } } });
  assert.doesNotMatch(elementsById['insights-body'].textContent, /Top skills/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | grep -E "context breakdown|insights list|^ℹ (pass|fail)"`
Expected: the three new tests FAIL (no `breakdown-segment` elements; no "Top skills" text).

- [ ] **Step 3: Implement in `src/views/panel.ts`**

Add the type aliases next to the others at the top:

```ts
type Breakdown = import('../types').Breakdown;
type ContentKind = import('../types').ContentKind;
type NamedAmount = import('../types').NamedAmount;
```

In `ViewState`, add after `insightRange: number;`:

```ts
  /** Whether the context Details under the Context meter are open. */
  areDetailsOpen: boolean;
```

In `createViewState`, add after the `insightRange` line: `areDetailsOpen: Boolean(savedState?.areDetailsOpen),`. In `saveViewState`, add `areDetailsOpen: viewState.areDetailsOpen` to the object passed to `vscode.setState`.

Add constants after `UNGROUPED_LABEL`:

```ts
const BASELINE_COLOR = '#6b7280';
const KIND_COLORS: Record<ContentKind, string> = { toolResults: '#f59e0b', toolCalls: '#fb7185', assistantText: '#2979ff', assistantThinking: '#06b6d4', userText: '#a78bfa', attachments: '#34d399' };
const KIND_LABELS: Record<ContentKind, string> = { toolResults: 'Tool results', toolCalls: 'Tool calls', assistantText: 'Assistant text', assistantThinking: 'Thinking', userText: 'Your messages', attachments: 'Attachments' };
const LEGEND_PARTS = 3;
```

Add a shared bar-row helper and the breakdown renderers just before `// ---- chat list ----` (after `sessionLineContent`):

```ts
/** A name with a value on the right and a bar under it. @param fraction 0-1, the bar's length. */
function renderBarRow(name: string, valueLabel: string, fraction: number) {
  return buildElement(
    'div',
    { className: 'bar-row', title: name },
    buildElement('div', { className: 'bar-row-header' }, buildElement('span', {}, name), buildElement('span', {}, valueLabel)),
    buildElement('div', { className: 'bar-row-track' }, buildElement('div', { className: 'bar-row-fill', style: { width: `${fraction * 100}%` } })),
  );
}

/** @param skills Most used first. */
function renderSkillRows(skills: NamedAmount[]) {
  return skills.map(([name, uses]) => renderBarRow(name, `×${uses}`, uses / skills[0][1]));
}

/** One full-width stacked bar of what the used context is made of (the Context meter above shows how full it is), and a one-line legend of the biggest parts. */
function renderBreakdownBar(breakdown: Breakdown) {
  const share = (tokens: number) => `${(tokens / breakdown.totalTokens) * 100}%`;
  const segments = [
    buildElement('div', { className: 'breakdown-segment', title: `Baseline ${formatTokens(breakdown.baselineTokens)}`, style: { width: share(breakdown.baselineTokens), background: BASELINE_COLOR } }),
    ...breakdown.parts.map((part) => buildElement('div', { className: 'breakdown-segment', title: `${KIND_LABELS[part.kind]} ~${formatTokens(part.tokens)}`, style: { width: share(part.tokens), background: KIND_COLORS[part.kind] } })),
  ];
  const legend = [`Baseline ${formatTokens(breakdown.baselineTokens)}`, ...breakdown.parts.slice(0, LEGEND_PARTS).map((part) => `${KIND_LABELS[part.kind]} ~${formatTokens(part.tokens)}`)].join(' · ');
  return [buildElement('div', { className: 'breakdown-stack' }, ...segments), buildElement('div', { className: 'muted breakdown-legend' }, legend)];
}

function renderBreakdownRows(breakdown: Breakdown) {
  const buildRow = (label: string, tokens: number, color: string, isEstimate: boolean, isSub = false) =>
    buildElement('div', { className: 'legend-row' + (isSub ? ' is-sub' : ''), style: { '--swatch-color': color } }, buildElement('span', {}, label), buildElement('span', {}, (isEstimate ? '~' : '') + formatTokens(tokens)));
  return [
    buildRow('Baseline (fixed)', breakdown.baselineTokens, BASELINE_COLOR, false),
    ...breakdown.parts.flatMap((part) => [buildRow(KIND_LABELS[part.kind], part.tokens, KIND_COLORS[part.kind], true), ...(part.kind === 'toolResults' ? breakdown.tools.map(([tool, tokens]) => buildRow(tool, tokens, KIND_COLORS.toolResults, true, true)) : [])]),
  ];
}

function renderBiggestResults(breakdown: Breakdown) {
  if (!breakdown.biggestResults.length) return [];
  const rows = breakdown.biggestResults.map((result) =>
    buildElement(
      'div',
      { className: 'biggest-row', title: result.target },
      buildElement('div', { className: 'biggest-row-header' }, buildElement('span', {}, result.target ? `${result.tool} · ${result.target}` : result.tool), buildElement('span', {}, `~${formatTokens(result.tokens)}`)),
      buildElement('div', { className: 'muted' }, `turn ${result.turn}`),
    ),
  );
  return [buildElement('div', { className: 'subheading' }, 'Biggest items'), ...rows];
}

/** The bar, then a "Details" toggle (closed by default) that opens the parts, the biggest items and the skills used. */
function renderContextDetails(usage: PanelState['usage']) {
  const { breakdown, skills = [] } = usage;
  if (!breakdown && !skills.length) return [];
  const toggle = buildElement(
    'button',
    {
      className: 'link-button details-toggle',
      onClick: () => {
        viewState.areDetailsOpen = !viewState.areDetailsOpen;
        saveViewState();
        renderUsage(usage);
      },
    },
    `${viewState.areDetailsOpen ? '▾' : '▸'} Details`,
  );
  const details = buildElement(
    'div',
    { className: 'details' },
    ...(breakdown ? [...renderBreakdownRows(breakdown), ...renderBiggestResults(breakdown)] : []),
    ...(skills.length ? [buildElement('div', { className: 'subheading' }, 'Skills used'), ...renderSkillRows(skills)] : []),
    breakdown ? buildElement('div', { className: 'estimate-note' }, 'Baseline and total are exact. The split is an estimate.') : null,
  );
  return [...(breakdown ? renderBreakdownBar(breakdown) : []), toggle, ...(viewState.areDetailsOpen ? [details] : [])];
}
```

In `renderUsage`, replace the `const meters = [ ... ];` block with:

```ts
  const contextMeter = usage.context && renderMeter('Context', usage.context, 'var(--vscode-charts-blue)');
  const contextDetails = renderContextDetails(usage);
  if (contextMeter) contextMeter.append(...contextDetails);
  const meters = [
    contextMeter,
    usage.fiveHour && renderMeter('Session (5hr)', usage.fiveHour, 'var(--vscode-charts-orange)'),
    usage.weekly && renderMeter('Weekly (7 day)', usage.weekly, 'var(--vscode-charts-purple)'),
    ...(contextMeter ? [] : contextDetails), // no context meter to sit under: the skills list still shows
    usage.costLabel ? buildElement('div', { className: 'muted' }, 'Session cost ' + usage.costLabel) : null,
  ];
```

Replace the body of `renderTopProjects`'s `rows` with the shared helper:

```ts
  const rows = range.projects.map(([name, tokens]) => renderBarRow(name, `${formatTokens(tokens)} · ${Math.round((tokens / totalTokens) * 100)}%`, tokens / largest));
```

Add after `renderModelMix`:

```ts
function renderTopSkills(range: RangeInsight) {
  if (!range.skills.length) return [];
  return [buildElement('div', { className: 'subheading' }, 'Top skills'), ...renderSkillRows(range.skills), buildElement('div', { className: 'muted skills-note' }, 'From logs still on this computer. Counts uses, not tokens.')];
}
```

and in `renderInsights` add `...renderTopSkills(range)` after `...renderModelMix(range, totalTokens)`.

- [ ] **Step 4: Add the styles** to the end of `src/views/panel.css`

```css
/* Context breakdown */
.breakdown-stack {
  display: flex;
  height: 10px;
  border-radius: 4px;
  overflow: hidden;
  margin-top: 8px;
}

.breakdown-segment {
  height: 100%;
}

.breakdown-legend {
  margin-top: 4px;
}

.details-toggle {
  margin-top: 4px;
}

.details {
  margin-top: 6px;
}

.legend-row.is-sub {
  padding-left: 14px;
  font-size: 11px;
  opacity: 0.8;
}

.legend-row.is-sub > :first-child::before {
  display: none;
}

.biggest-row {
  font-size: 12px;
  margin: 4px 0;
  padding-top: 3px;
  border-top: 1px solid var(--border);
}

.biggest-row-header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.biggest-row-header > :first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.estimate-note {
  font-size: 11px;
  font-style: italic;
  opacity: 0.7;
  margin-top: 6px;
}

.skills-note {
  font-size: 11px;
  margin-top: 4px;
}
```

- [ ] **Step 5: Run to verify**

Run: `npm test 2>&1 | grep -E "context breakdown|insights list|panel|^ℹ (pass|fail)"` and `npm run lint && npm run check`
Expected: PASS, `fail 0`. `npm run check` also type-checks `panel.ts` with DOM types; fix any type error it reports (for example the `style` objects must stay `Record<string, string>`).

---

### Task 7: Wire it into the extension

**Files:**
- Modify: `src/extension.ts`
- Modify: `test/extension.test.ts`

**Interfaces:**
- Consumes: `readSessionTally`, `createSessionTally` (Task 2); `SkillHistory` (Task 4); `computeBreakdown`, `topSessionSkills`, `computeInsights(…, skillDays)`, `buildPanelState({ breakdown, sessionSkills })` (Tasks 3 and 5); `listLogFiles` from `logs.ts`.
- Produces: nothing further.

- [ ] **Step 1: Write the failing test** in `test/extension.test.ts`

In the imports add `buildSkillLine` to the `./helpers` import and `import { pathExists } from '../src/utils';`. In `createFakeHome`, change the Keeper log line to also hold a skill call (the line has no usage, so token totals and the context numbers asserted elsewhere do not change):

```ts
  await writeTextFile(path.join(project, `${KEEPER_ID}.jsonl`), buildAssistantLine('m3', { sessionId: KEEPER_ID }) + '\n' + buildSkillLine('code-review', { sessionId: KEEPER_ID }) + '\n' + JSON.stringify({ type: 'ai-title', aiTitle: 'Keeper' }) + '\n');
```

Append the test:

```ts
test('the pinned session lists its skills, and skills.json keeps the per-day totals', async (testContext) => {
  const { storage, postedStates, send, deactivate, dispose } = await startExtension();
  testContext.after(dispose);
  send({ type: 'open', id: KEEPER_ID });
  await waitUntil(() => postedStates.at(-1)?.usage.skills?.length === 1);
  assert.deepStrictEqual(latestState(postedStates).usage.skills, [['code-review', 1]]);
  assert.strictEqual(latestState(postedStates).usage.breakdown, undefined); // one response: no growth, nothing to split
  const skillsPath = path.join(storage, 'skills.json');
  const deadline = Date.now() + 3000;
  while (!(await pathExists(skillsPath))) {
    if (Date.now() > deadline) throw new Error('skills.json was never written');
    await deactivate(); // saves whatever the scan has found so far
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const saved = JSON.parse(await fsPromises.readFile(skillsPath, 'utf8'));
  assert.deepStrictEqual(Object.values(saved.days), [{ 'code-review': 1 }]); // the Keeper's only skill call, counted once
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "pinned session lists|^ℹ (pass|fail)"`
Expected: FAIL: times out waiting (`usage.skills` is never set).

- [ ] **Step 3: Implement in `src/extension.ts`**

Imports: change `import { History, Scanner } from './logs';` to `import { History, Scanner, listLogFiles } from './logs';` and add:

```ts
import { SkillHistory } from './skills';
import { createSessionTally, readSessionTally } from './breakdown';
```

Add `SessionTally` to the `import type { ... } from './types'` list.

Add class fields after `changedLogFiles`:

```ts
  /** What has been read of the shown session's log, for the context breakdown and its skills. */
  sessionTally: SessionTally = createSessionTally();

  /** The log `sessionTally` belongs to. */
  sessionTallyPath: string | undefined;

  pendingTallyReads: Promise<unknown> = Promise.resolve();
```

Constructor: add `private readonly skillHistory: SkillHistory,` after `private readonly history: History,`. In `create()`, load it with the others:

```ts
    const [history, skillHistory, panelTemplate, windowSizesText] = await Promise.all([
      History.load(path.join(storageDirectory, 'history.json')),
      SkillHistory.load(path.join(storageDirectory, 'skills.json')),
      fsPromises.readFile(path.join(VIEWS_DIRECTORY, 'panel.html'), 'utf8'),
      tryReadText(path.join(storageDirectory, 'windows.json')),
    ]);
    return new ComplementerExtension(context, history, skillHistory, panelTemplate, tryParseJson(windowSizesText ?? '') ?? {});
```

Replace the three `this.scanner.scan(...)` call sites:

- in `start()`: `this.scanLogs().then((hadNewData) => this.onScanComplete(hadNewData)); // the first catch-up runs off the activation path`
- in `scanChangedLogs()`: `this.scanLogs(changedFiles).then((hadNewData) => this.onScanComplete(hadNewData));`
- in `poll()`: `this.scanLogs().then((hadNewData) => this.onScanComplete(hadNewData));`

Add the method next to `scanChangedLogs`:

```ts
  /**
   * Count token usage and skill calls in the given logs, or in every log when none are given.
   * @returns true if either found new data
   */
  async scanLogs(filePaths?: string[]): Promise<boolean> {
    const logFiles = filePaths ?? (await listLogFiles(this.projectsRoot));
    const [hadNewUsage, hadNewSkills] = await Promise.all([this.scanner.scan(logFiles), this.skillHistory.scan(logFiles)]);
    return hadNewUsage || hadNewSkills;
  }
```

Change `flushHistory`:

```ts
  /** Write the history and the skill counts now; VS Code waits for this on shutdown, so nothing is lost. */
  flushHistory() {
    return Promise.all([this.history.save(), this.skillHistory.save()]).catch(() => {});
  }
```

Add the tally methods in the `// ---- rendering ----` section before `postPanel`:

```ts
  /** Point the tally at the shown session's log (dropping the old one) and read what is new in it. */
  followSessionLog(chat: Chat | undefined) {
    if (chat?.filePath !== this.sessionTallyPath) {
      this.sessionTally = createSessionTally();
      this.sessionTallyPath = chat?.filePath;
    }
    this.updateSessionTally();
  }

  updateSessionTally() {
    const filePath = this.sessionTallyPath;
    if (!filePath) return;
    const { sessionTally } = this;
    this.pendingTallyReads = this.pendingTallyReads
      .then(() => readSessionTally(filePath, sessionTally))
      .then((hadNewData) => hadNewData && this.requestRefresh())
      .catch(() => {}); // the log may have vanished; the next refresh tries again
  }
```

In `postPanel`, after the `if (!this.panelView?.visible) return;` line add `this.followSessionLog(meters.chat);`, and extend the `buildPanelState` call and the insights line:

```ts
      insights: viewModel.computeInsights(this.history.days, new Date(), this.skillHistory.days),
      breakdown: viewModel.computeBreakdown(this.sessionTally, meters.contextWindowSize),
      sessionSkills: viewModel.topSessionSkills(this.sessionTally.skillCounts),
```

- [ ] **Step 4: Run to verify it passes, then the whole suite**

Run: `npm test 2>&1 | tail -15`, then `npm run lint && npm run check`
Expected: all tests PASS (the new extension test and the original 69 plus those added in Tasks 2 to 6), `fail 0`, and the process exits (the extension is disposed after each test).

---

### Task 8: Docs, roadmap and spec corrections

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `CHANGELOG.md`
- Modify: `docs/superpowers/plans/roadmap-v1-v2.md`, `docs/superpowers/specs/complementer-design.md`, `docs/superpowers/specs/2026-10-11-context-breakdown-and-skills-design.md`

- [ ] **Step 1: `CLAUDE.md`**

In the Layout block add two lines after the `src/logs.ts` line:

```
src/breakdown.ts        createSessionTally, addEntry, readSessionTally: sizes of what fills the shown session's context (in memory, names and sizes only)
src/skills.ts           parseSkillUses, SkillHistory: per-day skill call counts in skills.json (own file and offsets)
```

In the Commands block change `69 tests` to the new total printed by `npm test` (`ℹ tests N`). Under "Domain facts that bite" add:

```
- Skills are counted from assistant `tool_use` blocks named `Skill` only. Typed `/name` commands cannot be told from built-ins (`/clear`, `/model`), so they are not counted. Names from logs pass `NAME_PATTERN` before they are counted or shown.
- The context breakdown measures sizes in characters and scales them to the measured growth in tokens since the first response: baseline and total are exact, the split is an estimate. No compaction marker has been seen in a real log, so a shrinking context simply shows no breakdown.
```

- [ ] **Step 2: `README.md`**

After the **Insights** bullet in Features add:

```
- **Context breakdown.** Under the Context meter: a bar of what fills the window (fixed baseline, tool results, assistant text, your messages) and, under Details, the biggest items and the skills used in that session. The split is an estimate.
```

Change the Insights bullet's list to end with `... top projects, top skills, model mix and streak.` and the Privacy sentence `It stores only daily token totals, never chat content.` to `It stores only daily token totals and daily skill counts, never chat content.`

- [ ] **Step 3: `CHANGELOG.md`**: add under `## Unreleased` (first bullets):

```
- Context breakdown: a stacked bar under the Context meter shows the fixed baseline and what the session added (tool results, assistant text, your messages, attachments). "Details" lists the biggest items and the skills used.
- Insights: "Top skills" for 7, 30 and 90 days, counted from the logs still on disk into a new `skills.json`.
```

- [ ] **Step 4: Roadmap and spec**

In `roadmap-v1-v2.md`, in the v2 table add `Done` to tasks 1 to 3 by changing the header row to `| # | Task | Done when | Status |` with matching separator and a `Done` cell per row, and add below the table: `Skills used (session) and Top skills (Insights) were added to v2; see the 2026-10-11 spec. Still to verify by hand: the comparison with \`/context\` in a real session.` In `complementer-design.md` add `src/breakdown.ts` and `src/skills.ts` to its layout list with the same one-line descriptions as `CLAUDE.md`.

In `2026-10-11-context-breakdown-and-skills-design.md` make these corrections:
- In "Components / `src/breakdown.ts`", the list of kinds becomes: `tool calls (the arguments the assistant sent), tool results (by tool name), assistant text, assistant thinking, user text, attachments (by attachment type)`.
- In "Facts the design rests on", replace the sentence beginning `**Not verified:**` with `**Not verified:** how a compaction appears in a real log (the sample logs contain none). The breakdown does not look for compaction: when the context shrinks, growth is not positive and no breakdown is shown; skills are counted over the whole log.`
- In "Risks", replace the bullet about thinking blocks with `- Thinking text is empty in the logs sampled (only a signature is stored), so "Thinking" is usually zero and its tokens land in the other parts. The estimate label says so.`
- In "What \"Skills used\" counts" wording inside the Panel section, remove any mention of "since its last compaction".

- [ ] **Step 5: Final verification**

Run: `npm run lint && npm run check && npm test 2>&1 | tail -12`
Expected: lint and check clean; `fail 0`. Then run `git status --short` and confirm only the files named in this plan changed and no `*.vsix`, `out/` or `.superpowers/` file is staged.

State plainly in the final report what was not verified: a real VS Code run of the new UI (bar colours, layout, the CSP), the comparison with `/context` on a real session, the cost on a 50 MB log, compaction behaviour on a real compacted log, and Linux and Windows.

---

## Self-review

- **Spec coverage:** placement in Usage with a collapsed Details (Task 6); baseline + growth split, estimate label, unknown window or no growth shows nothing (Tasks 2, 3, 6); biggest items with turn (Tasks 2, 3, 6); session skills (Tasks 2, 6, 7); Insights Top skills with range switch (Tasks 5, 6); `skills.json` with own offsets, backfill, wrong-version rebuild, resumed-chat filter (Task 4); in-memory incremental tally dropped on selection change (Tasks 2, 7); nothing persisted for the breakdown; docs and corrections (Task 8).
- **Names are consistent across tasks:** `SessionTally`, `createSessionTally`, `addEntry`, `readSessionTally`, `computeBreakdown`, `topSessionSkills`, `SkillHistory`, `parseSkillUses`, `usage.breakdown`, `usage.skills`, `RangeInsight.skills`, `sessionSkills` (the `buildPanelState` parameter), `areDetailsOpen`.
- **Known limitations, stated up front:** the first `skills.json` pass reads every log once, in parallel with the token scan; a log that is truncated and rewritten is recounted from zero (the token history does the same); `Thinking` is usually zero because the logs store no thinking text.
