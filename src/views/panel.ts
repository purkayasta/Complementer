// Sessions panel (runs inside the webview). Data arrives as one PanelState message and is drawn with textContent
// and DOM calls only: chat titles come from log files and must never be treated as HTML.
// A classic <script>, not a module: shared types are reached through import() types, never top-level imports.

type PanelState = import('../types').PanelState;
type PanelChat = import('../types').PanelChat;
type MeterView = import('../types').MeterView;
type Insights = import('../types').Insights;
type RangeInsight = import('../types').RangeInsight;
type DayInsight = import('../types').DayInsight;
type Breakdown = import('../types').Breakdown;
type ContentKind = import('../types').ContentKind;
type NamedAmount = import('../types').NamedAmount;

/** What the user picked in this panel. The first three survive the panel being hidden. */
interface ViewState {
  /** Project folder path, or '' for all. */
  projectFilter: string;
  showOnlyActive: boolean;
  /** Days: 7, 30 or 90. */
  insightRange: number;
  /** Whether the context Details under the Context meter are open. */
  areDetailsOpen: boolean;
  /** Project group name -> expanded, for groups the user opened or closed. */
  groupToggles: Record<string, boolean>;
  searchText: string;
  /** The heatmap day whose detail is shown (YYYY-MM-DD). */
  selectedDay: string;
  /** The latest data from the extension. */
  panelState: PanelState | undefined;
}

interface ElementAttributes {
  className?: string;
  style?: Record<string, string>;
  onClick?: (event: MouseEvent) => void;
  [attribute: string]: unknown;
}

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const REFRESH_INTERVAL_MS = 30 * 1000;
const WARNING_ABOVE_PERCENT = 50;
const DANGER_FROM_PERCENT = 80;
const INSIGHT_RANGES = [7, 30, 90];
const MODEL_COLORS = ['#00b8ff', '#2979ff', '#6e5aff', '#00e5c7', '#b388ff', '#ffb74d'];
const HEATMAP_OPACITIES = [0, 0.28, 0.5, 0.75, 1];
const HEATMAP_LEVELS = 4;
const UNGROUPED_LABEL = 'Ungrouped';
const BASELINE_COLOR = '#6b7280';
const KIND_COLORS: Record<ContentKind, string> = { toolResults: '#f59e0b', toolCalls: '#fb7185', assistantText: '#2979ff', assistantThinking: '#06b6d4', userText: '#a78bfa', attachments: '#34d399' };
const KIND_LABELS: Record<ContentKind, string> = { toolResults: 'Tool results', toolCalls: 'Tool calls', assistantText: 'Assistant text', assistantThinking: 'Thinking', userText: 'Your messages', attachments: 'Attachments' };
const LEGEND_PARTS = 3;

const vscode = acquireVsCodeApi();

/** @param savedState Whatever vscode.getState() returned. */
function createViewState(savedState: Partial<ViewState> | undefined): ViewState {
  return {
    projectFilter: savedState?.projectFilter ?? '',
    showOnlyActive: Boolean(savedState?.showOnlyActive),
    insightRange: savedState?.insightRange ?? 30,
    areDetailsOpen: Boolean(savedState?.areDetailsOpen),
    groupToggles: savedState?.groupToggles ?? {},
    searchText: '',
    selectedDay: '',
    panelState: undefined,
  };
}

const viewState = createViewState(vscode.getState() as Partial<ViewState> | undefined);

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing from panel.html`);
  return element;
}

function getSelect(id: string) {
  const element = getElement(id);
  if (!(element instanceof HTMLSelectElement)) throw new Error(`#${id} is not a <select>`);
  return element;
}

