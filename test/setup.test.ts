import test from 'node:test';
import assert from 'node:assert';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import * as setup from '../src/setup';
import { findStorageDirectory, main } from '../src/uninstall';
import type { SetupPaths } from '../src/types';
import { createTemporaryDirectory, writeTextFile, runWithInput } from './helpers';

const sourceDirectory = path.join(__dirname, '..', 'src');

/**
 * A throwaway settings.json and storage folder.
 * @param settingsText Leave out for "no settings file yet".
 * @param storageName Folder name of the storage directory (try spaces and quotes).
 */
async function createSetupPaths(settingsText?: string, platform?: string, storageName = 'store'): Promise<SetupPaths> {
  const directory = await createTemporaryDirectory();
  const settingsPath = path.join(directory, 'settings.json');
  if (settingsText !== undefined) await writeTextFile(settingsPath, settingsText);
  return { settingsPath, storageDirectory: path.join(directory, storageName), sourceDirectory, platform };
}

async function readSettingsFile(settingsPath: string) {
  return JSON.parse(await fsPromises.readFile(settingsPath, 'utf8'));
}

test('enable chains the original command; disable restores settings exactly', async () => {
  const original = JSON.stringify({ model: 'x', statusLine: { type: 'command', command: 'echo hi', padding: 2 }, other: [1] }, null, 2) + '\n';
  const paths = await createSetupPaths(original);
  const originalCommandPath = path.join(paths.storageDirectory, 'original-command');
  assert.deepStrictEqual(await setup.enableStatusLine(paths), { changed: true });
  const enabled = await readSettingsFile(paths.settingsPath);
  assert.ok(enabled.statusLine.command.includes('hook.sh'));
  assert.strictEqual(enabled.statusLine.padding, 2);
  assert.strictEqual(await fsPromises.readFile(originalCommandPath, 'utf8'), 'echo hi');
  assert.deepStrictEqual(await setup.enableStatusLine(paths), { changed: false }); // idempotent
  assert.strictEqual(await fsPromises.readFile(originalCommandPath, 'utf8'), 'echo hi');
  assert.deepStrictEqual(await setup.disableStatusLine(paths), { changed: true });
  assert.deepStrictEqual(await readSettingsFile(paths.settingsPath), JSON.parse(original));
  assert.deepStrictEqual(await setup.disableStatusLine(paths), { changed: false });
});

test('enable with no statusLine, then disable removes the key again', async () => {
  const paths = await createSetupPaths('{"a":1}');
  await setup.enableStatusLine(paths);
  assert.deepStrictEqual(await setup.disableStatusLine(paths), { changed: true });
  assert.deepStrictEqual(await readSettingsFile(paths.settingsPath), { a: 1 });
});

test('disable understands the backup format older versions wrote', async () => {
  const paths = await createSetupPaths(JSON.stringify({ statusLine: { type: 'command', command: 'enabled' } }));
  const hookPath = path.join(paths.storageDirectory, 'hook.sh');
  await writeTextFile(paths.settingsPath, JSON.stringify({ statusLine: { type: 'command', command: `sh '${hookPath}' '${paths.storageDirectory}'` } }));
  await writeTextFile(path.join(paths.storageDirectory, 'statusline-backup.json'), JSON.stringify({ had: true, value: { type: 'command', command: 'bash /x/status.sh' } }));
  await setup.disableStatusLine(paths);
  assert.strictEqual((await readSettingsFile(paths.settingsPath)).statusLine.command, 'bash /x/status.sh');
});

test('refuses files and statusLine types it does not understand', async () => {
  await assert.rejects(setup.enableStatusLine(await createSetupPaths('{broken')), /not plain JSON/);
  await assert.rejects(setup.enableStatusLine(await createSetupPaths('{"statusLine":{"type":"other"}}')), /not a command type/);
});

