// Runs the real compiled src/extension against a stubbed `vscode` module and a throwaway home folder.
import test from 'node:test';
import assert from 'node:assert';
import fsPromises from 'node:fs/promises';
import Module from 'node:module';
import path from 'node:path';
import { createTemporaryDirectory, writeTextFile, buildAssistantLine, buildSkillLine } from './helpers';
import { pathExists } from '../src/utils';
import { buildHookCommand } from '../src/setup';
import type { PanelState } from '../src/types';

const KEEPER_ID = '99999999-2222-3333-4444-555555555555';
const DOOMED_ID = '11111111-2222-3333-4444-555555555555';

/** Node's module loader with its internal hook, which has no public type. */
const moduleLoader: any = Module;

/** What the stub records, so tests can assert on what the extension asked VS Code to do. */
interface Recorded {
  /** Each entry is [command, ...arguments]. */
  executedCommands: unknown[][];
  trashed: { path: string; useTrash: boolean }[];
  /** What the next warning dialogs return, in order. */
  warningAnswers: (string | undefined)[];
  infoMessages: string[];
  /** Each terminal the extension opened, with what it typed into it and whether it was closed. */
  terminals: { sent: string[]; isDisposed: boolean }[];
  /** Registered webview view providers by id. */
  providers: Record<string, any>;
  /** The Trash call (0-based) at which the stub starts failing; Infinity for never. */
  failTrashAfter: number;
}

const recorded: Recorded = { executedCommands: [], trashed: [], warningAnswers: [], infoMessages: [], terminals: [], providers: {}, failTrashAfter: Infinity };

