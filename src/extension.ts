import * as vscode from 'vscode';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { History, Scanner, listLogFiles, toDayKey, dropOldDays } from './logs';
import { LiveFeed, isInWorkspace, readAccountIfChanged } from './live';
import { ChatIndex, renderTranscript, getSessionPaths } from './chats';
import { SkillHistory } from './skills';
import { createSessionTally, readSessionTally } from './breakdown';
import { queryUsage } from './usage';
import * as setup from './setup';
import * as viewModel from './view-model';
import type { Account, Chat, Limit, LiveState, Meters, PanelMessage, SessionTally, SetupPaths, WindowSizeReport, WindowState } from './types';
import { CHAT_INDEX_THROTTLE_MS, USAGE_QUERY_MIN_GAP_MS, USAGE_QUERY_INTERVAL_MS, USAGE_QUERY_FILE, LOG_POLL_EVERY_TICKS, REFRESH_LIMITS_WAIT_MS, REFRESH_LIMITS_POLL_MS, REFRESH_LIMITS_CLOSE_MS, REFRESH_RESUME_BUSY_MS, ACTIVATE_NEW_CHAT_IDLE_MS, NEW_CHAT_CHECK_MS, VIEWS_DIRECTORY, CONFIG_SECTION, CHAT_SCHEME, CLAUDE_OPEN_COMMAND, UUID_PATTERN, REFRESH_DEBOUNCE_MS, SCAN_DEBOUNCE_MS, SAVE_DEBOUNCE_MS, POLL_INTERVAL_MS, CLOCK_TICK_MS, ACTIVE_SESSION_MS } from './consts';
import { tryReadText, pathExists, filterExistingPaths, tryParseJson, errorMessage, writeAtomic, writeCosts, createQueue, createTimer } from './utils';

// The compiled folder holds the hook script and the panel's files next to this one, wherever the extension is installed.

/** Started instances; deactivate() flushes them. */
const startedExtensions: ComplementerExtension[] = [];

class ComplementerExtension {
  panelView: vscode.WebviewView | undefined;

  /** The session the user pinned; undefined means follow the latest one in this workspace. */
  selectedSessionId: string | undefined;

  /** Sessions started by Activate: they feed the limits but are never the session the panel follows. */
  readonly activationSessionIds = new Set<string>();

  account: Account | undefined;

  /** Whether our hook is in the user's statusLine; undefined until read, or if settings.json is unreadable. */
  isLiveEnabled: boolean | undefined;

  /** Modification time of ~/.claude.json when the account was last read. */
  accountFileModifiedAtMs: number | undefined;

  lastPostedJson = '';

  /** Transcript document URI -> log path. */
  transcriptPaths = new Map<string, string>();

  /** Logs that changed since the last scan. */
  changedLogFiles = new Set<string>();

  /** What has been read of the shown session's log, for the context breakdown and its skills. */
  sessionTally: SessionTally = createSessionTally();

  /** The log `sessionTally` belongs to. */
  sessionTallyPath: string | undefined;

  readonly #enqueueTallyRead = createQueue();

  readonly refreshTimer = createTimer(() => this.renderStatusBar(), REFRESH_DEBOUNCE_MS);

  readonly scanTimer = createTimer(() => this.scanChangedLogs(), SCAN_DEBOUNCE_MS);

  readonly saveTimer = createTimer(() => this.flushHistory(), SAVE_DEBOUNCE_MS);

  readonly chatIndexTimer = createTimer(() => this.indexChats(), CHAT_INDEX_THROTTLE_MS);

  /** Checks the queue of new chats every couple of seconds until it is empty (the 60 s poll alone would make "10 seconds quiet" a minute). */
  readonly newChatTimer = createTimer(() => {
    this.activateNewChats();
    this.watchNewChats();
  }, NEW_CHAT_CHECK_MS);

  pollTimer: NodeJS.Timeout | undefined;

  clockTimer: NodeJS.Timeout | undefined;

  usageTimer: NodeJS.Timeout | undefined;

  isQueryingUsage = false;

  pollTicks = 0;

  isRefreshingLimits = false;

  hasOfferedHelperFallback = false;

  readonly #enqueueFileWrite = createQueue();

  /** Session id -> the highest cost Claude Code reported for it (session-costs.json); lets a row keep its cost after the live file is gone. */
  sessionCosts: Record<string, number> = {};

  /** Local day -> cost Claude Code reported live that day (day-costs.json), for the Insights Cost tile. */
  dayCosts: Record<string, number> = {};

  /** Chats seen by the last index run (undefined until the first), and new ones still waiting for their first live payload. */
  knownChatIds: Set<string> | undefined;

  chatsAwaitingActivation = new Set<string>();

  lastUsageQueryMs = 0;

  logWatcher: fs.FSWatcher | undefined;

  readonly storageDirectory: string;

  readonly claudeDirectory = path.join(os.homedir(), '.claude');

  readonly projectsRoot = path.join(this.claudeDirectory, 'projects');

  readonly settingsPath = path.join(this.claudeDirectory, 'settings.json');

  readonly setupPaths: SetupPaths;

  readonly scanner: Scanner;