test('hook.sh saves the payload and passes stdin to the original command', async () => {
  const paths = await createSetupPaths('{"statusLine":{"type":"command","command":"cat"}}');
  await setup.enableStatusLine(paths);
  const payload = '{"session_id":"s-1","cwd":"/x","note":"it\'s fine"}';
  const hookPath = path.join(paths.storageDirectory, 'hook.sh');
  const result = await runWithInput('sh', [hookPath, paths.storageDirectory], payload);
  assert.strictEqual(result.stdout.trim(), payload); // the user's command still sees and prints the payload
  assert.strictEqual(await fsPromises.readFile(path.join(paths.storageDirectory, 'live', 's-1.json'), 'utf8'), payload);
  const unsafe = await runWithInput('sh', [hookPath, paths.storageDirectory], '{"session_id":"../evil"}');
  assert.strictEqual(unsafe.exitCode, 0);
  assert.deepStrictEqual(await fsPromises.readdir(path.join(paths.storageDirectory, 'live')), ['s-1.json']); // an unsafe id is not written
});

test('windows mode installs the node hook, quotes with double quotes, and restores on disable', async () => {
  const paths = await createSetupPaths('{"statusLine":{"type":"command","command":"cat"}}', 'win32');
  await setup.enableStatusLine(paths);
  const hookPath = path.join(paths.storageDirectory, 'hook.js');
  assert.strictEqual((await readSettingsFile(paths.settingsPath)).statusLine.command, `node "${hookPath}" "${paths.storageDirectory}"`);
  await fsPromises.access(hookPath);
  assert.deepStrictEqual(await setup.disableStatusLine(paths), { changed: true });
  assert.strictEqual((await readSettingsFile(paths.settingsPath)).statusLine.command, 'cat');
});

test('the node hook saves the payload and passes stdin through, like hook.sh', async () => {
  const paths = await createSetupPaths('{"statusLine":{"type":"command","command":"cat"}}', 'win32');
  await setup.enableStatusLine(paths);
  const hookPath = path.join(paths.storageDirectory, 'hook.js');
  const payload = '{"session_id":"s-9","cwd":"C:\\\\x"}';
  const result = await runWithInput('node', [hookPath, paths.storageDirectory], payload);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout.trim(), payload);
  assert.strictEqual(await fsPromises.readFile(path.join(paths.storageDirectory, 'live', 's-9.json'), 'utf8'), payload);
  await runWithInput('node', [hookPath, paths.storageDirectory], '{"session_id":"../evil"}');
  assert.deepStrictEqual(await fsPromises.readdir(path.join(paths.storageDirectory, 'live')), ['s-9.json']);
});

test('disable still restores the status line when the backup file is gone', async () => {
  const paths = await createSetupPaths('{"statusLine":{"type":"command","command":"echo hi","padding":1}}');
  await setup.enableStatusLine(paths);
  await fsPromises.rm(path.join(paths.storageDirectory, 'statusline-backup.json'));
  assert.deepStrictEqual(await setup.disableStatusLine(paths), { changed: true });
  assert.deepStrictEqual((await readSettingsFile(paths.settingsPath)).statusLine, { type: 'command', command: 'echo hi', padding: 1 });
});

test('the uninstall script finds this extension\'s storage directory and nobody else\'s', async () => {
  assert.strictEqual(findStorageDirectory("sh '/u/globalStorage/me.complementer/hook.sh' '/u/globalStorage/me.complementer'"), '/u/globalStorage/me.complementer');
  assert.strictEqual(findStorageDirectory('node "C:\\g\\me.complementer\\hook.js" "C:\\g\\me.complementer"'), 'C:\\g\\me.complementer');
  assert.strictEqual(findStorageDirectory('bash /home/me/status.sh'), undefined);
  assert.strictEqual(findStorageDirectory(undefined), undefined);
});

test('a statusLine with no command can still be enabled and disabled', async () => {
  const paths = await createSetupPaths('{"statusLine":{"type":"command"}}');
  await setup.enableStatusLine(paths);
  assert.strictEqual(await fsPromises.readFile(path.join(paths.storageDirectory, 'original-command'), 'utf8'), '');
  await setup.disableStatusLine(paths);
  assert.deepStrictEqual((await readSettingsFile(paths.settingsPath)).statusLine, { type: 'command' });
});

