import * as vscode from 'vscode';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { History, Scanner } from './logs';
import { LiveFeed, readAccountIfChanged } from './live';
import { ChatIndex, renderTranscript, getSessionPaths } from './chats';
import * as setup from './setup';
import * as viewModel from './view-model';
import type { Account, Chat, LiveState, Meters, PanelMessage, SetupPaths, WindowSizeReport, WindowState } from './types';
import { VIEWS_DIRECTORY, CONFIG_SECTION, CHAT_SCHEME, CLAUDE_OPEN_COMMAND, REFRESH_DEBOUNCE_MS, SCAN_DEBOUNCE_MS, SAVE_DEBOUNCE_MS, POLL_INTERVAL_MS, CLOCK_TICK_MS, ACTIVE_SESSION_MS } from './consts';
import { tryReadText, filterExistingPaths, tryParseJson, errorMessage } from './utils';

// The compiled folder holds the hook script and the panel's files next to this one, wherever the extension is installed.

/** Started instances; deactivate() flushes them. */
const startedExtensions: ComplementerExtension[] = [];

class ComplementerExtension {
  panelView: vscode.WebviewView | undefined;

  /** The session the user pinned; undefined means follow the latest one in this workspace. */
  selectedSessionId: string | undefined;

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

  refreshTimer: NodeJS.Timeout | undefined;

  scanTimer: NodeJS.Timeout | undefined;

  saveTimer: NodeJS.Timeout | undefined;

  chatIndexTimer: NodeJS.Timeout | undefined;

  pollTimer: NodeJS.Timeout | undefined;