  readonly chatIndex = new ChatIndex(this.projectsRoot);

  readonly liveFeed: LiveFeed;

  readonly statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  /**
   * @param windowSizes Window size per model id, learned from live payloads (which report the real size) and remembered across restarts.
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly history: History,
    private readonly skillHistory: SkillHistory,
    private readonly panelTemplate: string,
    private readonly windowSizes: Record<string, number>,
  ) {
    this.storageDirectory = context.globalStorageUri.fsPath;
    this.setupPaths = { settingsPath: this.settingsPath, storageDirectory: this.storageDirectory, sourceDirectory: __dirname };
    this.scanner = new Scanner(this.projectsRoot, history);
    this.liveFeed = new LiveFeed(path.join(this.storageDirectory, 'live'), () => this.requestRefresh());
    this.statusBarItem.command = `workbench.view.extension.${CONFIG_SECTION}`;
  }

  /** Load everything that must exist before the extension starts. */
  static async create(context: vscode.ExtensionContext): Promise<ComplementerExtension> {
    const storageDirectory = context.globalStorageUri.fsPath;
    await fsPromises.mkdir(storageDirectory, { recursive: true });
    const [history, skillHistory, panelTemplate, windowSizesText, sessionCostsText, dayCostsText] = await Promise.all([
      History.load(path.join(storageDirectory, 'history.json')),
      SkillHistory.load(path.join(storageDirectory, 'skills.json')),
      fsPromises.readFile(path.join(VIEWS_DIRECTORY, 'panel.html'), 'utf8'),
      tryReadText(path.join(storageDirectory, 'windows.json')),
      tryReadText(path.join(storageDirectory, 'session-costs.json')),
      tryReadText(path.join(storageDirectory, 'day-costs.json')),
    ]);
    const extension = new ComplementerExtension(context, history, skillHistory, panelTemplate, tryParseJson(windowSizesText ?? '') ?? {});
    extension.sessionCosts = tryParseJson(sessionCostsText ?? '') ?? {};
    extension.dayCosts = tryParseJson(dayCostsText ?? '') ?? {};
    return extension;
  }

  /** Register everything with VS Code and start the background work. */
  start() {
    this.context.subscriptions.push(
      this,
      this.statusBarItem,
      vscode.workspace.registerTextDocumentContentProvider(CHAT_SCHEME, { provideTextDocumentContent: (uri) => this.provideTranscript(uri) }),
      vscode.window.registerWebviewViewProvider(`${CONFIG_SECTION}.panel`, { resolveWebviewView: (webviewView) => this.resolvePanel(webviewView) }),
      vscode.commands.registerCommand(`${CONFIG_SECTION}.enableLive`, () => this.enableLiveMeters()),
      vscode.commands.registerCommand(`${CONFIG_SECTION}.disableLive`, () => this.disableLiveMeters()),
      vscode.commands.registerCommand(`${CONFIG_SECTION}.newChat`, () => this.startNewChat()),
      vscode.commands.registerCommand(`${CONFIG_SECTION}.refreshLimits`, () => this.refreshLimits()),
      vscode.commands.registerCommand(`${CONFIG_SECTION}.dockPanel`, () => this.dockPanel()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.requestRefresh()),
    );
    this.watchLogs();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.clockTimer = setInterval(() => this.renderStatusBar(), CLOCK_TICK_MS);
    this.usageTimer = setInterval(() => this.refreshUsageLimits(USAGE_QUERY_INTERVAL_MS / 2), USAGE_QUERY_INTERVAL_MS);
    this.renderStatusBar();
    this.refreshAccount();
    this.refreshHookCopy();
    this.refreshLiveEnabled();
    this.liveFeed.start().then(() => {
      this.requestRefresh();
      this.refreshUsageLimits(); // after the load, so an answer another window just saved is reused
    });
    this.scanLogs().then(async (hadNewData) => {
      this.onScanComplete(hadNewData); // the first catch-up runs off the activation path
      await this.history.dropIdleLastResponses(Date.now());
      this.saveTimer.schedule();
    });
    this.chatIndexTimer.schedule(false, 500);
  }

  dispose() {
    this.logWatcher?.close();
    for (const timer of [this.refreshTimer, this.scanTimer, this.saveTimer, this.chatIndexTimer, this.newChatTimer]) timer.cancel();
    clearInterval(this.pollTimer);
    clearInterval(this.clockTimer);
    clearInterval(this.usageTimer);
    this.liveFeed.dispose();
  }

  /** Write the history and the skill counts now; VS Code waits for this on shutdown, so nothing is lost. */
  flushHistory() {
    if (dropOldDays(this.dayCosts, new Date())) this.saveCosts('day-costs.json', this.dayCosts, false);
    return Promise.all([this.history.save(), this.skillHistory.save()]).catch(() => {});
  }

  workspaceFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  }

  /** What the status bar and the panel show: the pinned session, else the latest one in this workspace. */
  computeMeters(): Meters {
    const meters = viewModel.computeMeters({
      liveStates: [...this.liveFeed.states.values()],
      chats: this.chatIndex.chats,
      workspaceFolders: this.workspaceFolders(),
      selectedSessionId: this.selectedSessionId,
      windowSizes: this.windowSizes,
      nowMs: Date.now(),
      ignoredSessionIds: this.activationSessionIds,
    });
    if (meters.selectedSessionIsMissing) this.selectedSessionId = undefined; // its log was deleted
    return meters;
  }

  /** Remember the window size each model reports, so sessions that have not reported live can still show a percentage. */
  learnWindowSizes() {
    const newReports = [...this.liveFeed.states.values()].filter(reportsWindowSize).filter((report) => this.windowSizes[report.modelId] !== report.contextWindowSize);
    if (!newReports.length) return;
    for (const report of newReports) this.windowSizes[report.modelId] = report.contextWindowSize;
    this.#enqueueFileWrite(() => writeAtomic(path.join(this.storageDirectory, 'windows.json'), JSON.stringify(this.windowSizes))).catch(() => {});
  }

  /** Keep the cost each session reports live, so its row can show it later. Only real costs of known sessions are saved. */
  learnSessionCosts() {
    const today = toDayKey(new Date().toISOString()) ?? '';
    if (!viewModel.learnCosts([...this.liveFeed.states.values()], this.sessionCosts, this.dayCosts, today)) return;
    this.saveCosts('session-costs.json', this.sessionCosts);
    this.saveCosts('day-costs.json', this.dayCosts);
  }

  /** One at a time, so two saves never share a temporary file. Pass shouldMerge false after removing entries, or the merge would bring them back. */
  saveCosts(fileName: string, costs: Record<string, number>, shouldMerge = true) {
    this.#enqueueFileWrite(() => writeCosts(path.join(this.storageDirectory, fileName), costs, shouldMerge)).catch(() => {});
  }

  /** Forget the costs of sessions whose log is gone. Never with an empty index (the listing may have failed), nor for sessions still reporting live (their cost would be added to the day again). */
  pruneSessionCosts() {
    if (!this.chatIndex.chats.length) return;
    const keptIds = new Set([...this.chatIndex.chats.map((chat) => chat.id), ...[...this.liveFeed.states.values()].map((state) => state.sessionId)]);
    const staleIds = Object.keys(this.sessionCosts).filter((id) => !keptIds.has(id));
    if (!staleIds.length) return;
    for (const id of staleIds) delete this.sessionCosts[id];
    this.saveCosts('session-costs.json', this.sessionCosts, false);
  }

  /** Without a hook in settings.json no new live data arrives, so old live files must not pass for a working feed. */
  hasLiveFeed(): boolean {
    return this.isLiveEnabled ?? this.liveFeed.states.size > 0;
  }

  async refreshLiveEnabled() {
    const isLiveEnabled = await setup.isHookEnabled(this.setupPaths);
    if (isLiveEnabled === this.isLiveEnabled) return;
    this.isLiveEnabled = isLiveEnabled;
    this.lastPostedJson = '';
    this.requestRefresh();
  }

  /** After an upgrade the installed hook script may be stale; if live meters are on, copy the current one over it. */
  async refreshHookCopy() {
    try {
      if ((await setup.planEnable(this.setupPaths)).isAlreadyEnabled) await setup.enableStatusLine(this.setupPaths);
    } catch {
      // settings.json missing or unreadable: nothing to refresh
    }
  }

  async refreshAccount() {
    const result = await readAccountIfChanged(path.join(os.homedir(), '.claude.json'), this.accountFileModifiedAtMs);
    if (!result) return;
    this.accountFileModifiedAtMs = result.modifiedAtMs;
    if (JSON.stringify(result.account) === JSON.stringify(this.account)) return;
    this.account = result.account;
    this.requestRefresh();
  }

  // ---- rendering ----

  requestRefresh() {
    this.refreshTimer.schedule(true);
  }

  renderStatusBar() {
    this.learnWindowSizes();
    this.learnSessionCosts();
    const meters = this.computeMeters();
    const parts = [
      meters.contextPercent === undefined ? '' : `Ctx ${viewModel.formatPercent(meters.contextPercent)}`,
      meters.fiveHour ? `5h ${describeWindow(meters.fiveHour)}` : '',
      meters.weekly ? `wk ${describeWindow(meters.weekly)}` : '',
    ].filter(Boolean);
    this.statusBarItem.text = parts.length ? parts.join(' | ') : 'Ctx --';
    const worstPercent = Math.max(meters.contextPercent ?? 0, meters.fiveHour && !meters.fiveHour.hasReset ? meters.fiveHour.percent : 0, meters.weekly && !meters.weekly.hasReset ? meters.weekly.percent : 0);
    this.statusBarItem.backgroundColor = statusBarBackground(worstPercent);
    this.statusBarItem.color = meters.areLimitsStale || meters.isContextStale ? new vscode.ThemeColor('disabledForeground') : undefined;
    this.statusBarItem.tooltip = this.buildTooltip(meters);
    this.statusBarItem.show();
    this.postPanel(meters);
  }

  buildTooltip(meters: Meters) {
    const nowMs = Date.now();
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = { enabledCommands: [`${CONFIG_SECTION}.enableLive`] }; // only for the button below
    const todayTokens = viewModel.computeTodayTokens(this.history.days, new Date(nowMs));
    const todayCostUsd = this.dayCosts[toDayKey(new Date(nowMs).toISOString()) ?? ''];
    const lines = [
      '**Complementer**',
      this.account ? `${this.account.email}${this.account.plan ? ` (${this.account.plan})` : ''}` : '',
      meters.contextPercent !== undefined && meters.contextTokens !== undefined && meters.contextWindowSize !== undefined ? `Context: ${meters.contextTokens.toLocaleString()} / ${meters.contextWindowSize.toLocaleString()} tokens` : '',
      meters.fiveHour ? `5-hour limit: ${describeWindow(meters.fiveHour)}${formatResetSuffix(meters.limitsSession?.fiveHourLimit?.resetsAt, nowMs)}` : '',
      meters.weekly ? `Weekly limit: ${describeWindow(meters.weekly)}${formatResetSuffix(meters.limitsSession?.weeklyLimit?.resetsAt, nowMs)}` : '',
      meters.liveSession?.costUsd === undefined ? '' : `Session cost: ${viewModel.formatUsd(meters.liveSession.costUsd)}`,
      todayTokens ? `Today: ${viewModel.formatTokens(todayTokens)} tokens · ${todayCostUsd === undefined ? '--' : viewModel.formatUsd(todayCostUsd)}` : '',
      meters.areLimitsStale ? '_Limits are stale: press ↻ in the Sessions panel to refresh._' : '',
      meters.isContextStale ? '_Context is stale: press ↻ in the Sessions panel to refresh._' : '',
      meters.isContextEstimated ? '_Context is estimated from the chat log._' : '',
      this.hasLiveFeed() ? '' : `Live meters are off. [Turn on live meters](command:${CONFIG_SECTION}.enableLive) for exact values.`,
    ];
    tooltip.appendMarkdown(lines.filter(Boolean).join('\n\n'));
    return tooltip;
  }

  /** Point the tally at the shown session's log (dropping the old one) and read what is new in it. */
  followSessionLog(chat: Chat | undefined) {
    if (chat?.filePath !== this.sessionTallyPath) {
      this.sessionTally = createSessionTally();
      this.sessionTallyPath = chat?.filePath;
    }
    this.updateSessionTally();
  }

  updateSessionTally() {
    const filePath = this.sessionTallyPath;
    if (!filePath) return;
    const { sessionTally } = this;
    this.#enqueueTallyRead(() => readSessionTally(filePath, sessionTally))
      .then((hadNewData) => hadNewData && this.requestRefresh())
      .catch(() => {}); // the log may have vanished; the next refresh tries again
  }

  /** Only a visible panel is updated, and only when its state actually changed (no needless re-render). */
  postPanel(meters: Meters = this.computeMeters()) {
    if (!this.panelView?.visible) return;
    this.followSessionLog(meters.chat);
    const state = viewModel.buildPanelState({
      meters,
      account: this.account,
      liveStates: [...this.liveFeed.states.values()],
      isLiveEnabled: this.isLiveEnabled,
      chats: this.chatIndex.chats,
      workspaceFolders: this.workspaceFolders(),
      skillSessions: this.skillHistory.sessions,
      sessionCosts: this.sessionCosts,
      windowSizes: this.windowSizes,
      insights: viewModel.computeInsights(this.history.days, new Date(), this.skillHistory.days, this.dayCosts),
      breakdown: viewModel.computeBreakdown(this.sessionTally, meters.contextWindowSize),
      sessionSkills: viewModel.topSessionSkills(this.sessionTally.skillCounts),
      selectedSessionId: this.selectedSessionId,
      nowMs: Date.now(),
    });
    const json = JSON.stringify(state);
    if (json === this.lastPostedJson) return;
    this.lastPostedJson = json;
    this.panelView.webview.postMessage(state);
  }

  resolvePanel(webviewView: vscode.WebviewView) {
    const viewsRoot = vscode.Uri.file(VIEWS_DIRECTORY);
    const { webview } = webviewView;
    webview.options = { enableScripts: true, localResourceRoots: [viewsRoot] };
    webview.html = viewModel.renderPanelHtml(this.panelTemplate, {
      nonce: crypto.randomBytes(16).toString('hex'),
      cspSource: webview.cspSource,
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(viewsRoot, 'panel.css')).toString(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(viewsRoot, 'panel.js')).toString(),
    });
    webview.onDidReceiveMessage((message) => this.handlePanelMessage(message));
    webviewView.onDidChangeVisibility(() => webviewView.visible && this.postPanel());
    webviewView.onDidDispose(() => {
      this.panelView = undefined;
    });
    this.panelView = webviewView;
  }

  handlePanelMessage(message: PanelMessage) {
    const matchingChats = message.id ? this.chatIndex.chats.filter((candidate) => candidate.id === message.id) : [];
    const [chat] = matchingChats;
    switch (message.type) {
      case 'ready':
        this.lastPostedJson = ''; // a fresh webview has nothing yet
        this.postPanel();
        break;
      case 'newChat':
        this.startNewChat();
        break;
      case 'select':
        this.selectedSessionId = typeof message.id === 'string' ? message.id : undefined;
        this.renderStatusBar();
        break;
      case 'enable':
        this.enableLiveMeters();
        break;
      case 'refreshLimits':
        this.refreshLimits();
        break;
      case 'open':
        if (chat) this.openInClaude(chat);
        break;
      case 'read':
        if (chat) this.openTranscript(chat);
        break;
      case 'delete':
        if (chat) this.requestDelete(matchingChats, false);
        break;
      case 'deletePermanently':
        if (chat) this.requestDelete(matchingChats, true);
        break;
    }
  }

  // ---- chats ----

  provideTranscript(uri: vscode.Uri) {
    return renderTranscript(this.transcriptPaths.get(uri.toString()) ?? '').catch(() => '_Could not read this chat (the log may have been deleted)._');
  }

  async openTranscript(chat: Chat) {
    const uri = vscode.Uri.parse(`${CHAT_SCHEME}:/${encodeURIComponent(chat.title)}.md?${chat.id}`);
    this.transcriptPaths.set(uri.toString(), chat.filePath);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, 'markdown');
    await vscode.window.showTextDocument(document, { preview: true });
  }

  /** Open a session in the official Claude Code view and make the meters follow it. */
  async openInClaude(chat: Chat) {
    this.selectedSessionId = chat.id;
    this.renderStatusBar();
    try {
      await vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND, chat.id);
    } catch {
      vscode.window.showInformationMessage('Could not open the session: is the Claude Code extension installed and enabled?');
    }
  }

  /** `newConversation` only pings an already-open chat, so open a fresh Claude panel instead. */
  async startNewChat() {
    this.selectedSessionId = undefined; // follow the new session once it starts reporting
    this.renderStatusBar();
    try {
      await vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND);
    } catch {
      vscode.window.showInformationMessage('Could not start a session: is the Claude Code extension installed and enabled?');
    }
  }

  /** @param useTrash Move to the OS Trash (recoverable) instead of deleting permanently. */
  async removeSessionFiles(paths: string[], useTrash: boolean) {
    for (const filePath of paths) await vscode.workspace.fs.delete(vscode.Uri.file(filePath), { recursive: true, useTrash });
  }

  /**
   * The panel names a chat by id only. If one id exists in two project folders (a copied folder), a delete could hit
   * the wrong one, and both share per-session data, so refuse instead of guessing.
   * @param matchingChats Every chat with the id the user clicked.
   */
  async requestDelete(matchingChats: Chat[], isPermanent: boolean) {
    if (matchingChats.length > 1) {
      vscode.window.showInformationMessage(`Not deleting: ${matchingChats.length} chats share this session id (a copied project folder?). Remove the copy by hand.`);
      return;
    }
    await this.deleteSession(matchingChats[0], isPermanent);
  }

  /** Remove everything Claude Code keeps for a session (to the Trash, or for good) and clear our own copies. */
  async deleteSession(chat: Chat, isPermanent: boolean) {
    const existingPaths = await filterExistingPaths(getSessionPaths(this.claudeDirectory, chat));
    if (!existingPaths.length) {
      vscode.window.showInformationMessage('Nothing to delete: this session is already gone.');
      return;
    }
    const isActive = Date.now() - chat.modifiedAtMs < ACTIVE_SESSION_MS;
    const confirmLabel = isPermanent ? 'Delete permanently' : 'Move to Trash';
    const choice = await vscode.window.showWarningMessage(
      isPermanent ? `Permanently delete "${chat.title}"?` : `Move "${chat.title}" to the Trash?`,
      {
        modal: true,
        detail: `${isActive ? 'This session looks active right now. ' : ''}This removes the conversation, its file history and related data from Claude Code, so it disappears from Claude's own session list too. ${isPermanent ? 'This cannot be undone.' : 'You can restore it from the Trash.'}\n\nUsage totals stay: they are anonymous per-day numbers and do not contain the chat.`,
      },
      confirmLabel,
    );
    if (choice !== confirmLabel) return;
    if (!(isPermanent ? await this.removePermanently(existingPaths) : await this.removeToTrashOrAsk(existingPaths))) return;
    this.liveFeed.states.delete(chat.id + '.json');
    if (chat.id in this.sessionCosts) {
      delete this.sessionCosts[chat.id];
      this.saveCosts('session-costs.json', this.sessionCosts, false);
    }
    fsPromises.rm(path.join(this.storageDirectory, 'live', chat.id + '.json'), { force: true }).catch(() => {});
    if (this.selectedSessionId === chat.id) this.selectedSessionId = undefined;
    await this.chatIndex.update();
    this.lastPostedJson = '';
    this.requestRefresh();
    vscode.window.showInformationMessage(isPermanent ? `Deleted "${chat.title}".` : `Moved "${chat.title}" to the Trash.`);
  }

  /**
   * Trash the files; if the Trash is unavailable, ask before deleting permanently.
   * @returns whether the files are gone
   */
  async removeToTrashOrAsk(paths: string[]): Promise<boolean> {
    try {
      await this.removeSessionFiles(paths, true);
      return true;
    } catch {
      const choice = await vscode.window.showWarningMessage('The Trash is not available here. Delete permanently instead?', { modal: true, detail: 'This cannot be undone.' }, 'Delete permanently');
      if (choice !== 'Delete permanently') return false;
    }
    return this.removePermanently(paths);
  }

  /** @returns whether the files are gone */
  async removePermanently(paths: string[]): Promise<boolean> {
    try {
      await this.removeSessionFiles(await filterExistingPaths(paths), false); // some may already be in the Trash
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`Could not delete the session: ${errorMessage(error)}`);
      return false;
    }
  }

  // ---- live meters ----

  async enableLiveMeters() {
    try {
      const plan = await setup.planEnable(this.setupPaths);
      if (!plan.isAlreadyEnabled && !(await this.confirmEnable(plan))) return;
      await setup.enableStatusLine(this.setupPaths);
      await this.refreshLiveEnabled();
      vscode.window.showInformationMessage('Live meters are on. Send a message in a Claude Code terminal session (the chat panel does not report limits) and exact usage will appear here.');
    } catch (error) {
      vscode.window.showErrorMessage(`Could not turn on live meters: ${errorMessage(error)}`);
    }
  }

  /** A short dialog first; the exact change is one click away. */
  async confirmEnable(plan: { commandBefore: string; commandAfter: string }): Promise<boolean> {
    const firstChoice = await vscode.window.showInformationMessage(
      'Turn on live meters?',
      { modal: true, detail: 'Adds a small helper to your Claude Code status line so exact context and plan usage can show here. Claude Code only runs the status line in terminal sessions, not in the chat panel.\n\nYour current status line keeps working as before. You can undo this anytime with "Complementer: Disable live meters".' },
      'Turn on',
      'Show details',
    );
    if (firstChoice !== 'Show details') return firstChoice === 'Turn on';
    const detailsChoice = await vscode.window.showInformationMessage(
      'What will change',
      {
        modal: true,
        detail: `File: ${this.settingsPath}\nSetting: statusLine.command\n\nBefore:\n${plan.commandBefore}\n\nAfter:\n${plan.commandAfter}\n\nThe helper saves the status data Claude Code sends, then runs your original command unchanged. Disabling restores the original setting exactly.`,
      },
      'Turn on',
    );
    return detailsChoice === 'Turn on';
  }

  async disableLiveMeters() {
    try {
      const { changed } = await setup.disableStatusLine(this.setupPaths);
      await this.refreshLiveEnabled();
      vscode.window.showInformationMessage(changed ? 'Live meters are off. Your original status line is restored.' : 'Live meters were not enabled.');
    } catch (error) {
      vscode.window.showErrorMessage(`Could not disable live meters: ${errorMessage(error)}`);
    }
  }

  /**
   * The Refresh button. The chat panel never runs the status line, so resume the followed session in a terminal
   * (its folder, same session id): the terminal reports the context and the limits too. Once the screen is up it sends
   * one short message, waits for the limits, then exits and closes the terminal. With no session to follow it starts a
   * fresh one instead (an Activate helper that never becomes the followed session). It never answers a trust prompt:
   * if nothing arrives in time the terminal stays open for the user. One run at a time: a second click does nothing.
   */
  async refreshLimits(targetChat?: Chat, useHelperSession = false) {
    if (this.isRefreshingLimits) return;
    this.isRefreshingLimits = true;
    try {
      await this.refreshLimitsInTerminal(targetChat, useHelperSession);
    } finally {
      this.isRefreshingLimits = false;
    }
  }

  async refreshLimitsInTerminal(targetChat?: Chat, useHelperSession = false) {
    if (!this.hasLiveFeed()) await this.enableLiveMeters();
    if (!this.hasLiveFeed()) return;
    const chat = useHelperSession ? undefined : (targetChat ?? this.computeMeters().chat);
    const resumedChat = chat && UUID_PATTERN.test(chat.id) ? chat : undefined;
    if (resumedChat && Date.now() - resumedChat.modifiedAtMs < REFRESH_RESUME_BUSY_MS && !(await this.confirmResume(resumedChat))) return;
    const terminal = vscode.window.createTerminal({ name: 'Claude (refresh limits)', cwd: resumedChat?.workingDirectory ?? this.workspaceFolders()[0] ?? os.homedir() });
    terminal.show();
    const sessionId = resumedChat?.id ?? crypto.randomUUID();
    if (!resumedChat) this.activationSessionIds.add(sessionId);
    const startedAtMs = Date.now();
    terminal.sendText(resumedChat ? `claude --resume ${sessionId}` : `claude --session-id ${sessionId}`);
    // A resumed session may already have an older payload (they are kept for days): only one written after `sinceMs` counts.
    const hasPayloadSince = (sinceMs: number, needsLimit: boolean) => {
      const state = this.liveFeed.states.get(`${sessionId}.json`);
      return Boolean(state && state.updatedAt >= sinceMs && (!needsLimit || state.fiveHourLimit));
    };
    const waitFor = async (isDone: () => boolean) => {
      for (let waitedMs = 0; waitedMs < REFRESH_LIMITS_WAIT_MS && !isDone(); waitedMs += REFRESH_LIMITS_POLL_MS) await new Promise((resolve) => setTimeout(resolve, REFRESH_LIMITS_POLL_MS));
      return isDone();
    };
    const hasStarted = await waitFor(() => hasPayloadSince(startedAtMs, false));
    if (hasStarted) terminal.sendText('hi');
    const askedAtMs = Date.now();
    if (!hasStarted || !(await waitFor(() => hasPayloadSince(askedAtMs, true)))) {
      vscode.window.showInformationMessage('No limits yet. Answer any prompt in the terminal and send "hi" once; then type /exit.');
      return;
    }
    terminal.sendText('/exit');
    await new Promise((resolve) => setTimeout(resolve, REFRESH_LIMITS_CLOSE_MS));
    terminal.dispose();
    vscode.window.showInformationMessage('Live limits are active.');
  }

  /** Refresh adds a message to the chat it resumes. If the chat changed a moment ago the official panel may have it open, and two Claude processes on one chat can mix up its history. */
  async confirmResume(chat: Chat): Promise<boolean> {
    const answer = await vscode.window.showWarningMessage('Resume this chat in a terminal?', { modal: true, detail: `"${chat.title}" changed in the last minute, so it may be open in the Claude chat panel. Refresh sends "hi" to it from a second Claude process.` }, 'Resume anyway');
    return answer === 'Resume anyway';
  }

  /** The `claude` that ships inside the official extension (the one the chat panel runs); undefined when that extension is not installed. */
  async findClaudeBinary(): Promise<string | undefined> {
    const extensionPath = vscode.extensions?.getExtension('anthropic.claude-code')?.extensionPath;
    if (!extensionPath) return undefined;
    const binaryPath = path.join(extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
    return (await pathExists(binaryPath)) ? binaryPath : undefined;
  }

  /**
   * Ask Claude Code for the plan limits (see usage.ts) so the chat panel needs no terminal. A success is stored like a
   * live payload with no folder, so it feeds the limits only, and saved in live/ so other windows reuse it instead of
   * starting their own `claude`. On failure nothing changes: the data ages into "stale" and the ↻ button in the panel
   * still refreshes through a terminal.
   * @param maxAgeMs Skip when an answer (from any window) is younger than this.
   */
  async refreshUsageLimits(maxAgeMs = USAGE_QUERY_MIN_GAP_MS) {
    if (this.isQueryingUsage) return;
    const shared = this.liveFeed.states.get(USAGE_QUERY_FILE);
    if (shared && Date.now() - shared.updatedAt < maxAgeMs) return;
    this.isQueryingUsage = true;
    this.lastUsageQueryMs = Date.now();
    try {
      const binaryPath = await this.findClaudeBinary();
      const limits = binaryPath ? await queryUsage(binaryPath, this.storageDirectory) : undefined;
      if (!limits) {
        this.offerHelperSession();
        return;
      }
      this.liveFeed.states.set(USAGE_QUERY_FILE, { sessionId: 'usage-query', workingDirectory: '', ...limits, updatedAt: Date.now() });
      const sharedPayload = JSON.stringify({ session_id: 'usage-query', rate_limits: { five_hour: toPayloadLimit(limits.fiveHourLimit), seven_day: toPayloadLimit(limits.weeklyLimit) } });
      this.#enqueueFileWrite(() => writeAtomic(path.join(this.storageDirectory, 'live', USAGE_QUERY_FILE), sharedPayload)).catch(() => {});
      this.requestRefresh();
    } finally {
      this.isQueryingUsage = false;
    }
  }

  /** When the usage query fails and no limits are known at all, offer once per window to load them through a fresh helper session (never a resumed chat), unless the setting is off. */
  async offerHelperSession() {
    const hasLimits = [...this.liveFeed.states.values()].some((state) => state.fiveHourLimit || state.weeklyLimit);
    const mode = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('autoActivateNewChats', 'ask');
    if (hasLimits || mode === 'off' || this.hasOfferedHelperFallback || this.isRefreshingLimits || !this.hasLiveFeed()) return;
    this.hasOfferedHelperFallback = true;
    const answer = await vscode.window.showInformationMessage('Plan limits could not be read automatically. Load them with a short Claude session in a terminal? It sends "hi" once and uses a few tokens; your chats are not touched.', 'Load limits');
    if (answer === 'Load limits') this.refreshLimits(undefined, true);
  }

  /** Move the panel next to the Claude chat. `vscode.moveViews` is undocumented, so fall back to manual instructions. */
  async dockPanel() {
    try {
      await vscode.commands.executeCommand('vscode.moveViews', { viewIds: [`${CONFIG_SECTION}.panel`], destinationId: 'workbench.view.extension.claude-sidebar-secondary' });
      vscode.window.showInformationMessage('Panel moved next to the Claude chat.');
    } catch {
      vscode.window.showInformationMessage('Drag the panel header onto the Claude chat (Secondary Side Bar) to dock it there.');
    }
  }

  // ---- watching the logs ----

  watchLogs() {
    try {
      this.logWatcher = fs.watch(this.projectsRoot, { recursive: true }, (_eventType, relativePath) => {
        if (!relativePath?.endsWith('.jsonl')) return;
        this.changedLogFiles.add(path.join(this.projectsRoot, relativePath));
        this.scanTimer.schedule();
      });
      this.logWatcher.on('error', () => {});
    } catch {
      // Directory missing or watching unsupported: the poll still picks logs up.
    }
  }

  /**
   * Count token usage and skill calls in the given logs, or in every log when none are given.
   * @returns true if either found new data
   */
  async scanLogs(filePaths?: string[]): Promise<boolean> {
    const logFiles = filePaths ?? (await listLogFiles(this.projectsRoot));
    const [hadNewUsage, hadNewSkills] = await Promise.all([this.scanner.scan(logFiles), this.skillHistory.scan(logFiles)]);
    return hadNewUsage || hadNewSkills;
  }

  scanChangedLogs() {
    const changedFiles = [...this.changedLogFiles];
    this.changedLogFiles.clear();
    this.scanLogs(changedFiles).then((hadNewData) => this.onScanComplete(hadNewData));
  }

  onScanComplete(hadNewData: boolean) {
    if (!hadNewData) return;
    if (Date.now() - this.lastUsageQueryMs >= USAGE_QUERY_MIN_GAP_MS) this.refreshUsageLimits(); // new messages moved the limits
    this.requestRefresh();
    this.chatIndexTimer.schedule();
    this.saveTimer.schedule(true);
  }

  /** Coalesce: if a run is already pending, keep it. */
  indexChats() {
    this.chatIndex.update().then(() => {
      this.pruneSessionCosts();
      this.noteNewChats();
      this.requestRefresh();
    });
  }

  /** A chat that appears after startup is a new session: queue it to be activated once, so its meters load without the user clicking Refresh. */
  noteNewChats() {
    const { chats } = this.chatIndex;
    const known = this.knownChatIds;
    this.knownChatIds = new Set(chats.map((chat) => chat.id));
    if (!known) return;
    for (const chat of chats) {
      if (!known.has(chat.id) && UUID_PATTERN.test(chat.id) && !this.activationSessionIds.has(chat.id) && isInWorkspace(chat.workingDirectory, this.workspaceFolders())) this.chatsAwaitingActivation.add(chat.id);
    }
    this.watchNewChats();
  }

  watchNewChats() {
    if (this.chatsAwaitingActivation.size) this.newChatTimer.schedule();
  }

  /** Once a queued chat has been quiet for 10 seconds (its first reply is done) and has no live payload, load its meters once: ask first, unless the setting says auto. */
  activateNewChats() {
    if (this.isRefreshingLimits) return;
    for (const id of this.chatsAwaitingActivation) {
      const chat = this.chatIndex.chats.find((candidate) => candidate.id === id);
      if (!chat || this.liveFeed.states.has(`${id}.json`)) this.chatsAwaitingActivation.delete(id);
      else if (Date.now() - chat.modifiedAtMs >= ACTIVATE_NEW_CHAT_IDLE_MS) {
        this.chatsAwaitingActivation.delete(id);
        this.activateNewChat(chat);
        return;
      }
    }
  }

  async activateNewChat(chat: Chat) {
    const mode = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('autoActivateNewChats', 'ask');
    if (mode === 'off') return;
    const answer = await vscode.window.showInformationMessage(`New chat "${chat.title}": load its context and limits? This resumes it once in a terminal and sends "hi".`, 'Load');
    if (answer === 'Load') this.refreshLimits(chat);
  }

  /** A fallback for when watching misses something: stat-only for unchanged files. */
  poll() {
    if (!this.logWatcher || ++this.pollTicks % LOG_POLL_EVERY_TICKS === 0) this.scanLogs().then((hadNewData) => this.onScanComplete(hadNewData));
    this.refreshAccount();
    this.refreshLiveEnabled();
    this.activateNewChats();
    if (!this.liveFeed.watcher) this.liveFeed.reloadAll().then(() => this.requestRefresh());
  }
}