test('the uninstall script puts the user\'s status line back, and leaves a foreign one alone', async () => {
  const home = await createTemporaryDirectory();
  const paths = {
    settingsPath: path.join(home, '.claude', 'settings.json'),
    storageDirectory: path.join(home, 'globalStorage', 'me.complementer'),
    sourceDirectory,
  };
  const original = { statusLine: { type: 'command', command: 'echo hi' }, other: 1 };
  await writeTextFile(paths.settingsPath, JSON.stringify(original));
  await setup.enableStatusLine(paths);
  const ours = await readSettingsFile(paths.settingsPath);
  await main(home, 'other.complementer'); // another install is being removed: this one's hook stays
  assert.deepStrictEqual(await readSettingsFile(paths.settingsPath), ours);
  await main(home, undefined); // falls back to the id in package.json, which is not me.complementer: still not ours
  assert.deepStrictEqual(await readSettingsFile(paths.settingsPath), ours);
  await main(home, 'Me.Complementer');
  assert.deepStrictEqual(await readSettingsFile(paths.settingsPath), original);
  const foreign = { statusLine: { type: 'command', command: 'bash /x/mine.sh' } };
  await writeTextFile(paths.settingsPath, JSON.stringify(foreign));
  await main(home, 'me.complementer');
  assert.deepStrictEqual(await readSettingsFile(paths.settingsPath), foreign);
  await main(path.join(home, 'no-such-home'), 'me.complementer'); // no settings file: must not throw
});

test('refuses to wrap another copy of the hook, so the user\'s real status line is never lost', async () => {
  const foreign = "sh '/x/globalStorage/local.complementer/hook.sh' '/x/globalStorage/local.complementer'";
  const text = JSON.stringify({ statusLine: { type: 'command', command: foreign } });
  const paths = await createSetupPaths(text);
  await assert.rejects(setup.enableStatusLine(paths), /another copy/);
  assert.strictEqual((await readSettingsFile(paths.settingsPath)).statusLine.command, foreign);
});

test('a quote and a space in the storage path do not stop enable, disable, uninstall or the hook', async () => {
  const paths = await createSetupPaths('{"statusLine":{"type":"command","command":"cat"},"keep":1}', undefined, "O'Brien and sons/pub.complementer");
  const home = path.dirname(paths.settingsPath);
  await setup.enableStatusLine(paths);
  const command = (await readSettingsFile(paths.settingsPath)).statusLine.command;
  assert.strictEqual(findStorageDirectory(command), paths.storageDirectory);
  assert.deepStrictEqual(await setup.enableStatusLine(paths), { changed: false }); // still recognised as ours, not "another copy"
  const payload = '{"session_id":"q-1"}';
  const result = await runWithInput('sh', ['-c', command], payload); // run the stored command exactly as Claude Code would
  assert.strictEqual(result.stdout.trim(), payload);
  assert.strictEqual(await fsPromises.readFile(path.join(paths.storageDirectory, 'live', 'q-1.json'), 'utf8'), payload);
  const restored = { statusLine: { type: 'command', command: 'cat' }, keep: 1 };
  assert.deepStrictEqual(await setup.disableStatusLine(paths), { changed: true });
  assert.deepStrictEqual(await readSettingsFile(paths.settingsPath), restored);
  await setup.enableStatusLine(paths);
  await fsPromises.mkdir(path.join(home, '.claude'), { recursive: true });
  await fsPromises.rename(paths.settingsPath, path.join(home, '.claude', 'settings.json')); // the uninstall script reads <home>/.claude/settings.json
  await main(home, 'pub.complementer');
  assert.deepStrictEqual(await readSettingsFile(path.join(home, '.claude', 'settings.json')), restored);
});

