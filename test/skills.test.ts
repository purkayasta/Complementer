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
  assert.strictEqual(parseSkillUses(buildToolResultLine('toolu-1', '"name":"Skill"')), null); // and in a tool result
  assert.strictEqual(parseSkillUses(buildAssistantBlockLine('msg-1', { type: 'text', text: '"name":"Skill"' })), null); // and in assistant text
  assert.strictEqual(parseSkillUses(buildAssistantBlockLine('msg-1', { type: 'tool_use', id: 'toolu-1', name: 'Read', input: { skill: 'x' } })), null); // another tool
  assert.strictEqual(parseSkillUses(buildSkillLine('<img src=x onerror=1>')), null);
  assert.strictEqual(parseSkillUses(buildSkillLine('__proto__')), null);
  assert.strictEqual(parseSkillUses('{"type":"assistant","timesta'), null); // a truncated line
});

test("SkillHistory counts per day, skips another session's replies, reads only new bytes, and survives save and load", async () => {
  const directory = await createTemporaryDirectory();
  const logPath = path.join(directory, 'sess-own.jsonl'); // the session id is the file name
  const lines = [buildSkillLine('code-review', { sessionId: 'sess-own' }), buildSkillLine('code-review', { sessionId: 'sess-other' }), buildSkillLine('constructor', { sessionId: 'sess-own' }), buildUserLine('{"name":"Skill"}')];
  await writeTextFile(logPath, lines.join('\n') + '\n');
  const history = new SkillHistory(path.join(directory, 'skills.json'));
  assert.strictEqual(await history.scan([logPath]), true);
  assert.deepStrictEqual(history.days, { [DAY]: { 'code-review': 1, constructor: 1 } }); // the resumed chat's reply is counted in its own log
  assert.deepStrictEqual(history.sessions, { 'sess-own': { 'code-review': 1, constructor: 1 } });
  assert.strictEqual(await history.scan([logPath]), false);
  await fsPromises.appendFile(logPath, buildSkillLine('code-review', { sessionId: 'sess-own' }) + '\n');
  assert.strictEqual(await history.scan([logPath]), true);
  assert.strictEqual(history.days[DAY]['code-review'], 2);
  assert.strictEqual(await history.scan([path.join(directory, 'gone.jsonl')]), false); // a log that vanished is not an error
  await history.save();
  const reloaded = await SkillHistory.load(path.join(directory, 'skills.json'));
  assert.deepStrictEqual(reloaded.days, history.days);
  assert.deepStrictEqual(reloaded.sessions, history.sessions);
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

test('a version 1 skills file keeps its day counts and gets the per-session counts from the logs, once', async () => {
  const directory = await createTemporaryDirectory();
  const logPath = path.join(directory, 'sess-own.jsonl');
  const filePath = path.join(directory, 'skills.json');
  await writeTextFile(logPath, buildSkillLine('code-review', { sessionId: 'sess-own' }) + '\n');
  const { size } = await fsPromises.stat(logPath);
  await fsPromises.appendFile(logPath, buildSkillLine('late', { sessionId: 'sess-own' }) + '\n'); // not read by version 1 yet
  await writeTextFile(filePath, JSON.stringify({ version: 1, days: { [DAY]: { 'code-review': 1, deletedChat: 4 } }, fileStates: { [logPath]: { offset: size } } }));
  const history = await SkillHistory.load(filePath);
  assert.strictEqual(await history.scan([logPath]), true);
  assert.deepStrictEqual(history.sessions, { 'sess-own': { 'code-review': 1, late: 1 } });
  assert.deepStrictEqual(history.days, { [DAY]: { 'code-review': 1, deletedChat: 4, late: 1 } }); // the backfill never touches the days
  await history.save();
  const reloaded = await SkillHistory.load(filePath);
  assert.strictEqual(await reloaded.scan([logPath]), false);
  assert.deepStrictEqual(reloaded.sessions, history.sessions);
});

test('an unchanged history does not rewrite its file', async () => {
  const directory = await createTemporaryDirectory();
  const history = new SkillHistory(path.join(directory, 'skills.json'));
  await history.save();
  await assert.rejects(fsPromises.access(path.join(directory, 'skills.json')));
});