function getInput(id: string) {
  const element = getElement(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} is not an <input>`);
  return element;
}

/** Type guard for filtering out the null/undefined entries of a list of optional elements. */
function isElement(value: unknown): value is HTMLElement {
  return value instanceof HTMLElement;
}

const elements = {
  account: getElement('account'),
  accountRows: getElement('account-rows'),
  usage: getElement('usage'),
  sessionLine: getElement('session-line'),
  meters: getElement('meters'),
  usageNote: getElement('usage-note'),
  newSession: getElement('new-session'),
  projectFilter: getSelect('project-filter'),
  activeFilter: getElement('active-filter'),
  search: getInput('search'),
  chatList: getElement('chat-list'),
  chatEmpty: getElement('chat-empty'),
  rangeSwitch: getElement('range-switch'),
  insightsBody: getElement('insights-body'),
};

/** Small DOM builder: attributes, style properties and a click handler, then children (text or nodes; null is skipped). */
function buildElement(tagName: string, attributes: ElementAttributes = {}, ...children: (Node | string | null)[]): HTMLElement {
  const { className, style, onClick, ...otherAttributes } = attributes;
  const element = document.createElement(tagName);
  if (className) element.className = className;
  for (const [property, value] of Object.entries(style ?? {})) element.style.setProperty(property, value);
  if (onClick) element.addEventListener('click', onClick);
  for (const [name, value] of Object.entries(otherAttributes)) element.setAttribute(name, String(value));
  element.append(...children.filter((child) => child !== null));
  return element;
}

function saveViewState() {
  vscode.setState({ projectFilter: viewState.projectFilter, showOnlyActive: viewState.showOnlyActive, insightRange: viewState.insightRange, areDetailsOpen: viewState.areDetailsOpen, groupToggles: viewState.groupToggles });
}

function formatTokens(tokens: number) {
  if (tokens >= 1e9) return (tokens / 1e9).toFixed(1) + 'B';
  if (tokens >= 1e6) return (tokens / 1e6).toFixed(1) + 'M';
  if (tokens >= 1e3) return (tokens / 1e3).toFixed(1) + 'k';
  return String(tokens);
}

/** @param dateKey YYYY-MM-DD */
function formatDate(dateKey: string) {
  return new Date(dateKey + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatAge(timestampMs: number) {
  const seconds = Math.max(0, (Date.now() - timestampMs) / 1000);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
  return Math.floor(seconds / 86400) + 'd';
}

/** Yellow above 50%, red from 80%, for every meter. Returns a CSS colour, or '' when no warning applies. */
function warningColor(percent: number): string {
  if (percent >= DANGER_FROM_PERCENT) return 'var(--vscode-charts-red)';
  return percent > WARNING_ABOVE_PERCENT ? 'var(--vscode-charts-yellow)' : '';
}

function isActive(modifiedAtMs: number) {
  return Date.now() - modifiedAtMs < ACTIVE_WINDOW_MS;
}

// ---- account and usage ----

/** The [label, value] pairs worth showing. */
function accountRowsOf(account: NonNullable<PanelState['account']>): string[][] {
  return [
    ['Email', account.email],
    ['Plan', account.plan],
    ['Organization', account.organization ?? ''],
  ].filter(([, value]) => value);
}

function renderAccount(account: PanelState['account']) {
  elements.account.hidden = !account;
  const rows = account ? accountRowsOf(account) : [];
  elements.accountRows.replaceChildren(...rows.map(([label, value]) => buildElement('div', { className: 'key-value', title: value }, buildElement('span', {}, label), buildElement('span', {}, value))));
}

function renderMeter(label: string, meter: MeterView, normalColor: string) {
  const color = warningColor(meter.percent);
  return buildElement(
    'div',
    { className: 'meter' },
    buildElement('div', { className: 'meter-header' }, buildElement('span', {}, label), buildElement('span', { className: color ? 'meter-label-warning' : '', style: color ? { color } : {} }, meter.label)),
    buildElement('div', { className: 'meter-track' }, buildElement('div', { className: 'meter-fill', style: { width: `${Math.min(100, meter.percent)}%`, '--bar-color': color || normalColor } })),
    meter.caption ? buildElement('div', { className: 'muted meter-caption' }, meter.caption) : null,
  );
}

function renderUsage(usage: PanelState['usage']) {
  const contextMeter = usage.context && renderMeter('Context', usage.context, 'var(--vscode-charts-blue)');
  const contextDetails = renderContextDetails(usage);
  if (contextMeter) contextMeter.append(...contextDetails);
  const meters = [
    contextMeter,
    usage.fiveHour && renderMeter('Session (5hr)', usage.fiveHour, 'var(--vscode-charts-orange)'),
    usage.weekly && renderMeter('Weekly (7 day)', usage.weekly, 'var(--vscode-charts-purple)'),
    ...(contextMeter ? [] : contextDetails), // no context meter to sit under: the skills list still shows
    usage.costLabel ? buildElement('div', { className: 'muted' }, 'Session cost ' + usage.costLabel) : null,
  ];
  elements.meters.replaceChildren(...meters.filter(isElement));
  elements.sessionLine.replaceChildren(...(usage.session ? sessionLineContent(usage.session) : []));
  elements.usageNote.textContent = usage.note;
  elements.usageNote.classList.toggle('is-clickable', usage.isLiveOff);
  elements.usage.classList.toggle('stale', usage.isStale);
}

function sessionLineContent(session: { title: string; isPinned: boolean }) {
  const text = (session.isPinned ? 'Pinned: ' : 'Following: ') + session.title + '  ';
  return session.isPinned ? [text, buildElement('button', { className: 'link-button', onClick: () => vscode.postMessage({ type: 'select', id: null }) }, 'Follow latest')] : [text];
}

/** A name with a value on the right and a bar under it. @param fraction 0-1, the bar's length. */
function renderBarRow(name: string, valueLabel: string, fraction: number) {
  return buildElement(
    'div',
    { className: 'bar-row', title: name },
    buildElement('div', { className: 'bar-row-header' }, buildElement('span', {}, name), buildElement('span', {}, valueLabel)),
    buildElement('div', { className: 'bar-row-track' }, buildElement('div', { className: 'bar-row-fill', style: { width: `${fraction * 100}%` } })),
  );
}

/** @param skills Most used first. */
function renderSkillRows(skills: NamedAmount[]) {
  return skills.map(([name, uses]) => renderBarRow(name, `×${uses}`, uses / skills[0][1]));
}

/** One full-width stacked bar of what the used context is made of (the Context meter above shows how full it is), and a one-line legend of the biggest parts. */
function renderBreakdownBar(breakdown: Breakdown) {
  const share = (tokens: number) => `${(tokens / breakdown.totalTokens) * 100}%`;
  const segments = [
    buildElement('div', { className: 'breakdown-segment', title: `Baseline ${formatTokens(breakdown.baselineTokens)}`, style: { width: share(breakdown.baselineTokens), background: BASELINE_COLOR } }),
    ...breakdown.parts.map((part) => buildElement('div', { className: 'breakdown-segment', title: `${KIND_LABELS[part.kind]} ~${formatTokens(part.tokens)}`, style: { width: share(part.tokens), background: KIND_COLORS[part.kind] } })),
  ];
  const legend = [`Baseline ${formatTokens(breakdown.baselineTokens)}`, ...breakdown.parts.slice(0, LEGEND_PARTS).map((part) => `${KIND_LABELS[part.kind]} ~${formatTokens(part.tokens)}`)].join(' · ');
  return [buildElement('div', { className: 'breakdown-stack' }, ...segments), buildElement('div', { className: 'muted breakdown-legend' }, legend)];
}

function renderBreakdownRows(breakdown: Breakdown) {
  const buildRow = (label: string, tokens: number, color: string, isEstimate: boolean, isSub = false) =>
    buildElement('div', { className: 'legend-row' + (isSub ? ' is-sub' : ''), style: { '--swatch-color': color } }, buildElement('span', {}, label), buildElement('span', {}, (isEstimate ? '~' : '') + formatTokens(tokens)));
  return [
    buildRow('Baseline (fixed)', breakdown.baselineTokens, BASELINE_COLOR, false),
    ...breakdown.parts.flatMap((part) => [buildRow(KIND_LABELS[part.kind], part.tokens, KIND_COLORS[part.kind], true), ...(part.kind === 'toolResults' ? breakdown.tools.map(([tool, tokens]) => buildRow(tool, tokens, KIND_COLORS.toolResults, true, true)) : [])]),
  ];
}

function renderBiggestResults(breakdown: Breakdown) {
  if (!breakdown.biggestResults.length) return [];
  const rows = breakdown.biggestResults.map((result) =>
    buildElement(
      'div',
      { className: 'biggest-row', title: result.target },
      buildElement('div', { className: 'biggest-row-header' }, buildElement('span', {}, result.target ? `${result.tool} · ${result.target}` : result.tool), buildElement('span', {}, `~${formatTokens(result.tokens)}`)),
      buildElement('div', { className: 'muted' }, `turn ${result.turn}`),
    ),
  );
  return [buildElement('div', { className: 'subheading' }, 'Biggest items'), ...rows];
}

/** The bar, then a "Details" toggle (closed by default) that opens the parts, the biggest items and the skills used. */
function renderContextDetails(usage: PanelState['usage']) {
  const { breakdown, skills = [] } = usage;
  if (!breakdown && !skills.length) return [];
  const toggle = buildElement(
    'button',
    {
      className: 'link-button details-toggle',
      onClick: () => {
        viewState.areDetailsOpen = !viewState.areDetailsOpen;
        saveViewState();
        renderUsage(usage);
      },
    },
    `${viewState.areDetailsOpen ? '▾' : '▸'} Details`,
  );
  const details = buildElement(
    'div',
    { className: 'details' },
    ...(breakdown ? [...renderBreakdownRows(breakdown), ...renderBiggestResults(breakdown)] : []),
    ...(skills.length ? [buildElement('div', { className: 'subheading' }, 'Skills used'), ...renderSkillRows(skills)] : []),
    breakdown ? buildElement('div', { className: 'estimate-note' }, 'Baseline and total are exact. The split is an estimate.') : null,
  );
  return [...(breakdown ? renderBreakdownBar(breakdown) : []), toggle, ...(viewState.areDetailsOpen ? [details] : [])];
}

// ---- chat list ----

/** @param type 'open', 'read', 'delete' or 'deletePermanently' */
function postChatMessage(type: string, chatId: string) {
  vscode.postMessage({ type, id: chatId });
}

/** Click handler for a row's action buttons; the click must not also open the chat. */
function createActionHandler(type: string, chatId: string): (event: MouseEvent) => void {
  return (event) => {
    event.stopPropagation();
    postChatMessage(type, chatId);
  };
}

function renderChatRow(chat: PanelChat, activeChatId: string | undefined) {
  const percentColor = chat.context ? warningColor(chat.context.percent) : '';
  return buildElement(
    'li',
    { className: 'chat-row' + (chat.id === activeChatId ? ' is-selected' : ''), title: `${chat.title}\n${new Date(chat.modifiedAtMs).toLocaleString()}`, onClick: () => postChatMessage('open', chat.id) },
    buildElement('span', { className: 'chat-dot' + (isActive(chat.modifiedAtMs) ? ' is-active' : '') }),
    buildElement('div', { className: 'chat-text' }, buildElement('b', { className: 'chat-title' }, chat.title), buildElement('span', { className: 'chat-project' }, chat.projectName)),
    buildElement('span', { className: 'chat-percent' + (percentColor ? ' is-warning' : ''), style: percentColor ? { color: percentColor } : {}, title: chat.context ? 'Context use' : '' }, chat.context ? Math.round(chat.context.percent) + '%' : ''),
    buildElement('span', { className: 'chat-age' }, formatAge(chat.modifiedAtMs)),
    buildElement(
      'div',
      { className: 'chat-actions' },
      buildElement('button', { title: 'Read the transcript here', onClick: createActionHandler('read', chat.id) }, 'Read'),
      buildElement('button', { className: 'delete-button', title: 'Move this session to the Trash', onClick: createActionHandler('delete', chat.id) }, 'Delete'),
      buildElement('button', { className: 'delete-button permanent-delete-button', title: 'Delete this session permanently (cannot be undone)', 'aria-label': 'Delete permanently', onClick: createActionHandler('deletePermanently', chat.id) }, '✕'),
    ),
  );
}

function matchesFilters(chat: PanelChat) {
  const searchText = viewState.searchText.toLowerCase();
  const matchesSearch = !searchText || chat.title.toLowerCase().includes(searchText) || chat.projectName.toLowerCase().includes(searchText);
  return (!viewState.projectFilter || chat.projectPath === viewState.projectFilter) && (!viewState.showOnlyActive || isActive(chat.modifiedAtMs)) && matchesSearch;
}

/**
 * Ungrouped (new sessions), projects in the open workspace and the project of the session being followed start expanded;
 * everything else is collapsed until opened. A search expands every group that has a match.
 * @param projectPath '' for the ungrouped sessions
 */
function isGroupExpanded(projectPath: string, groupChats: PanelChat[], activeChatId: string | undefined) {
  if (viewState.searchText) return true;
  return viewState.groupToggles[projectPath] ?? (!projectPath || groupChats.some((chat) => chat.isInWorkspace || chat.id === activeChatId));
}

/**
 * The folder name, plus the full path when another project has the same name.
 * @param chat Any chat of the project.
 */
function projectLabel(chat: PanelChat, allChats: PanelChat[]): string {
  const paths = new Set(allChats.filter((other) => other.projectName === chat.projectName).map((other) => other.projectPath));
  return paths.size > 1 ? `${chat.projectName} (${chat.projectPath})` : chat.projectName;
}

/** @param projectPath '' for the ungrouped sessions */
function renderGroupHeader(label: string, projectPath: string, count: number, isExpanded: boolean) {
  const toggle = () => {
    viewState.groupToggles[projectPath] = !isExpanded;
    saveViewState();
    renderChatList();
  };
  // While searching every group is open, so a click would change nothing visible.
  return buildElement('li', { className: 'group-header', title: projectPath, onClick: viewState.searchText ? undefined : toggle }, `${isExpanded ? '▾' : '▸'} ${label || UNGROUPED_LABEL} · ${count}`);
}

/**
 * Group headers (ungrouped first, then projects in the workspace, then the rest), each followed by its rows when expanded.
 * @param chats The chats that pass the filters, newest first.
 */
function renderChatGroups(chats: PanelChat[], state: PanelState | undefined) {
  const allChats = state?.chats ?? [];
  const groups = [...new Set(chats.map((chat) => chat.projectPath))].map((projectPath) => ({ projectPath, groupChats: chats.filter((chat) => chat.projectPath === projectPath) }));
  const rank = (group: { projectPath: string; groupChats: PanelChat[] }) => (!group.projectPath ? 0 : group.groupChats.some((chat) => chat.isInWorkspace) ? 1 : 2);
  return groups
    .sort((first, second) => rank(first) - rank(second))
    .flatMap(({ projectPath, groupChats }) => {
      const isExpanded = isGroupExpanded(projectPath, groupChats, state?.activeChatId);
      const label = projectPath ? projectLabel(groupChats[0], allChats) : '';
      return [renderGroupHeader(label, projectPath, groupChats.length, isExpanded), ...(isExpanded ? groupChats.map((chat) => renderChatRow(chat, state?.activeChatId)) : [])];
    });
}

function renderChatList() {
  const state = viewState.panelState;
  const chats = state?.chats ?? [];
  const projects = [...new Map(chats.filter((chat) => chat.projectPath).map((chat) => [chat.projectPath, projectLabel(chat, chats)])).entries()].sort((first, second) => first[1].localeCompare(second[1]));
  elements.projectFilter.replaceChildren(buildElement('option', { value: '' }, 'All projects'), ...projects.map(([projectPath, label]) => buildElement('option', { value: projectPath }, label)));
  viewState.projectFilter = projects.some(([projectPath]) => projectPath === viewState.projectFilter) ? viewState.projectFilter : '';
  elements.projectFilter.value = viewState.projectFilter;
  elements.activeFilter.textContent = '⚡ Active · ' + chats.filter((chat) => isActive(chat.modifiedAtMs)).length;
  elements.activeFilter.classList.toggle('is-on', viewState.showOnlyActive);
  const visibleChats = chats.filter(matchesFilters);
  elements.chatList.replaceChildren(...renderChatGroups(visibleChats, state));
  elements.chatEmpty.textContent = visibleChats.length ? '' : chats.length ? 'No chats match.' : 'No chats found on disk yet.';
}

// ---- insights ----

function renderTiles(range: RangeInsight) {
  const promptTokens = range.inputTokens + range.cacheCreationTokens + range.cacheReadTokens;
  const tiles = [
    [formatTokens(promptTokens + range.outputTokens), 'Tokens'],
    [formatTokens(range.outputTokens), 'Output'],
    [promptTokens ? Math.round((range.cacheReadTokens / promptTokens) * 100) + '%' : '-', 'Cache hit'],
    [`${range.activeDays} / ${viewState.insightRange}`, 'Active days'],
  ];
  return buildElement('div', { className: 'tiles' }, ...tiles.map(([value, label]) => buildElement('div', { className: 'tile' }, buildElement('b', { className: 'tile-value' }, value), buildElement('span', { className: 'tile-label' }, label))));
}

function describeDay(day: DayInsight) {
  if (!day.totalTokens) return `${formatDate(day.date)} · no usage`;
  const output = day.outputTokens ? ` · out ${formatTokens(day.outputTokens)}` : '';
  const projects = (day.topProjects ?? []).map(([name, tokens]) => `${name} ${formatTokens(tokens)}`).join(', ');
  return `${formatDate(day.date)} · ${formatTokens(day.totalTokens)} tokens${output} · ${projects}`;
}

/** Returns 0 (no usage) to 4 (as busy as the busiest day). */
function heatmapLevel(tokens: number, busiestTokens: number): number {
  return tokens ? Math.min(HEATMAP_LEVELS, Math.ceil((tokens / busiestTokens) * HEATMAP_LEVELS)) : 0;
}

/**
 * A GitHub-style heatmap: columns are weeks, rows are weekdays (Sunday on top), the newest day last.
 */
function renderHeatmap(days: DayInsight[]) {
  const busiestTokens = Math.max(...days.map((day) => day.totalTokens));
  const firstWeekday = new Date(days[0].date + 'T00:00').getDay();
  if (!days.some((day) => day.date === viewState.selectedDay)) viewState.selectedDay = days[days.length - 1].date;
  const detail = buildElement('div', { className: 'day-detail' }, describeDay(days.find((day) => day.date === viewState.selectedDay) ?? days[0]));
  const cells = days.map((day) =>
    buildElement('div', {
      className: 'heatmap-cell' + (day.date === viewState.selectedDay ? ' is-selected' : ''),
      title: `${formatDate(day.date)}: ${formatTokens(day.totalTokens)}`,
      style: day.totalTokens ? { background: `rgba(0, 184, 255, ${HEATMAP_OPACITIES[heatmapLevel(day.totalTokens, busiestTokens)]})` } : {},
      onClick: (event) => {
        viewState.selectedDay = day.date;
        cells.forEach((cell) => cell.classList.remove('is-selected'));
        if (event.currentTarget instanceof HTMLElement) event.currentTarget.classList.add('is-selected');
        detail.textContent = describeDay(day);
      },
    }),
  );
  const spacers = Array.from({ length: firstWeekday }, () => buildElement('div', { className: 'heatmap-cell is-spacer' }));
  return [buildElement('div', { className: 'subheading' }, 'Last 13 weeks'), buildElement('div', { className: 'heatmap' }, ...spacers, ...cells), detail];
}

function renderTopProjects(range: RangeInsight, totalTokens: number) {
  if (!range.projects.length) return [];
  const largest = range.projects[0][1];
  const rows = range.projects.map(([name, tokens]) => renderBarRow(name, `${formatTokens(tokens)} · ${Math.round((tokens / totalTokens) * 100)}%`, tokens / largest));
  return [buildElement('div', { className: 'subheading' }, 'Top projects'), ...rows];
}

function modelColor(index: number) {
  return MODEL_COLORS[index % MODEL_COLORS.length];
}

function renderModelMix(range: RangeInsight, totalTokens: number) {
  if (!range.models.length) return [];
  const stack = buildElement('div', { className: 'model-stack' }, ...range.models.map(([modelId, tokens], index) => buildElement('div', { className: 'model-stack-segment', title: modelId, style: { width: `${(tokens / totalTokens) * 100}%`, background: modelColor(index) } })));
  const legend = range.models.map(([modelId, tokens], index) =>
    buildElement('div', { className: 'legend-row', style: { '--swatch-color': modelColor(index) } }, buildElement('span', {}, modelId.replace(/^claude-/, '')), buildElement('span', {}, Math.round((tokens / totalTokens) * 100) + '%')),
  );
  return [buildElement('div', { className: 'subheading' }, 'Models'), stack, ...legend];
}

function renderTopSkills(range: RangeInsight) {
  if (!range.skills.length) return [];
  return [buildElement('div', { className: 'subheading' }, 'Top skills'), ...renderSkillRows(range.skills), buildElement('div', { className: 'muted skills-note' }, 'From logs still on this computer. Counts uses, not tokens.')];
}

function renderInsightsFooter(insights: Insights) {
  const facts = [insights.streakDays ? `🔥 ${insights.streakDays}-day streak` : '', insights.busiestDay ? `Busiest ${formatDate(insights.busiestDay.date)} (${formatTokens(insights.busiestDay.totalTokens)})` : ''].filter(Boolean);
  return facts.length ? [buildElement('div', { className: 'insights-footer' }, facts.join(' · '))] : [];
}

function renderRangeSwitch() {
  elements.rangeSwitch.replaceChildren(
    ...INSIGHT_RANGES.map((days) =>
      buildElement(
        'button',
        {
          className: days === viewState.insightRange ? 'is-on' : '',
          onClick: () => {
            viewState.insightRange = days;
            saveViewState();
            renderInsights();
          },
        },
        `${days}d`,
      ),
    ),
  );
}

function renderInsights() {
  renderRangeSwitch();
  const insights = viewState.panelState?.insights;
  if (!insights?.days.some((day) => day.totalTokens)) {
    elements.insightsBody.replaceChildren(buildElement('div', { className: 'muted' }, 'No usage recorded yet.'));
    return;
  }
  const range = insights.ranges[viewState.insightRange];
  const totalTokens = range.inputTokens + range.cacheCreationTokens + range.cacheReadTokens + range.outputTokens;
  elements.insightsBody.replaceChildren(renderTiles(range), ...renderHeatmap(insights.days), ...renderTopProjects(range, totalTokens), ...renderModelMix(range, totalTokens), ...renderTopSkills(range), ...renderInsightsFooter(insights));
}

// ---- wiring ----

function renderAll() {
  const state = viewState.panelState;
  if (state) {
    renderAccount(state.account);
    renderUsage(state.usage);
  }
  renderChatList();
  renderInsights();
}

elements.newSession.addEventListener('click', () => vscode.postMessage({ type: 'new' }));
elements.usageNote.addEventListener('click', () => {
  if (viewState.panelState?.usage.isLiveOff) vscode.postMessage({ type: 'enable' });
});
elements.projectFilter.addEventListener('change', () => {
  viewState.projectFilter = elements.projectFilter.value;
  saveViewState();
  renderChatList();
});
elements.activeFilter.addEventListener('click', () => {
  viewState.showOnlyActive = !viewState.showOnlyActive;
  saveViewState();
  renderChatList();
});
elements.search.addEventListener('input', () => {
  viewState.searchText = elements.search.value;
  renderChatList();
});
window.addEventListener('message', (event) => {
  viewState.panelState = event.data;
  renderAll();
});
setInterval(renderChatList, REFRESH_INTERVAL_MS); // relative times and the Active dot move with the clock

vscode.postMessage({ type: 'ready' });
