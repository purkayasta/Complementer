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

test('chat index reads only what a log gained, keeps what it learned earlier, and starts over on a shorter log', async () => {
  const projectsRoot = await createTemporaryDirectory();
  const logPath = path.join(projectsRoot, 'proj', 'c1.jsonl');
  await writeTextFile(logPath, [buildUserLine('Fix the login bug please'), buildAssistantLine('m1')].join('\n') + '\n');
  const chatIndex = new ChatIndex(projectsRoot);
  await chatIndex.update();
  const firstSize = (await fsPromises.stat(logPath)).size;
  assert.strictEqual(chatIndex.indexedLogs.get(logPath)?.cursor.offset, firstSize);
  assert.strictEqual(chatIndex.chats[0].title, 'Fix the login bug please');

  await fsPromises.appendFile(logPath, [JSON.stringify({ type: 'ai-title', aiTitle: 'Login bug' }), buildUserLine('A later prompt'), buildAssistantLine('m2')].join('\n') + '\n');
  await chatIndex.update();
  assert.strictEqual(chatIndex.chats[0].title, 'Login bug'); // the title that arrived later wins
  assert.strictEqual(chatIndex.chats[0].workingDirectory, '/p/a'); // learned from the first read, not read again
  assert.strictEqual(chatIndex.indexedLogs.get(logPath)?.cursor.offset, (await fsPromises.stat(logPath)).size);

  await writeTextFile(logPath, buildUserLine('Brand new content') + '\n'); // shorter: replaced
  await chatIndex.update();
  assert.strictEqual(chatIndex.chats[0].title, 'Brand new content');
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

test('a malformed block in a log does not hide the rest of the transcript', async () => {
  const projectsRoot = await createTemporaryDirectory();
  const logPath = path.join(projectsRoot, 'proj', 'c1.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { content: [null, { type: 'text' }, { type: 'tool_result', content: [null, { text: 'ok' }] }, { type: 'text', text: 'Still here' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [null, { type: 'text' }, { type: 'text', text: 'Reply' }] } }),
  ];
  await writeTextFile(logPath, lines.join('\n') + '\n');
  const transcript = await renderTranscript(logPath);
  assert.ok(transcript.includes('Still here') && transcript.includes('Reply') && /result: +ok/.test(transcript));
});