test('settings.json keeps its permissions and stays a symlink when it is rewritten', { skip: process.platform === 'win32' }, async () => {
  const paths = await createSetupPaths();
  const realPath = path.join(path.dirname(paths.settingsPath), 'dotfiles', 'settings.json');
  await writeTextFile(realPath, '{"statusLine":{"type":"command","command":"cat"}}');
  await fsPromises.chmod(realPath, 0o600);
  await fsPromises.symlink(realPath, paths.settingsPath);
  await setup.enableStatusLine(paths);
  assert.ok((await fsPromises.lstat(paths.settingsPath)).isSymbolicLink());
  assert.ok(JSON.parse(await fsPromises.readFile(realPath, 'utf8')).statusLine.command.includes('hook.sh'));
  assert.strictEqual((await fsPromises.stat(realPath)).mode & 0o777, 0o600);
  await setup.disableStatusLine(paths);
  assert.ok((await fsPromises.lstat(paths.settingsPath)).isSymbolicLink());
  assert.strictEqual((await readSettingsFile(realPath)).statusLine.command, 'cat');
  assert.strictEqual((await fsPromises.stat(realPath)).mode & 0o777, 0o600);
  assert.deepStrictEqual((await fsPromises.readdir(path.dirname(realPath))).sort(), ['settings.json']); // no temp files left
});

test('windows enabling at the same moment: the user\'s status line is saved once and never replaced by a hook', async () => {
  const paths = await createSetupPaths('{"statusLine":{"type":"command","command":"echo hi"}}');
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => setup.enableStatusLine(paths))); // five windows start together
  assert.strictEqual(results.filter((result) => result.changed).length, 1);
  assert.strictEqual(await fsPromises.readFile(path.join(paths.storageDirectory, 'original-command'), 'utf8'), 'echo hi');
  await setup.disableStatusLine(paths);
  assert.strictEqual((await readSettingsFile(paths.settingsPath)).statusLine.command, 'echo hi');
  assert.deepStrictEqual(await fsPromises.readdir(path.dirname(paths.settingsPath)), ['settings.json', 'store']); // no lock or temp file left
});

