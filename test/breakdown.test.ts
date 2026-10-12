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

test('when the context shrinks (compaction or a rewind) the old sizes are dropped and the baseline restarts', () => {
  const tally = tallyOf([
    buildAssistantBlockLine('r1', { type: 'text', text: 'a' }, { contextTokens: 1000 }),
    buildAssistantBlockLine('r1', { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/old' } }, { contextTokens: 1000 }),
    buildToolResultLine('t1', 'x'.repeat(500)),
    buildSkillLine('code-review'),
    buildAssistantBlockLine('r2', { type: 'text', text: 'bbb' }, { contextTokens: 5000 }),
    buildAssistantBlockLine('r3', { type: 'text', text: 'c' }, { contextTokens: 1200 }), // compacted: far below the last response
    buildUserLine('after'),
    buildAssistantBlockLine('r4', { type: 'text', text: 'dd' }, { contextTokens: 1300 }),
  ]);
  assert.strictEqual(tally.baselineTokens, 1200);
  assert.strictEqual(tally.latestTokens, 1300);
  assert.strictEqual(tally.characters.toolResults, 0);
  assert.deepStrictEqual(tally.toolCharacters, {});
  assert.strictEqual(tally.characters.userText, 5); // only what came after the shrink
  assert.strictEqual(tally.characters.assistantText, 3); // the replies after the shrink ('c' and 'dd') are new growth
  assert.deepStrictEqual(Object.entries(tally.skillCounts), [['code-review', 1]]); // skills stay: they happened in this session
  assert.strictEqual(tally.turn, 5); // turns keep counting: r1, the skill call, r2, r3, r4
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
