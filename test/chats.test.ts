import test from 'node:test';
import assert from 'node:assert';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Chat } from '../src/types';
import { ChatIndex, renderTranscript, getSessionPaths } from '../src/chats';
import { createTemporaryDirectory, writeTextFile, buildAssistantLine, buildUserLine } from './helpers';

test('chat index finds titles, working directory, context tokens and model, and drops deleted logs', async () => {
  const projectsRoot = await createTemporaryDirectory();
  await writeTextFile(
    path.join(projectsRoot, 'proj', 'c1.jsonl'),
    [buildUserLine('<command-name>x</command-name>'), buildUserLine('Fix the login bug please'), JSON.stringify({ type: 'ai-title', aiTitle: 'Login bug' }), buildAssistantLine('m1')].join('\n') + '\n',
  );
  await writeTextFile(path.join(projectsRoot, 'proj', 'c2.jsonl'), buildUserLine('Second chat, no title yet') + '\n');
  const chatIndex = new ChatIndex(projectsRoot);
  await chatIndex.update();
  assert.ok(chatIndex.chats.every((chat) => chat.workingDirectory === '/p/a'));
  assert.deepStrictEqual(chatIndex.chats.map((chat) => chat.title).sort(), ['Login bug', 'Second chat, no title yet']);
  const titled = chatIndex.chats.find((chat) => chat.title === 'Login bug');
  assert.strictEqual(titled?.contextTokens, 112); // 2 + 10 + 100 from the last main-thread response
  assert.strictEqual(titled?.modelId, 'claude-sonnet-5-5');
  assert.strictEqual(chatIndex.chats.find((chat) => chat.title !== 'Login bug')?.contextTokens, undefined);

  const transcript = await renderTranscript(path.join(projectsRoot, 'proj', 'c1.jsonl'));
  assert.match(transcript, /## You\n\nFix the login bug please/);
  assert.doesNotMatch(transcript, /command-name/); // injected tags are skipped

  await fsPromises.rm(path.join(projectsRoot, 'proj', 'c2.jsonl'));
  await chatIndex.update();
  assert.strictEqual(chatIndex.chats.length, 1); // deleted logs drop out
});

test('largestRecentLogBytes ignores big logs that are not being written', async () => {
  const projectsRoot = await createTemporaryDirectory();
  await writeTextFile(path.join(projectsRoot, 'proj', 'old.jsonl'), buildUserLine('x'.repeat(5000)) + '\n');
  await writeTextFile(path.join(projectsRoot, 'proj', 'new.jsonl'), buildUserLine('y') + '\n');
  const oldTime = new Date(Date.now() - 3600 * 1000);
  await fsPromises.utimes(path.join(projectsRoot, 'proj', 'old.jsonl'), oldTime, oldTime);
  const chatIndex = new ChatIndex(projectsRoot);
  await chatIndex.update();
  const newSize = (await fsPromises.stat(path.join(projectsRoot, 'proj', 'new.jsonl'))).size;
  assert.strictEqual(chatIndex.largestRecentLogBytes(Date.now(), 5 * 60 * 1000), newSize); // the 5 KB log is an hour old
  assert.strictEqual(chatIndex.largestRecentLogBytes(Date.now() + 2 * 3600 * 1000, 5 * 60 * 1000), 0); // nothing recent
});

test('getSessionPaths lists every per-session artifact and refuses anything outside the projects dir', () => {
  const id = '3654788b-e3c4-47bb-a64a-c4e95ea993a3';
  const chat: Chat = { id, filePath: path.join('/h/.claude/projects/proj', id + '.jsonl'), workingDirectory: '', title: 't', modifiedAtMs: 0 };
  const paths = getSessionPaths('/h/.claude', chat);
  assert.strictEqual(paths.length, 7);
  assert.ok(paths.every((sessionPath) => sessionPath.startsWith('/h/.claude/')));
  assert.ok(paths.includes(path.join('/h/.claude/file-history', id)));
  assert.deepStrictEqual(getSessionPaths('/h/.claude', { ...chat, id: '../../etc' }), []);
  assert.deepStrictEqual(getSessionPaths('/h/.claude', { ...chat, filePath: '/etc/' + id + '.jsonl' }), []);
});

test('a "limit reached" notice after a real reply does not blank the chat\'s context', async () => {
  const projectsRoot = await createTemporaryDirectory();
  const lines = [buildUserLine('hello'), buildAssistantLine('m1'), buildAssistantLine('m2', { model: '<synthetic>' })];
  await writeTextFile(path.join(projectsRoot, 'proj', 'c1.jsonl'), lines.join('\n') + '\n');
  const chatIndex = new ChatIndex(projectsRoot);
  await chatIndex.update();
  assert.strictEqual(chatIndex.chats[0].contextTokens, 112);
  assert.strictEqual(chatIndex.chats[0].modelId, 'claude-sonnet-5-5');
});