test('two different installs enabling at once: one wins, the other refuses, the real status line survives', async () => {
  const first = await createSetupPaths('{"statusLine":{"type":"command","command":"echo hi"}}', undefined, 'globalStorage/pub.complementer');
  const second = { ...first, storageDirectory: path.join(path.dirname(first.settingsPath), 'globalStorage', 'dev.complementer') };
  const outcomes = await Promise.allSettled([setup.enableStatusLine(first), setup.enableStatusLine(second)]);
  assert.strictEqual(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const winner = outcomes[0].status === 'fulfilled' ? first : second;
  const loser = winner === first ? second : first;
  assert.strictEqual(await fsPromises.readFile(path.join(winner.storageDirectory, 'original-command'), 'utf8'), 'echo hi');
  await assert.rejects(setup.enableStatusLine(loser), /another copy/);
  await setup.disableStatusLine(winner);
  assert.strictEqual((await readSettingsFile(first.settingsPath)).statusLine.command, 'echo hi');
});

test('a lock left behind by a crashed window expires instead of blocking forever', async () => {
  const paths = await createSetupPaths('{"a":1}');
  const lockPath = paths.settingsPath + '.complementer.lock';
  await fsPromises.mkdir(lockPath);
  const longAgo = new Date(Date.now() - 60_000);
  await fsPromises.utimes(lockPath, longAgo, longAgo);
  assert.deepStrictEqual(await setup.enableStatusLine(paths), { changed: true });
  await assert.rejects(fsPromises.access(lockPath));
});

test('with no settings folder at all, disable is a quiet no-op and enable reports the problem', async () => {
  const directory = await createTemporaryDirectory();
  const paths = { settingsPath: path.join(directory, 'missing', 'settings.json'), storageDirectory: path.join(directory, 'store'), sourceDirectory };
  assert.deepStrictEqual(await setup.disableStatusLine(paths), { changed: false });
});

test('the hook copy is refreshed when it changed and left alone when it did not', async () => {
  const paths = await createSetupPaths('{"statusLine":{"type":"command","command":"cat"}}');
  await setup.enableStatusLine(paths);
  const hookPath = path.join(paths.storageDirectory, 'hook.sh');
  const inodeBefore = (await fsPromises.stat(hookPath)).ino;
  await setup.enableStatusLine(paths);
  assert.strictEqual((await fsPromises.stat(hookPath)).ino, inodeBefore); // same content: not rewritten
  await fsPromises.writeFile(hookPath, '#!/bin/sh\n# stale\n');
  await setup.enableStatusLine(paths);
  assert.strictEqual(await fsPromises.readFile(hookPath, 'utf8'), await fsPromises.readFile(path.join(sourceDirectory, 'hook.sh'), 'utf8'));
  assert.deepStrictEqual((await fsPromises.readdir(paths.storageDirectory)).filter((name) => name.endsWith('.tmp')), []);
});

test('the other-copy guard fires on installed hooks of either platform, not on a user script that has the repo\'s name in its path', async () => {
  const windowsHook = 'node "C:\\Users\\Me\\AppData\\Roaming\\Code\\User\\globalStorage\\other.complementer\\hook.js" "C:\\Users\\Me\\AppData\\Roaming\\Code\\User\\globalStorage\\other.complementer"';
  await assert.rejects(setup.enableStatusLine(await createSetupPaths(JSON.stringify({ statusLine: { type: 'command', command: windowsHook } }))), /another copy/);
  const ownScript = 'bash /Users/me/Projects/complementer/src/hook.sh';
  const paths = await createSetupPaths(JSON.stringify({ statusLine: { type: 'command', command: ownScript } }));
  assert.deepStrictEqual(await setup.enableStatusLine(paths), { changed: true });
  await setup.disableStatusLine(paths);
  assert.strictEqual((await readSettingsFile(paths.settingsPath)).statusLine.command, ownScript);
  // already enabled by this very install: that wins over the guard, so a restart still refreshes the hook
  assert.strictEqual((await setup.planEnable(await enabledPaths())).isAlreadyEnabled, true);
});

/** Paths whose settings already point at this install's hook. */
async function enabledPaths(): Promise<SetupPaths> {
  const paths = await createSetupPaths('{"statusLine":{"type":"command","command":"cat"}}');
  await setup.enableStatusLine(paths);
  return paths;
}

test('the error for another copy names the file and the command to change', async () => {
  const foreign = "sh '/x/globalStorage/local.complementer/hook.sh' '/x/globalStorage/local.complementer'";
  const paths = await createSetupPaths(JSON.stringify({ statusLine: { type: 'command', command: foreign } }));
  await assert.rejects(setup.planEnable(paths), (error) => error instanceof Error && error.message.includes(paths.settingsPath) && error.message.includes(foreign));
});

test('windows commands: quoting, parsing and the uninstall lookup agree for paths with spaces and non-ASCII letters', () => {
  const storageDirectory = 'C:\\Users\\Zoë Müller\\AppData\\Roaming\\Code\\User\\globalStorage\\me.complementer';
  const command = setup.buildHookCommand({ settingsPath: 'unused', storageDirectory, platform: 'win32' });
  assert.ok(command.startsWith('node "') && command.endsWith(`"${storageDirectory}"`));
  const parsed = setup.parseHookCommand(command);
  assert.strictEqual(parsed?.storageDirectory, storageDirectory);
  assert.ok(parsed?.hookPath.endsWith('hook.js'));
  assert.strictEqual(findStorageDirectory(command), storageDirectory);
  assert.strictEqual(setup.parseHookCommand('node "C:\\tools\\mine.js" "C:\\tools"'), undefined); // someone else's node script
  assert.strictEqual(setup.parseHookCommand("sh '/a/complementer/src/hook.sh'"), undefined); // one argument: not a hook command
  const posixQuoted = setup.buildHookCommand({ settingsPath: 'unused', storageDirectory: "/Users/O'Brien/store.complementer" });
  assert.strictEqual(setup.parseHookCommand(posixQuoted)?.storageDirectory, "/Users/O'Brien/store.complementer");
});

test('the node hook (what Windows runs) survives a failing user command, a missing backup, bad input and a busy target file', async () => {
  const storageDirectory = path.join(await createTemporaryDirectory(), 'store with space');
  const hookPath = path.join(storageDirectory, 'hook.js');
  await fsPromises.mkdir(path.join(storageDirectory, 'live'), { recursive: true });
  await fsPromises.copyFile(path.join(sourceDirectory, 'hook.js'), hookPath);
  const payload = '{"session_id":"w-1"}';
  const liveFile = path.join(storageDirectory, 'live', 'w-1.json');

  const withoutBackup = await runWithInput('node', [hookPath, storageDirectory], payload); // no original-command file
  assert.strictEqual(withoutBackup.exitCode, 0);
  assert.strictEqual(await fsPromises.readFile(liveFile, 'utf8'), payload);

  await writeTextFile(path.join(storageDirectory, 'original-command'), 'exit 3'); // the user's command fails
  const failing = await runWithInput('node', [hookPath, storageDirectory], '{"session_id":"w-2"}');
  assert.strictEqual(failing.exitCode, 0);
  await fsPromises.access(path.join(storageDirectory, 'live', 'w-2.json'));

  await writeTextFile(path.join(storageDirectory, 'original-command'), 'no-such-program-xyz'); // the user's command does not exist
  assert.strictEqual((await runWithInput('node', [hookPath, storageDirectory], '{"session_id":"w-3"}')).exitCode, 0);

  const notJson = await runWithInput('node', [hookPath, storageDirectory], 'not json at all');
  assert.strictEqual(notJson.exitCode, 0);
  assert.strictEqual((await runWithInput('node', [hookPath, storageDirectory], '')).exitCode, 0);

  await fsPromises.rm(liveFile);
  await fsPromises.mkdir(path.join(liveFile, 'blocker'), { recursive: true }); // renaming over it fails, as on Windows when the file is open
  assert.strictEqual((await runWithInput('node', [hookPath, storageDirectory], payload)).exitCode, 0);
  assert.deepStrictEqual((await fsPromises.readdir(path.join(storageDirectory, 'live'))).filter((name) => name.startsWith('.in.')), []); // temp file cleaned up
});

test('isHookEnabled tells whether this install is in statusLine, and is undefined for unreadable settings', async () => {
  const paths = await createSetupPaths(JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } }));
  assert.strictEqual(await setup.isHookEnabled(paths), false);
  await setup.enableStatusLine(paths);
  assert.strictEqual(await setup.isHookEnabled(paths), true);
  await setup.disableStatusLine(paths);
  assert.strictEqual(await setup.isHookEnabled(paths), false);
  await fsPromises.writeFile(paths.settingsPath, 'not json');
  assert.strictEqual(await setup.isHookEnabled(paths), undefined);
});

