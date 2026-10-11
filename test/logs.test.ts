import test from 'node:test';
import assert from 'node:assert';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { FileState, UsageRecord } from '../src/types';
import { parseUsageLine, readNewRecords, History, Scanner } from '../src/logs';
import { ASSISTANT_MODEL, createTemporaryDirectory, writeTextFile, buildAssistantLine } from './helpers';

const DAY = '2026-10-11';

function historyFromRecords(messageIds: string[], temporaryDirectory = '/unused'): History {
  const history = new History(path.join(temporaryDirectory, 'history.json'));
  const fileState: FileState = { offset: 0, lastResponse: null };
  for (const messageId of messageIds) {
    const record = parseUsageLine(buildAssistantLine(messageId));
    if (record) history.addRecord(record, fileState);
  }
  return history;
}

test('parseUsageLine accepts assistant usage and ignores everything else', () => {
  assert.deepStrictEqual(parseUsageLine(buildAssistantLine('m1')), {
    messageId: 'm1',
    timestamp: '2026-10-11T10:00:00.000Z',
    sessionId: 'session-1',
    workingDirectory: '/p/a',
    modelId: ASSISTANT_MODEL,
    isSidechain: false,
    inputTokens: 2,
    cacheCreationTokens: 10,
    cacheReadTokens: 100,
    outputTokens: 5,
  });
  assert.strictEqual(parseUsageLine('{"type":"user","note":"output_tokens"}'), null);
  assert.strictEqual(parseUsageLine('{"type":"assistant","output_tokens'), null); // truncated
  assert.strictEqual(parseUsageLine(buildAssistantLine('m2', { model: '<synthetic>' })), null);
  assert.strictEqual(parseUsageLine(buildAssistantLine('m3', { outputTokens: -5 }))?.outputTokens, 0); // a bad number becomes 0
});

test('one response logged as several blocks is counted once', () => {
  const bucket = historyFromRecords(['a', 'a', 'a', 'b']).days[DAY]['/p/a'][ASSISTANT_MODEL];
  assert.deepStrictEqual({ ...bucket }, { inputTokens: 4, cacheCreationTokens: 20, cacheReadTokens: 200, outputTokens: 10, responseCount: 2 });
});

test('a repeat with larger usage adds only the difference', () => {
  const history = new History('/unused');
  const fileState: FileState = { offset: 0, lastResponse: null };
  for (const outputTokens of [5, 9]) {
    const record = parseUsageLine(buildAssistantLine('a', { outputTokens }));
    if (record) history.addRecord(record, fileState);
  }
  assert.strictEqual(history.days[DAY]['/p/a'][ASSISTANT_MODEL].outputTokens, 9);
});

test('readNewRecords is incremental, leaves partial lines, and survives truncation', async () => {
  const logPath = path.join(await createTemporaryDirectory(), 'session.jsonl');
  const fileState: FileState = { offset: 0, lastResponse: null };
  const seenIds: string[] = [];
  const collect = (record: UsageRecord) => seenIds.push(record.messageId);
  const partialLine = buildAssistantLine('b');
  await writeTextFile(logPath, buildAssistantLine('a') + '\n{"type":"user","x":1}\n' + partialLine.slice(0, 40));
  await readNewRecords(logPath, fileState, collect);
  assert.deepStrictEqual(seenIds, ['a']); // the partial line waits
  await fsPromises.appendFile(logPath, partialLine.slice(40) + '\n');
  await readNewRecords(logPath, fileState, collect);
  assert.deepStrictEqual(seenIds, ['a', 'b']);
  await readNewRecords(logPath, fileState, collect);
  assert.deepStrictEqual(seenIds, ['a', 'b']); // nothing new, nothing re-read
  await fsPromises.writeFile(logPath, buildAssistantLine('c') + '\n'); // shorter than before: replaced
  await readNewRecords(logPath, fileState, collect);
  assert.deepStrictEqual(seenIds, ['a', 'b', 'c']);
});

test('Scanner finds main and subagent logs, and history survives save and load without double counting', async () => {
  const projectsRoot = await createTemporaryDirectory();
  await writeTextFile(path.join(projectsRoot, 'proj', 'sess.jsonl'), buildAssistantLine('a', { sessionId: 'sess' }) + '\n');
  await writeTextFile(path.join(projectsRoot, 'proj', 'sess', 'subagents', 'agent-1.jsonl'), buildAssistantLine('z', { outputTokens: 7, isSidechain: true, sessionId: 'sess' }) + '\n');
  const historyPath = path.join(await createTemporaryDirectory(), 'history.json');
  const firstHistory = await History.load(historyPath);
  assert.strictEqual(await new Scanner(projectsRoot, firstHistory).scan(), true);
  await firstHistory.save();
  const reloadedHistory = await History.load(historyPath);
  assert.strictEqual(await new Scanner(projectsRoot, reloadedHistory).scan(), false); // offsets were persisted
  const bucket = reloadedHistory.days[DAY]['/p/a'][ASSISTANT_MODEL];
  assert.strictEqual(bucket.responseCount, 2);
  assert.strictEqual(bucket.outputTokens, 12);
});

