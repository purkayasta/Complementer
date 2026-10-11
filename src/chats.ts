// Chat history browser: reads session logs on demand, stores nothing. Titles come from Claude Code's own
// "ai-title" records. Only logs still on disk can be listed; Claude Code deletes old ones.
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { listLogFiles, parseUsageLine, iterateLineBatches, readLines } from './logs';
import type { Chat } from './types';
import { USAGE_NEEDLE, TITLE_NEEDLE, WORKING_DIRECTORY_NEEDLE, USER_NEEDLE, ASSISTANT_NEEDLE, SIDECHAIN_NEEDLE, SYNTHETIC_NEEDLE, UUID_PATTERN, MAX_PROMPT_LINES_TO_TRY, MAX_TITLE_LENGTH, MAX_WORKING_DIRECTORY_BYTES } from './consts';
import { tryParseJson, truncate } from './utils';

/** First plain-text prompt of a user entry (a parsed log line), or '' (skips tool results and injected <tags>). */
function extractPromptText(entry: any): string {
  if (!entry || entry.type !== 'user' || entry.isMeta || entry.isSidechain) return '';
  const content = entry.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.find((block: any) => block?.type === 'text')?.text : '';
  return typeof text === 'string' && !text.trimStart().startsWith('<') ? text.trim() : '';
}

/** Accumulates what the single pass over one log finds. Last matching lines are kept as views into the read chunks (no copy) and parsed once, afterwards. */
class LogFindings {
  workingDirectory = '';

  firstPrompt = '';

  promptLinesTried = 0;

  lastUsageLine: Buffer | undefined;

  lastTitleLine: Buffer | undefined;

  observe(line: Buffer) {
    if (line.includes(USAGE_NEEDLE) && line.includes(ASSISTANT_NEEDLE) && !line.includes(SIDECHAIN_NEEDLE) && !line.includes(SYNTHETIC_NEEDLE)) this.lastUsageLine = line;
    if (!this.workingDirectory) this.workingDirectory = readWorkingDirectory(line);
    if (line.includes(TITLE_NEEDLE)) this.lastTitleLine = line; // the last title wins
    else if (!this.firstPrompt && this.promptLinesTried < MAX_PROMPT_LINES_TO_TRY && line.includes(USER_NEEDLE)) {
      this.promptLinesTried++;
      this.firstPrompt = extractPromptText(tryParseJson(line.toString('utf8')));
    }
  }

  /** Claude Code's title, else the first prompt, else "(untitled)". */
  get title(): string {
    const aiTitle = this.lastTitleLine && tryParseJson(this.lastTitleLine.toString('utf8'))?.aiTitle;
    return (typeof aiTitle === 'string' && aiTitle) || this.firstPrompt.split('\n')[0].slice(0, MAX_TITLE_LENGTH) || '(untitled)';
  }
}

async function indexChatLog(filePath: string, modifiedAtMs: number): Promise<Chat> {
  const findings = new LogFindings();
  for await (const lines of iterateLineBatches(filePath, { offset: 0 })) lines.forEach((line) => findings.observe(line));
  const lastUsage = findings.lastUsageLine && parseUsageLine(findings.lastUsageLine.toString('utf8'));
  return {
    id: path.basename(filePath, '.jsonl'),
    filePath,
    workingDirectory: findings.workingDirectory,
    title: findings.title,
    modifiedAtMs,
    contextTokens: lastUsage ? lastUsage.inputTokens + lastUsage.cacheCreationTokens + lastUsage.cacheReadTokens : undefined,
    modelId: lastUsage?.modelId,
  };
}