/** A limit in the shape of a statusLine payload, which LiveFeed already reads. */
const toPayloadLimit = (limit: Limit | undefined) => limit && { used_percentage: limit.percent, resets_at: limit.resetsAt };

function reportsWindowSize(state: LiveState): state is WindowSizeReport {
  return Boolean(state.modelId && state.contextWindowSize);
}

/** " (resets in 13m)", or '' when unknown or already past. */
function formatResetSuffix(resetsAtEpochSeconds: number | undefined, nowMs: number) {
  const resetIn = viewModel.formatResetIn(resetsAtEpochSeconds, nowMs);
  return resetIn ? ` (resets in ${resetIn})` : '';
}

function describeWindow(windowState: WindowState) {
  return windowState.hasReset ? 'reset' : viewModel.formatPercent(windowState.percent);
}

/** Warning above 50%, error from 80%. */
function statusBarBackground(percent: number) {
  if (percent >= 80) return new vscode.ThemeColor('statusBarItem.errorBackground');
  return percent > 50 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
}

export async function activate(context: vscode.ExtensionContext) {
  const extension = await ComplementerExtension.create(context);
  startedExtensions.push(extension);
  extension.start();
}

/** VS Code waits for this, so totals are written before the host exits. */
export function deactivate() {
  return Promise.all(startedExtensions.map((extension) => extension.flushHistory()));
}