test('a version 1 history file is migrated to the descriptive layout', async () => {
  const historyPath = path.join(await createTemporaryDirectory(), 'history.json');
  const version1 = {
    version: 1,
    days: { [DAY]: { '/p/a': { [ASSISTANT_MODEL]: { in: 1, cc: 2, cr: 3, out: 4, n: 5 } } } },
    files: { '/p/log.jsonl': { off: 99, last: { id: 'm1', day: DAY, cwd: '/p/a', model: ASSISTANT_MODEL, in: 1, cc: 2, cr: 3, out: 4 } } },
  };
  await writeTextFile(historyPath, JSON.stringify(version1));
  const history = await History.load(historyPath);
  assert.deepStrictEqual({ ...history.days[DAY]['/p/a'][ASSISTANT_MODEL] }, { inputTokens: 1, cacheCreationTokens: 2, cacheReadTokens: 3, outputTokens: 4, responseCount: 5 });
  assert.strictEqual(history.fileStates['/p/log.jsonl'].offset, 99);
  assert.strictEqual(history.fileStates['/p/log.jsonl'].lastResponse?.messageId, 'm1');
  await history.save();
  assert.strictEqual(JSON.parse(await fsPromises.readFile(historyPath, 'utf8')).version, 2); // saved in the new layout
});

test('a corrupt history file is set aside and a fresh one used', async () => {
  const historyPath = path.join(await createTemporaryDirectory(), 'history.json');
  await writeTextFile(historyPath, '{not json');
  const history = await History.load(historyPath);
  assert.deepStrictEqual(history.days, {});
  await fsPromises.access(historyPath + '.bad');
});

test('overlapping saves never leave a broken history file', async () => {
  const directory = await createTemporaryDirectory();
  const history = historyFromRecords(['a', 'b'], directory);
  const saves = [history.save(), history.save()];
  history.addRecord(parseUsageLine(buildAssistantLine('c')) as UsageRecord, { offset: 0, lastResponse: null });
  saves.push(history.save());
  await Promise.all(saves);
  const saved = JSON.parse(await fsPromises.readFile(path.join(directory, 'history.json'), 'utf8'));
  assert.strictEqual(saved.days[DAY]['/p/a'][ASSISTANT_MODEL].responseCount, 3);
  await assert.rejects(fsPromises.access(path.join(directory, 'history.json.tmp'))); // no leftover temp file
});

test('a log restored after a delete is not counted twice', async () => {
  const directory = await createTemporaryDirectory();
  const logPath = path.join(directory, 'projects', 'p', 'session.jsonl');
  await writeTextFile(logPath, buildAssistantLine('a', { sessionId: 'session' }) + '\n');
  const scanner = new Scanner(path.join(directory, 'projects'), new History(path.join(directory, 'history.json')));
  await scanner.scan();
  const savedLog = await fsPromises.readFile(logPath, 'utf8');
  await fsPromises.rm(logPath); // moved to the Trash
  await scanner.scan();
  await writeTextFile(logPath, savedLog); // restored from the Trash
  await scanner.scan();
  assert.strictEqual(scanner.history.days[DAY]['/p/a'][ASSISTANT_MODEL].responseCount, 1);
});

test('replies another session wrote into a log are not counted here, main or subagent', async () => {
  const projectsRoot = await createTemporaryDirectory();
  const lines = [buildAssistantLine('own', { sessionId: 'sess' }), buildAssistantLine('copied', { sessionId: 'older-session' }), buildAssistantLine('anonymous', { sessionId: '' })];
  await writeTextFile(path.join(projectsRoot, 'proj', 'sess.jsonl'), lines.join('\n') + '\n');
  await writeTextFile(path.join(projectsRoot, 'proj', 'sess', 'subagents', 'agent-1.jsonl'), [buildAssistantLine('sub', { sessionId: 'sess' }), buildAssistantLine('subCopied', { sessionId: 'older-session' })].join('\n') + '\n');
  const scanner = new Scanner(projectsRoot, new History(path.join(projectsRoot, 'history.json')));
  await scanner.scan();
  assert.strictEqual(scanner.history.days[DAY]['/p/a'][ASSISTANT_MODEL].responseCount, 3); // own, anonymous (no id to compare), sub
});