/** The project folder named in a log line, or '' if the line has none. */
function readWorkingDirectory(line: Buffer) {
  const needleIndex = line.indexOf(WORKING_DIRECTORY_NEEDLE);
  if (needleIndex === -1) return '';
  const valueStart = needleIndex + WORKING_DIRECTORY_NEEDLE.length;
  const valueText = line.subarray(valueStart, valueStart + MAX_WORKING_DIRECTORY_BYTES).toString('utf8');
  return /^[^"]*/.exec(valueText)?.[0].replace(/\\\\/g, '\\') ?? '';
}

export class ChatIndex {
  /** Keyed by log path. */
  indexedLogs = new Map<string, { sizeBytes: number; modifiedAtMs: number; chat: Chat }>();

  /** Rebuilt once per update, so readers never rebuild it. */
  chats: Chat[] = [];

  constructor(private readonly projectsRoot: string) {}

  /** Size of the biggest log that changed recently: re-indexing reads the whole file, so only a big, growing log is costly. */
  largestRecentLogBytes(nowMs: number, recentMs: number): number {
    return Math.max(0, ...[...this.indexedLogs.values()].filter((indexed) => nowMs - indexed.modifiedAtMs < recentMs).map((indexed) => indexed.sizeBytes));
  }

  /** Re-index only logs whose size or modification time changed; drops deleted ones. Subagent logs are not chats. */
  async update() {
    const logFiles = (await listLogFiles(this.projectsRoot)).filter((filePath) => !filePath.includes(`${path.sep}subagents${path.sep}`));
    const existingLogs = new Set(logFiles);
    for (const knownPath of this.indexedLogs.keys()) if (!existingLogs.has(knownPath)) this.indexedLogs.delete(knownPath);
    for (const filePath of logFiles) {
      try {
        const stats = await fsPromises.stat(filePath);
        const indexed = this.indexedLogs.get(filePath);
        if (indexed && indexed.sizeBytes === stats.size && indexed.modifiedAtMs === stats.mtimeMs) continue;
        this.indexedLogs.set(filePath, { sizeBytes: stats.size, modifiedAtMs: stats.mtimeMs, chat: await indexChatLog(filePath, stats.mtimeMs) });
      } catch {
        this.indexedLogs.delete(filePath); // vanished mid-update
      }
    }
    this.chats = [...this.indexedLogs.values()].map((indexed) => indexed.chat);
  }
}

/**
 * Everything Claude Code keeps for one session, as absolute paths (they may not all exist). Empty if the id is not
 * a UUID or the log is not inside <claudeDirectory>/projects, so a bad input can never point at anything else.
 * @param claudeDirectory Usually ~/.claude
 */
export function getSessionPaths(claudeDirectory: string, chat: Chat): string[] {
  const projectsDirectory = path.join(claudeDirectory, 'projects');
  const relativeLogPath = path.relative(projectsDirectory, chat.filePath);
  const isInsideProjects = !relativeLogPath.startsWith('..') && !path.isAbsolute(relativeLogPath);
  if (!UUID_PATTERN.test(chat.id) || !isInsideProjects || path.basename(chat.filePath) !== chat.id + '.jsonl') return [];
  return [
    chat.filePath,
    path.join(path.dirname(chat.filePath), chat.id), // subagent logs and tool results
    path.join(claudeDirectory, 'file-history', chat.id),
    path.join(claudeDirectory, 'session-env', chat.id),
    path.join(claudeDirectory, 'debug', chat.id + '.txt'),
    path.join(claudeDirectory, 'security', `security_warnings_state_${chat.id}.json`),
    path.join(claudeDirectory, 'security', `security_warnings_state_${chat.id}.lock`),
  ];
}

/** Markdown transcript of one chat. Long tool output is cut; thinking and bookkeeping records are left out. */
export async function renderTranscript(filePath: string): Promise<string> {
  const conversationLines = await readLines(filePath, (line) => line.includes(USER_NEEDLE) || line.includes(ASSISTANT_NEEDLE));
  const markdownBlocks = conversationLines.flatMap((line) => entryToMarkdown(tryParseJson(line.toString('utf8'))));
  return markdownBlocks.length ? markdownBlocks.join('\n') : '_No readable messages in this log._';
}

/** @param block A tool_result block's content. */
function toolResultText(block: any): string {
  if (typeof block.content === 'string') return block.content;
  return Array.isArray(block.content) ? block.content.map((part: any) => part.text ?? '').join('\n') : '';
}

/**
 * @param entry A parsed log line.
 * @returns Markdown blocks (empty for entries that are not part of the conversation).
 */
function entryToMarkdown(entry: any): string[] {
  if (!entry || entry.isSidechain || entry.isMeta) return [];
  const content = entry.message?.content;
  if (entry.type === 'user' && typeof content === 'string') return content.trimStart().startsWith('<') ? [] : [`## You\n\n${content.trim()}\n`];
  if (!Array.isArray(content)) return [];
  if (entry.type === 'user') {
    return content.flatMap((block: any) => {
      if (block.type === 'text' && !block.text.trimStart().startsWith('<')) return [`## You\n\n${block.text.trim()}\n`];
      if (block.type === 'tool_result') return [`> result: ${truncate(toolResultText(block).replace(/\n/g, ' '), 300)}\n`];
      return [];
    });
  }
  if (entry.type === 'assistant') {
    return content.flatMap((block: any) => {
      if (block.type === 'text' && block.text.trim()) return [`## Claude\n\n${block.text.trim()}\n`];
      if (block.type === 'tool_use') return [`> tool: **${block.name}** ${truncate(JSON.stringify(block.input ?? {}), 200)}\n`];
      return [];
    });
  }
  return [];
}