  clockTimer: NodeJS.Timeout | undefined;

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
    const [history, panelTemplate, windowSizesText] = await Promise.all([
      History.load(path.join(storageDirectory, 'history.json')),
      fsPromises.readFile(path.join(VIEWS_DIRECTORY, 'panel.html'), 'utf8'),
      tryReadText(path.join(storageDirectory, 'windows.json')),
    ]);
    return new ComplementerExtension(context, history, panelTemplate, tryParseJson(windowSizesText ?? '') ?? {});
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
      vscode.commands.registerCommand(`${CONFIG_SECTION}.newSession`, () => this.startNewSession()),
      vscode.commands.registerCommand(`${CONFIG_SECTION}.dockPanel`, () => this.dockPanel()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.requestRefresh()),
    );
    this.watchLogs();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.clockTimer = setInterval(() => this.renderStatusBar(), CLOCK_TICK_MS);
    this.renderStatusBar();
    this.refreshAccount();
    this.refreshHookCopy();
    this.refreshLiveEnabled();
    this.liveFeed.start().then(() => this.requestRefresh());
    this.scanner.scan().then((hadNewData) => this.onScanComplete(hadNewData)); // the first catch-up runs off the activation path
    this.scheduleChatIndexing(500);
  }

  dispose() {
    this.logWatcher?.close();
    for (const timer of [this.refreshTimer, this.scanTimer, this.saveTimer, this.chatIndexTimer]) clearTimeout(timer);
    clearInterval(this.pollTimer);
    clearInterval(this.clockTimer);
    this.liveFeed.dispose();
  }

  /** Write the history now; VS Code waits for this on shutdown, so totals are not lost. */
  flushHistory() {
    return this.history.save().catch(() => {});
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
    });
    if (meters.selectedSessionIsMissing) this.selectedSessionId = undefined; // its log was deleted
    return meters;
  }

  /** Remember the window size each model reports, so sessions that have not reported live can still show a percentage. */
  learnWindowSizes() {
    const newReports = [...this.liveFeed.states.values()].filter(reportsWindowSize).filter((report) => this.windowSizes[report.modelId] !== report.contextWindowSize);
    if (!newReports.length) return;
    for (const report of newReports) this.windowSizes[report.modelId] = report.contextWindowSize;
    fsPromises.writeFile(path.join(this.storageDirectory, 'windows.json'), JSON.stringify(this.windowSizes)).catch(() => {});
  }

  /** After an upgrade the installed hook script may be stale; if live meters are on, copy the current one over it. */
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
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.renderStatusBar(), REFRESH_DEBOUNCE_MS);
  }

  renderStatusBar() {
    this.learnWindowSizes();
    const meters = this.computeMeters();
    const parts = [
      meters.contextPercent === undefined ? '' : `Ctx ${viewModel.formatPercent(meters.contextPercent)}`,
      meters.fiveHour ? `5h ${describeWindow(meters.fiveHour)}` : '',
      meters.weekly ? `wk ${describeWindow(meters.weekly)}` : '',
    ].filter(Boolean);
    this.statusBarItem.text = parts.length ? parts.join(' | ') : 'Ctx --';
    const worstPercent = Math.max(meters.contextPercent ?? 0, meters.fiveHour && !meters.fiveHour.hasReset ? meters.fiveHour.percent : 0, meters.weekly && !meters.weekly.hasReset ? meters.weekly.percent : 0);
    this.statusBarItem.backgroundColor = statusBarBackground(worstPercent);
    this.statusBarItem.color = meters.isStale ? new vscode.ThemeColor('disabledForeground') : undefined;
    this.statusBarItem.tooltip = this.buildTooltip(meters);
    this.statusBarItem.show();
    this.postPanel(meters);
  }

  buildTooltip(meters: Meters) {
    const nowMs = Date.now();
    const tooltip = new vscode.MarkdownString(undefined, true);
    const todayTokens = viewModel.computeTodayTokens(this.history.days, new Date(nowMs));
    const lines = [
      '**Complementer**',
      this.account ? `${this.account.email}${this.account.plan ? ` (${this.account.plan})` : ''}` : '',
      meters.contextPercent !== undefined && meters.contextTokens !== undefined && meters.contextWindowSize !== undefined ? `Context: ${meters.contextTokens.toLocaleString()} / ${meters.contextWindowSize.toLocaleString()} tokens` : '',
      meters.fiveHour ? `5-hour limit: ${describeWindow(meters.fiveHour)}${formatResetSuffix(meters.limitsSession?.fiveHourLimit?.resetsAt, nowMs)}` : '',
      meters.weekly ? `Weekly limit: ${describeWindow(meters.weekly)}${formatResetSuffix(meters.limitsSession?.weeklyLimit?.resetsAt, nowMs)}` : '',
      meters.liveSession?.costUsd === undefined ? '' : `Session cost: ${viewModel.formatUsd(meters.liveSession.costUsd)}`,
      todayTokens ? `Today: ${viewModel.formatTokens(todayTokens)} tokens` : '',
      meters.isStale ? '_Live data is stale: send a message in Claude Code to refresh._' : '',
      this.hasLiveFeed() ? '' : '_Live meters are off. Run "Complementer: Enable live meters" for exact values._',
    ];
    tooltip.appendMarkdown(lines.filter(Boolean).join('\n\n'));
    return tooltip;
  }

  /** Only a visible panel is updated, and only when its state actually changed (no needless re-render). */
  postPanel(meters: Meters = this.computeMeters()) {
    if (!this.panelView?.visible) return;
    const state = viewModel.buildPanelState({
      meters,
      account: this.account,
      liveStates: [...this.liveFeed.states.values()],
      isLiveEnabled: this.isLiveEnabled,
      chats: this.chatIndex.chats,
      workspaceFolders: this.workspaceFolders(),
      windowSizes: this.windowSizes,
      insights: viewModel.computeInsights(this.history.days, new Date()),
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
      case 'new':
        this.startNewSession();
        break;
      case 'select':
        this.selectedSessionId = typeof message.id === 'string' ? message.id : undefined;
        this.renderStatusBar();
        break;
      case 'enable':
        this.enableLiveMeters();
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
  async startNewSession() {
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
      vscode.window.showInformationMessage('Live meters are on. Send a message in Claude Code and exact usage will appear here.');
    } catch (error) {
      vscode.window.showErrorMessage(`Could not turn on live meters: ${errorMessage(error)}`);
    }
  }

  /** A short dialog first; the exact change is one click away. */
  async confirmEnable(plan: { commandBefore: string; commandAfter: string }): Promise<boolean> {
    const firstChoice = await vscode.window.showInformationMessage(
      'Turn on live meters?',
      { modal: true, detail: 'Adds a small helper to your Claude Code status line so exact context and plan usage can show here.\n\nYour current status line keeps working as before. You can undo this anytime with "Complementer: Disable live meters".' },
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
        this.scanTimer ||= setTimeout(() => this.scanChangedLogs(), SCAN_DEBOUNCE_MS);
      });
      this.logWatcher.on('error', () => {});
    } catch {
      // Directory missing or watching unsupported: the poll still picks logs up.
    }
  }

  scanChangedLogs() {
    this.scanTimer = undefined;
    const changedFiles = [...this.changedLogFiles];
    this.changedLogFiles.clear();
    this.scanner.scan(changedFiles).then((hadNewData) => this.onScanComplete(hadNewData));
  }

  onScanComplete(hadNewData: boolean) {
    if (!hadNewData) return;
    this.requestRefresh();
    this.scheduleChatIndexing();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushHistory(), SAVE_DEBOUNCE_MS);
  }

  /**
   * Coalesce: if a run is already pending, keep it. The default delay grows when the active log is huge.
   */
  scheduleChatIndexing(delayMs: number = viewModel.chatIndexDelayMs(this.chatIndex.largestRecentLogBytes(Date.now(), ACTIVE_SESSION_MS))) {
    if (this.chatIndexTimer) return;
    this.chatIndexTimer = setTimeout(() => {
      this.chatIndexTimer = undefined;
      this.chatIndex.update().then(() => this.requestRefresh());
    }, delayMs);
  }

  /** A fallback for when watching misses something: stat-only for unchanged files. */
  poll() {
    this.scanner.scan().then((hadNewData) => this.onScanComplete(hadNewData));
    this.refreshAccount();
    this.refreshLiveEnabled();
    if (!this.liveFeed.watcher) this.liveFeed.reloadAll().then(() => this.requestRefresh());
  }
}

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