const vscodeStub = {
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class {},
  MarkdownString: class {
    appendMarkdown() {}
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` }),
    parse: (text: string) => ({ toString: () => text }),
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({ fsPath: path.join(base.fsPath, ...segments), toString: () => path.join(base.fsPath, ...segments) }),
  },
  window: {
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    registerWebviewViewProvider: (id: string, provider: unknown) => ((recorded.providers[id] = provider), { dispose() {} }),
    showWarningMessage: async () => recorded.warningAnswers.shift(),
    showInformationMessage: async (message: string) => recorded.infoMessages.push(message),
    showErrorMessage: async () => undefined,
    createTerminal: () => {
      const terminal = { sent: [] as string[], isDisposed: false };
      recorded.terminals.push(terminal);
      return { show() {}, sendText: (text: string) => terminal.sent.push(text), dispose: () => (terminal.isDisposed = true) };
    },
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/p/a' } }], // the fixture chats ran in /p/a
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    fs: {
      delete: async (uri: { fsPath: string }, options: { useTrash: boolean }) => {
        await fsPromises.access(uri.fsPath); // like VS Code: deleting something that is not there throws
        if (options.useTrash && recorded.trashed.filter((entry) => entry.useTrash).length >= recorded.failTrashAfter) throw new Error('Trash unavailable');
        recorded.trashed.push({ path: uri.fsPath, useTrash: options.useTrash });
        await fsPromises.rm(uri.fsPath, { recursive: true, force: true });
      },
    },
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: async (command: string, ...args: unknown[]) => recorded.executedCommands.push([command, ...args]),
  },
};

async function waitUntil(condition: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the extension');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Build a fake home with two chats, a live payload that teaches the model's window, and an account.
 * @param hasDuplicateKeeper Also put a copy of the Keeper log in a second project folder.
 */
async function createFakeHome(hasDuplicateKeeper = false): Promise<{ home: string; storage: string; claude: string }> {
  const home = await createTemporaryDirectory();
  const claude = path.join(home, '.claude');
  const project = path.join(claude, 'projects', '-fake-proj');
  const storage = path.join(home, 'store');
  await writeTextFile(path.join(project, `${DOOMED_ID}.jsonl`), buildAssistantLine('m1', { sessionId: DOOMED_ID }) + '\n' + JSON.stringify({ type: 'ai-title', aiTitle: 'Doomed chat' }) + '\n');
  await writeTextFile(path.join(project, DOOMED_ID, 'subagents', 'agent-1.jsonl'), buildAssistantLine('m2', { isSidechain: true, sessionId: DOOMED_ID }) + '\n');
  await writeTextFile(path.join(project, `${KEEPER_ID}.jsonl`), buildAssistantLine('m3', { sessionId: KEEPER_ID }) + '\n' + buildSkillLine('code-review', { sessionId: KEEPER_ID }) + '\n' + JSON.stringify({ type: 'ai-title', aiTitle: 'Keeper' }) + '\n');
  if (hasDuplicateKeeper) await writeTextFile(path.join(claude, 'projects', '-copied-proj', `${KEEPER_ID}.jsonl`), buildAssistantLine('m3', { sessionId: KEEPER_ID }) + '\n');
  await writeTextFile(path.join(claude, 'file-history', DOOMED_ID, 'v1'));
  await writeTextFile(path.join(claude, 'file-history', KEEPER_ID, 'v1'));
  await writeTextFile(path.join(claude, 'session-env', DOOMED_ID, 'env'));
  await writeTextFile(path.join(claude, 'security', `security_warnings_state_${DOOMED_ID}.json`));
  await writeTextFile(path.join(storage, 'live', 'other.json'), JSON.stringify({ session_id: 'other', cwd: '/elsewhere', model: { id: 'claude-sonnet-5-5' }, context_window: { context_window_size: 1000000, used_percentage: 3 } }));
  await writeTextFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com', organizationType: 'claude_team', seatTier: 'team_standard', organizationName: 'Acme' } }));
  return { home, storage, claude };
}

/** The options object the extension fills in. */
function createWebviewOptions(): { localResourceRoots: { fsPath: string }[] } {
  return { localResourceRoots: [] };
}

/** A minimal ExtensionContext: only what the extension reads. */
function createFakeContext(storage: string): any {
  const root = path.join(__dirname, '..');
  return { globalStorageUri: { fsPath: storage }, extensionPath: root, extensionUri: { fsPath: root }, subscriptions: [] };
}

/** Load and start the extension against a fake home; returns a handle to the panel. */
async function startExtension(hasDuplicateKeeper = false, isLiveOn = false) {
  const { home, storage, claude } = await createFakeHome(hasDuplicateKeeper);
  const setupPaths = { settingsPath: path.join(claude, 'settings.json'), storageDirectory: storage, sourceDirectory: path.join(__dirname, '..', 'src') };
  if (isLiveOn) await writeTextFile(setupPaths.settingsPath, JSON.stringify({ statusLine: { type: 'command', command: buildHookCommand(setupPaths) } })); // the Refresh button needs live meters on
  process.env.HOME = home;
  // `vscode` only exists inside VS Code, so the module loader is told to answer it with the stub. Node has no public
  // API for this in CommonJS, hence the internal hook.
  /* eslint-disable no-underscore-dangle */
  const originalLoad = moduleLoader._load;
  moduleLoader._load = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, ...rest);
  };
  /* eslint-enable no-underscore-dangle */
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const extension: typeof import('../src/extension') = require('../src/extension'); // after the stub is installed, so it cannot be an import
  const context = createFakeContext(storage);
  await extension.activate(context);

  const postedStates: PanelState[] = [];
  const messageHandlers: ((message: unknown) => void)[] = [];
  const webview = {
    options: createWebviewOptions(),
    html: '',
    cspSource: 'vscode-webview://test',
    asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => `webview:${uri.fsPath}` }),
    postMessage: (state: unknown) => postedStates.push(JSON.parse(JSON.stringify(state))),
    onDidReceiveMessage: (handler: (message: unknown) => void) => messageHandlers.push(handler),
  };
  recorded.providers['complementer.panel'].resolveWebviewView({ webview, visible: true, onDidChangeVisibility() {}, onDidDispose() {} });
  const send = (message: unknown) => messageHandlers[0](message);
  send({ type: 'ready' });
  await waitUntil(() => postedStates.at(-1)?.chats.length === (hasDuplicateKeeper ? 3 : 2));
  const dispose = () => context.subscriptions.forEach((subscription: { dispose(): void }) => subscription.dispose());
  return { home, storage, claude, webview, postedStates, send, deactivate: extension.deactivate, dispose };
}

function latestState(postedStates: PanelState[]): PanelState {
  const state = postedStates.at(-1);
  if (!state) throw new Error('the panel has not been sent any state yet');
  return state;
}

test('the panel lists chats with context from the learned window, shows the account, and loads its files from src/views/', async (testContext) => {
  const { webview, postedStates, dispose } = await startExtension();
  testContext.after(dispose);
  const state = latestState(postedStates);
  assert.deepStrictEqual(state.account, { email: 'me@example.com', plan: 'Team · Standard', organization: 'Acme' });
  assert.deepStrictEqual(state.chats.map((chat) => chat.title).sort(), ['Doomed chat', 'Keeper']);
  assert.ok(state.chats.every((chat) => chat.context && Math.abs(chat.context.percent - 0.0112) < 1e-9)); // 112 tokens of the learned 1M window
  assert.ok(webview.html.includes('webview:') && webview.html.includes('panel.css') && webview.html.includes('panel.js'));
  assert.match(webview.html, /script-src 'nonce-[0-9a-f]{32}'/);
  assert.deepStrictEqual(webview.options.localResourceRoots.map((root) => path.basename(root.fsPath)), ['views']);
});

test('pinning follows a session; opening a chat and New Chat use the official command', async (testContext) => {
  const { postedStates, send, dispose } = await startExtension();
  testContext.after(dispose);
  recorded.executedCommands.length = 0;
  send({ type: 'open', id: KEEPER_ID });
  await waitUntil(() => postedStates.at(-1)?.usage.session?.isPinned === true);
  assert.strictEqual(latestState(postedStates).usage.session?.title, 'Keeper');
  assert.deepStrictEqual(recorded.executedCommands.at(-1), ['claude-vscode.primaryEditor.open', KEEPER_ID]);
  send({ type: 'select', id: null });
  await waitUntil(() => postedStates.at(-1)?.usage.session?.isPinned === false);
  send({ type: 'newChat' });
  await waitUntil(() => recorded.executedCommands.at(-1)?.length === 1);
  assert.deepStrictEqual(recorded.executedCommands.at(-1), ['claude-vscode.primaryEditor.open']);
});

test('delete moves every per-session file to the Trash, keeps the other session, and keeps the offsets so a restore is not recounted', async (testContext) => {
  const { claude, storage, postedStates, send, deactivate, dispose } = await startExtension();
  testContext.after(dispose);
  recorded.warningAnswers.push('Move to Trash');
  recorded.trashed.length = 0;
  send({ type: 'delete', id: DOOMED_ID });
  await waitUntil(() => postedStates.at(-1)?.chats.length === 1);
  assert.strictEqual(latestState(postedStates).chats[0].title, 'Keeper');
  assert.strictEqual(recorded.trashed.length, 5); // log, subagent folder, file history, session env, security state
  assert.ok(recorded.trashed.every((entry) => entry.useTrash === true));
  const project = path.join(claude, 'projects', '-fake-proj');
  await assert.rejects(fsPromises.access(path.join(project, `${DOOMED_ID}.jsonl`)));
  await fsPromises.access(path.join(project, `${KEEPER_ID}.jsonl`));
  await fsPromises.access(path.join(claude, 'file-history', KEEPER_ID, 'v1'));
  send({ type: 'delete', id: '../../etc/passwd' }); // an unknown id does nothing
  await deactivate();
  const saved = JSON.parse(await fsPromises.readFile(path.join(storage, 'history.json'), 'utf8'));
  const scannedLogs = Object.keys(saved.fileStates).map((filePath) => path.basename(filePath));
  assert.ok(scannedLogs.includes(`${DOOMED_ID}.jsonl`) && scannedLogs.includes(`${KEEPER_ID}.jsonl`)); // a restored log must not be rescanned from 0
});

test('permanent delete asks for its own confirmation and does not use the Trash', async (testContext) => {
  const { claude, postedStates, send, dispose } = await startExtension();
  testContext.after(dispose);
  recorded.trashed.length = 0;
  recorded.warningAnswers.push('Move to Trash'); // the Trash answer must not confirm a permanent delete
  send({ type: 'deletePermanently', id: DOOMED_ID });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.strictEqual(recorded.trashed.length, 0);
  recorded.warningAnswers.push('Delete permanently');
  send({ type: 'deletePermanently', id: DOOMED_ID });
  await waitUntil(() => postedStates.at(-1)?.chats.length === 1);
  assert.ok(recorded.trashed.length > 0 && recorded.trashed.every((entry) => entry.useTrash === false));
  await assert.rejects(fsPromises.access(path.join(claude, 'projects', '-fake-proj', `${DOOMED_ID}.jsonl`)));
});

test('declining the confirmation deletes nothing', async (testContext) => {
  const { claude, postedStates, send, dispose } = await startExtension();
  testContext.after(dispose);
  recorded.warningAnswers.push(undefined); // the user dismisses the dialog
  recorded.trashed.length = 0;
  send({ type: 'delete', id: KEEPER_ID });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.strictEqual(recorded.trashed.length, 0);
  assert.strictEqual(latestState(postedStates).chats.length, 2);
  await fsPromises.access(path.join(claude, 'projects', '-fake-proj', `${KEEPER_ID}.jsonl`));
});

test('when the Trash fails halfway, the permanent fallback removes only what is left and finishes the job', async (testContext) => {
  const { claude, postedStates, send, dispose } = await startExtension();
  testContext.after(dispose);
  recorded.trashed.length = 0;
  recorded.failTrashAfter = 2; // two files reach the Trash, the third fails
  testContext.after(() => (recorded.failTrashAfter = Infinity));
  recorded.warningAnswers.push('Move to Trash', 'Delete permanently');
  send({ type: 'delete', id: DOOMED_ID });
  await waitUntil(() => postedStates.at(-1)?.chats.length === 1);
  assert.strictEqual(recorded.trashed.filter((entry) => !entry.useTrash).length, 3); // the other three of the five, none twice
  await assert.rejects(fsPromises.access(path.join(claude, 'file-history', DOOMED_ID)));
  await assert.rejects(fsPromises.access(path.join(claude, 'projects', '-fake-proj', `${DOOMED_ID}.jsonl`)));
});

test('a session id that exists in two project folders is never deleted from the panel', async (testContext) => {
  const { claude, send, dispose } = await startExtension(true);
  testContext.after(dispose);
  recorded.trashed.length = 0;
  recorded.infoMessages.length = 0;
  recorded.warningAnswers.push('Move to Trash');
  send({ type: 'delete', id: KEEPER_ID });
  await waitUntil(() => recorded.infoMessages.some((message) => /share this session id/.test(message)));
  assert.strictEqual(recorded.trashed.length, 0);
  assert.strictEqual(recorded.warningAnswers.length, 1); // no dialog was even shown
  recorded.warningAnswers.length = 0;
  await fsPromises.access(path.join(claude, 'projects', '-fake-proj', `${KEEPER_ID}.jsonl`));
  await fsPromises.access(path.join(claude, 'projects', '-copied-proj', `${KEEPER_ID}.jsonl`));
});

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

test('a live payload that arrives while the panel is open shows the limits without switching sessions', async (testContext) => {
  const { storage, postedStates, dispose } = await startExtension();
  testContext.after(dispose);
  assert.strictEqual(latestState(postedStates).usage.fiveHour, undefined);
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  await writeTextFile(path.join(storage, 'live', 'fresh.json'), JSON.stringify({ session_id: 'fresh', cwd: '/elsewhere', model: { id: 'claude-sonnet-5-5' }, context_window: { context_window_size: 1000000 }, rate_limits: { five_hour: { used_percentage: 10, resets_at: resetsAt }, seven_day: { used_percentage: 31, resets_at: resetsAt } } }));
  await waitUntil(() => latestState(postedStates).usage.fiveHour !== undefined);
  assert.strictEqual(latestState(postedStates).usage.weekly?.label, '31%');
});

/** A live payload for a session, written `ageMs` ago, optionally with plan limits. */
async function writeSessionPayload(storage: string, sessionId: string, { ageMs = 0, hasLimits = false } = {}) {
  const filePath = path.join(storage, 'live', `${sessionId}.json`);
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const limits = hasLimits ? { rate_limits: { five_hour: { used_percentage: 10, resets_at: resetsAt }, seven_day: { used_percentage: 31, resets_at: resetsAt } } } : {};
  await writeTextFile(filePath, JSON.stringify({ session_id: sessionId, cwd: '/p/a', model: { id: 'claude-sonnet-5-5' }, context_window: { context_window_size: 1000000 }, ...limits }));
  const time = new Date(Date.now() - ageMs);
  await fsPromises.utimes(filePath, time, time);
}

test('Refresh resumes the followed chat and ignores an old payload of that chat: "hi" and /exit wait for new ones', async (testContext) => {
  const { storage, send, dispose } = await startExtension(false, true);
  testContext.after(dispose);
  await writeSessionPayload(storage, KEEPER_ID, { ageMs: 3600_000, hasLimits: true }); // from an earlier terminal run
  send({ type: 'select', id: KEEPER_ID });
  recorded.terminals.length = 0;
  recorded.warningAnswers.push('Resume anyway'); // the fixture chat was written a moment ago
  send({ type: 'refreshLimits' });
  await waitUntil(() => recorded.terminals.length === 1);
  const [terminal] = recorded.terminals;
  assert.deepStrictEqual(terminal.sent, [`claude --resume ${KEEPER_ID}`]);
  await new Promise((resolve) => setTimeout(resolve, 1200)); // two polls: the old payload must not count as "started"
  assert.deepStrictEqual(terminal.sent, [`claude --resume ${KEEPER_ID}`]);
  await writeSessionPayload(storage, KEEPER_ID); // claude started: first status line, no limits yet
  await waitUntil(() => terminal.sent.includes('hi'));
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.ok(!terminal.sent.includes('/exit')); // no limits since "hi"
  await writeSessionPayload(storage, KEEPER_ID, { hasLimits: true });
  await waitUntil(() => terminal.sent.includes('/exit'));
  await waitUntil(() => terminal.isDisposed);
});

test('Refresh asks before resuming a chat written to a moment ago, and does nothing when declined or already running', async (testContext) => {
  const { send, dispose } = await startExtension(false, true);
  testContext.after(dispose);
  send({ type: 'select', id: KEEPER_ID });
  recorded.terminals.length = 0;
  recorded.warningAnswers.push(undefined);
  send({ type: 'refreshLimits' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.strictEqual(recorded.terminals.length, 0);
  recorded.warningAnswers.push('Resume anyway');
  send({ type: 'refreshLimits' });
  send({ type: 'refreshLimits' }); // a second click while the first is running
  await waitUntil(() => recorded.terminals.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.strictEqual(recorded.terminals.length, 1);
});

test('a chat that appears after startup is offered its meters once it has been quiet', async (testContext) => {
  const app = await startExtension(false, true);
  testContext.after(() => app.dispose());
  recorded.infoMessages.length = 0;
  const newId = '33333333-3333-4333-8333-333333333333';
  const logPath = path.join(app.claude, 'projects', '-fake-proj', `${newId}.jsonl`);
  await writeTextFile(logPath, buildAssistantLine('m9', { sessionId: newId }) + '\n');
  const quietSince = new Date(Date.now() - 60 * 1000);
  await fsPromises.utimes(logPath, quietSince, quietSince);
  await waitUntil(() => recorded.infoMessages.some((message) => message.includes('load its context and limits')), 10000);
});

test('session costs are saved as the highest value reported, for real sessions only', async (testContext) => {
  const { storage, dispose } = await startExtension();
  testContext.after(dispose);
  const costsPath = path.join(storage, 'session-costs.json');
  const readCosts = async () => JSON.parse((await fsPromises.readFile(costsPath, 'utf8').catch(() => '{}')) || '{}');
  const reportCost = (sessionId: string, totalCostUsd: number) => writeTextFile(path.join(storage, 'live', `${sessionId}.json`), JSON.stringify({ session_id: sessionId, cwd: '/p/a', cost: { total_cost_usd: totalCostUsd } }));
  await reportCost('not-a-uuid', 9);
  await reportCost(KEEPER_ID, 1.5);
  const deadline = Date.now() + 3000;
  while ((await readCosts())[KEEPER_ID] !== 1.5) {
    if (Date.now() > deadline) throw new Error('the cost was never saved');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await reportCost(KEEPER_ID, 0.5); // a resumed session starts counting again
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepStrictEqual(await readCosts(), { [KEEPER_ID]: 1.5 });
});
