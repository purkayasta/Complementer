// Shared fixtures. Not a test file (the runner only picks up *.test.ts).
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export const ASSISTANT_MODEL = 'claude-sonnet-5-5';

/** @returns A fresh empty directory under the OS temp folder. */
export function createTemporaryDirectory(): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), 'complementer-test-'));
}

/** Write a file, creating parent folders. */
export async function writeTextFile(filePath: string, text = 'x') {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, text);
}

/**
 * One assistant log line, shaped like a real one with the content removed.
 */
export function buildAssistantLine(
  messageId: string,
  { outputTokens = 5, isSidechain = false, sessionId = 'session-1', model = ASSISTANT_MODEL }: { outputTokens?: number; isSidechain?: boolean; sessionId?: string; model?: string } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-11T10:00:00.000Z',
    sessionId,
    cwd: '/p/a',
    isSidechain,
    message: { id: messageId, model, usage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: outputTokens } },
  });
}

export function buildUserLine(text: string): string {
  return JSON.stringify({ type: 'user', cwd: '/p/a', message: { role: 'user', content: text } });
}

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

/**
 * Run a program, feed it stdin, and collect its stdout.
 */
export async function runWithInput(command: string, args: string[], input: string): Promise<{ stdout: string; exitCode: number | null }> {
  const child = spawn(command, args);
  const closed = once(child, 'close'); // listen before reading, so the event cannot be missed
  child.stdin.end(input);
  const outputChunks: Buffer[] = [];
  for await (const chunk of child.stdout) outputChunks.push(chunk);
  const [exitCode] = await closed;
  return { stdout: Buffer.concat(outputChunks).toString('utf8'), exitCode };
}