test('the hook command falls back to the original command when the hook file is gone, and still parses', async () => {
  const original = "echo 'it''s mine'";
  const paths = await createSetupPaths(JSON.stringify({ statusLine: { type: 'command', command: original } }), undefined, "it's.complementer");
  await setup.enableStatusLine(paths);
  const { command } = (await readSettingsFile(paths.settingsPath)).statusLine;
  assert.match(command, /^if \[ -f '/);
  assert.strictEqual(setup.parseHookCommand(command)?.storageDirectory, paths.storageDirectory);
  assert.strictEqual((await setup.planEnable(paths)).isAlreadyEnabled, true);
  const withHook = await runWithInput('sh', ['-c', command], '{"session_id":"abc"}');
  assert.strictEqual(withHook.stdout, 'its mine\n');
  await fsPromises.rm(path.join(paths.storageDirectory, 'hook.sh'));
  const withoutHook = await runWithInput('sh', ['-c', command], '{"session_id":"abc"}');
  assert.deepStrictEqual(withoutHook, { stdout: 'its mine\n', exitCode: 0 }); // the user's status line still prints
  assert.deepStrictEqual(await setup.disableStatusLine(paths), { changed: true });
  assert.strictEqual((await readSettingsFile(paths.settingsPath)).statusLine.command, original);
});
