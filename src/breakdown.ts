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

/** The context shrank (a compaction or a rewind): what was measured before is no longer in it. Skills and turns stay. */
function forgetSizes(tally: SessionTally) {
  Object.assign(tally, { baselineTokens: undefined, toolCharacters: {}, pendingToolUses: {}, biggestResults: [], characters: createSessionTally().characters });
}

function recordContextTokens(tally: SessionTally, usage: any) {
  const total = toNonNegativeNumber(usage?.input_tokens) + toNonNegativeNumber(usage?.cache_creation_input_tokens) + toNonNegativeNumber(usage?.cache_read_input_tokens);
  if (!total) return;
  if (tally.latestTokens !== undefined && total < tally.latestTokens) forgetSizes(tally);
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
