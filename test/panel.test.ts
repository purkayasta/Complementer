// Runs the real src/views/panel.js against a minimal fake DOM built from the real src/views/panel.html.
import test from 'node:test';
import assert from 'node:assert';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import type { Breakdown, DayInsight, PanelState, RangeInsight } from '../src/types';
import { renderPanelHtml } from '../src/view-model';

const VIEWS_DIRECTORY = path.join(__dirname, '..', 'src', 'views');

type Listener = (event?: any) => void;

class FakeHTMLElement {
  children: FakeHTMLElement[] = [];

  attributes: Record<string, string> = {};

  styleProperties: Record<string, string> = {};

  classes = new Set<string>();

  listeners: Record<string, Listener> = {};

  ownText = '';

  value = '';

  hidden = false;

  style = { setProperty: (name: string, value: string) => (this.styleProperties[name] = value) };

  constructor(public tagName: string) {}

  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }

  get classList() {
    return {
      add: (name: string) => this.classes.add(name),
      remove: (name: string) => this.classes.delete(name),
      toggle: (name: string, isOn: boolean) => (isOn ? this.classes.add(name) : this.classes.delete(name)),
    };
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  append(...nodes: (FakeHTMLElement | string)[]) {
    for (const node of nodes) this.children.push(typeof node === 'string' ? Object.assign(new FakeHTMLElement('#text'), { ownText: node }) : node);
  }

  replaceChildren(...nodes: (FakeHTMLElement | string)[]) {
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(eventName: string, handler: Listener) {
    this.listeners[eventName] = handler;
  }

  set textContent(text: string) {
    this.ownText = String(text);
    this.children = [];
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }
}
class FakeHTMLSelectElement extends FakeHTMLElement {}
class FakeHTMLInputElement extends FakeHTMLElement {}

const ELEMENT_CLASSES: Record<string, typeof FakeHTMLElement> = { select: FakeHTMLSelectElement, input: FakeHTMLInputElement };

/** Every element in the template with an id, created as the right fake type. */
function createElementsFromTemplate(template: string): Record<string, FakeHTMLElement> {
  const idTags = [...template.matchAll(/<(\w+)[^>]*\sid="([^"]+)"/g)];
  return Object.fromEntries(idTags.map(([, tagName, id]) => [id, new (ELEMENT_CLASSES[tagName] ?? FakeHTMLElement)(tagName)]));
}

/** Start the panel script and give back what the test needs to drive it. */
async function loadPanel() {
  const template = await fsPromises.readFile(path.join(VIEWS_DIRECTORY, 'panel.html'), 'utf8');
  const script = await fsPromises.readFile(path.join(VIEWS_DIRECTORY, 'panel.js'), 'utf8');
  const elementsById = createElementsFromTemplate(template);
  const rootElement = new FakeHTMLElement('html');
  const postedMessages: unknown[] = [];
  const handlers: Record<string, Listener> = {};
  vm.runInNewContext(script, {
    document: { documentElement: rootElement, getElementById: (id: string) => elementsById[id] ?? null, createElement: (tagName: string) => new FakeHTMLElement(tagName) },
    window: { addEventListener: (eventName: string, handler: Listener) => (handlers[eventName] = handler) },
    HTMLElement: FakeHTMLElement,
    HTMLSelectElement: FakeHTMLSelectElement,
    HTMLInputElement: FakeHTMLInputElement,
    acquireVsCodeApi: () => ({ getState: () => undefined, setState() {}, postMessage: (message: unknown) => postedMessages.push(JSON.parse(JSON.stringify(message))) }),
    setInterval: () => 0,
  });
  return { elementsById, rootElement, postedMessages, sendState: (state: unknown) => handlers.message({ data: state }) };
}

/** Every descendant (and the root) that passes the test. */
function findAll(root: FakeHTMLElement, matches: (element: FakeHTMLElement) => boolean): FakeHTMLElement[] {
  return [...(matches(root) ? [root] : []), ...root.children.flatMap((child) => findAll(child, matches))];
}

const hasClass = (name: string) => (element: FakeHTMLElement) => element.classes.has(name);

function dayInsight(dayOfMonth: number, totalTokens: number): DayInsight {
  return { date: `2026-10-${String(dayOfMonth).padStart(2, '0')}`, totalTokens, ...(totalTokens ? { outputTokens: 5, topProjects: [['proj', totalTokens]] } : {}) };
}

const RANGE: RangeInsight = { inputTokens: 10, cacheCreationTokens: 20, cacheReadTokens: 970, outputTokens: 5, projects: [['proj', 1005]], models: [['claude-sonnet-5-5', 1005]], skills: [['code-review', 19], ['docs-graph', 9]] };

const BREAKDOWN = {
  baselineTokens: 1000,
  totalTokens: 1600,
  windowSize: 10000,
  parts: [{ kind: 'toolResults', tokens: 450 }, { kind: 'assistantText', tokens: 150 }],
  tools: [['Read', 300], ['Bash', 150]],
} satisfies Breakdown;

const STATE: PanelState = {
  account: { email: 'a@b.co', plan: 'Team · Standard', organization: 'Acme' },
  usage: {
    context: { percent: 55, label: '55%', caption: '1 / 2 tokens' },
    fiveHour: { percent: 85, label: '85%', caption: 'Resets in 3m' },
    session: { title: 'My chat', isPinned: true },
    isStale: false,
    isLiveOff: false,
    note: '',
  },
  chats: [
    { id: 'c1', title: 'First chat', projectName: 'proj', projectPath: '/w/proj', isInWorkspace: true, modifiedAtMs: Date.now(), context: { percent: 82 } },
    { id: 'c2', title: 'Second chat', projectName: 'other', projectPath: '/x/other', isInWorkspace: false, modifiedAtMs: Date.now() - 86400000 },
    { id: 'c3', title: 'Just started', projectName: '', projectPath: '', isInWorkspace: false, modifiedAtMs: Date.now() },
  ],
  insights: { days: [dayInsight(9, 0), dayInsight(10, 400), dayInsight(11, 605)], ranges: { 1: RANGE, 7: RANGE, 30: RANGE }, streakDays: 2, busiestDay: { date: '2026-10-11', totalTokens: 605 } },
  activeChatId: 'c1',
};

test('the template fills its placeholders and contains no unknown ones', async () => {
  const html = renderPanelHtml(await fsPromises.readFile(path.join(VIEWS_DIRECTORY, 'panel.html'), 'utf8'), { nonce: 'abc', cspSource: 'vscode-webview://x', styleUri: 'style.css', scriptUri: 'panel.js' });
  assert.ok(html.includes("script-src 'nonce-abc'"));
  assert.ok(html.includes('href="style.css"') && html.includes('src="panel.js"'));
  assert.doesNotMatch(html, /\{\{/);
});

test('panel renders account, usage levels, chat rows and insights without errors', async () => {
  const { elementsById, sendState } = await loadPanel();
  sendState(STATE);
  assert.deepStrictEqual(elementsById['account-rows'].children.map((row) => row.textContent), ['Emaila@b.co', 'PlanTeam · Standard', 'OrganizationAcme']);
  assert.strictEqual(elementsById.account.hidden, false);
  assert.deepStrictEqual(findAll(elementsById['chat-list'], hasClass('group-header')).map((header) => header.textContent), ['▾ Ungrouped · 1', '▾ proj · 1']); // Active is on by default: the day-old chat is hidden
  elementsById['active-filter'].listeners.click(); // show everything
  // Ungrouped and the workspace project are open, 'other' is collapsed: 3 headers + 2 rows.
  assert.deepStrictEqual(findAll(elementsById['chat-list'], hasClass('group-header')).map((header) => header.textContent), ['▾ Ungrouped · 1', '▾ proj · 1', '▸ other · 1']);
  assert.strictEqual(findAll(elementsById['chat-list'], (element) => element.classes.has('delete-button')).length, 4); // Trash and permanent, for each of the 2 open rows
  assert.strictEqual(findAll(elementsById['chat-list'], hasClass('chat-age')).length, 2); // class names must survive renames
  findAll(elementsById['chat-list'], hasClass('group-header'))[2].listeners.click(); // open 'other'
  assert.strictEqual(findAll(elementsById['chat-list'], hasClass('chat-age')).length, 3);
  assert.strictEqual(findAll(elementsById['insights-body'], hasClass('tile')).length, 4);
  assert.strictEqual(findAll(elementsById['insights-body'], (element) => element.classes.has('heatmap-cell') && !element.classes.has('is-spacer')).length, 3);
  assert.match(elementsById['insights-body'].textContent, /2-day streak/);
  const barColors = findAll(elementsById.meters, hasClass('meter-fill')).map((fill) => fill.styleProperties['--bar-color']);
  assert.ok(barColors.includes('var(--vscode-charts-yellow)')); // 55%: above 50
  assert.ok(barColors.includes('var(--vscode-charts-red)')); // 85%: from 80
});

test('panel messages: click opens, Delete deletes without opening, range switch re-renders, Follow latest unpins', async () => {
  const { elementsById, postedMessages, sendState } = await loadPanel();
  sendState(STATE);
  const row = findAll(elementsById['chat-list'], hasClass('chat-row')).find((chatRow) => findAll(chatRow, hasClass('chat-title'))[0].textContent === 'First chat');
  assert.ok(row);
  const [deleteButton] = findAll(row, hasClass('delete-button'));
  const stoppedPropagation = [];
  deleteButton.listeners.click({ stopPropagation: () => stoppedPropagation.push(true), currentTarget: deleteButton });
  assert.deepStrictEqual(postedMessages.at(-1), { type: 'delete', id: 'c1' });
  assert.strictEqual(stoppedPropagation.length, 1); // the click must not also open the chat
  const [, permanentButton] = findAll(row, hasClass('delete-button'));
  permanentButton.listeners.click({ stopPropagation: () => {}, currentTarget: permanentButton });
  assert.deepStrictEqual(postedMessages.at(-1), { type: 'deletePermanently', id: 'c1' });
  row.listeners.click({});
  assert.deepStrictEqual(postedMessages.at(-1), { type: 'open', id: 'c1' });
  elementsById['range-switch'].children[0].listeners.click(); // 7d
  assert.match(elementsById['insights-body'].children[0].children[0].textContent, /1\.0k/);
  findAll(elementsById['session-line'], (element) => element.tagName === 'button')[0].listeners.click();
  assert.deepStrictEqual(postedMessages.at(-1), { type: 'select', id: null });
  elementsById['new-chat'].listeners.click();
  assert.deepStrictEqual(postedMessages.at(-1), { type: 'newChat' });
});

test('groups: same-named folders stay apart, the followed session opens its group, a search makes headers inert', async () => {
  const { elementsById, sendState } = await loadPanel();
  const chat = (id: string, projectPath: string) => ({ id, title: id, projectName: 'app', projectPath, isInWorkspace: false, modifiedAtMs: Date.now() });
  sendState({ ...STATE, chats: [chat('one', '/a/app'), chat('two', '/b/app')], activeChatId: 'two' });
  const headers = () => findAll(elementsById['chat-list'], hasClass('group-header')).map((header) => header.textContent);
  assert.deepStrictEqual(headers().sort(), ['▸ app (/a/app) · 1', '▾ app (/b/app) · 1']); // two groups, the followed one open
  elementsById.search.value = 'one';
  elementsById.search.listeners.input();
  const [onlyHeader] = findAll(elementsById['chat-list'], hasClass('group-header'));
  assert.strictEqual(onlyHeader.textContent, '▾ app (/a/app) · 1'); // a search opens the matching group
  assert.strictEqual(onlyHeader.listeners.click, undefined); // and nothing to toggle while searching
});

test('the project dropdown keeps its options (an open list would close) until the projects change', async () => {
  const { elementsById, sendState } = await loadPanel();
  const chat = (id: string, projectPath: string) => ({ id, title: id, projectName: projectPath.slice(1), projectPath, isInWorkspace: false, modifiedAtMs: Date.now() });
  sendState({ ...STATE, chats: [chat('one', '/a')] });
  const firstOptions = elementsById['project-filter'].children;
  sendState({ ...STATE, chats: [chat('one', '/a')] }); // same projects, a new message
  assert.strictEqual(elementsById['project-filter'].children, firstOptions);
  sendState({ ...STATE, chats: [chat('one', '/a'), chat('two', '/b')] });
  assert.strictEqual(elementsById['project-filter'].children.length, 3); // All projects, a, b
});

test('panel shows empty states without crashing', async () => {
  const { elementsById, sendState } = await loadPanel();
  sendState({ usage: { isStale: false, isLiveOff: true, note: 'Live meters are off.' }, chats: [], insights: { days: [dayInsight(11, 0)], ranges: { 1: RANGE, 7: RANGE, 30: RANGE }, streakDays: 0 } });
  assert.match(elementsById['chat-empty'].textContent, /No chats found/);
  assert.match(elementsById['insights-body'].textContent, /No usage recorded yet/);
  assert.strictEqual(elementsById['usage-note'].textContent, 'Live meters are off.');
});

test('the ↻ icon next to Usage asks the extension to refresh the limits', async () => {
  const { elementsById, postedMessages, sendState } = await loadPanel();
  sendState(STATE);
  elementsById['refresh-usage'].listeners.click();
  assert.deepStrictEqual(postedMessages.at(-1), { type: 'refreshLimits' });
});

test('context breakdown: a bar and legend by default, details on demand, log names only as text', async () => {
  const { elementsById, sendState } = await loadPanel();
  sendState({ ...STATE, usage: { ...STATE.usage, breakdown: BREAKDOWN, skills: [['code-review', 8], ['docs-graph', 4]] } });
  const meters = elementsById.meters;
  assert.strictEqual(findAll(meters, hasClass('breakdown-segment')).length, 3); // baseline and two parts
  const segmentWidths = findAll(meters, hasClass('breakdown-segment')).map((segment) => parseFloat(segment.styleProperties.width));
  assert.strictEqual(segmentWidths.reduce((sum, width) => sum + width, 0), 100); // the bar is the whole used context, however full the window is
  assert.deepStrictEqual(findAll(meters, hasClass('breakdown-stack'))[0].styleProperties, {}); // full width: no width of its own
  assert.deepEqual(findAll(meters, hasClass('legend-item')).map((item) => item.textContent), ['Baseline 1.0k', 'Tool results ~450', 'Assistant text ~150']);
  assert.strictEqual(findAll(meters, hasClass('details')).length, 0); // collapsed by default
  findAll(meters, hasClass('details-toggle'))[0].listeners.click();
  const details = findAll(meters, hasClass('details'))[0];
  assert.match(details.textContent, /Baseline \(fixed\)1\.0k/);
  assert.match(details.textContent, /Read~300/); // per-tool subtotal
  assert.doesNotMatch(details.textContent, /Biggest/);
  assert.match(details.textContent, /Skills used/);
  assert.match(details.textContent, /code-review×8/);
  assert.match(details.textContent, /The split is an estimate/);
  findAll(meters, hasClass('details-toggle'))[0].listeners.click();
  assert.strictEqual(findAll(meters, hasClass('details')).length, 0); // and closes again
});

test('context breakdown: skills alone still get a Details toggle, nothing at all gets none', async () => {
  const { elementsById, sendState } = await loadPanel();
  sendState({ ...STATE, usage: { ...STATE.usage, skills: [['code-review', 2]] } });
  assert.strictEqual(findAll(elementsById.meters, hasClass('breakdown-segment')).length, 0); // no breakdown without a window size or growth
  assert.strictEqual(findAll(elementsById.meters, hasClass('details-toggle')).length, 1);
  sendState(STATE);
  assert.strictEqual(findAll(elementsById.meters, hasClass('details-toggle')).length, 0);
});

test('insights list the most used skills for the chosen range, and nothing when there are none', async () => {
  const { elementsById, sendState } = await loadPanel();
  sendState(STATE);
  const text = elementsById['insights-body'].textContent;
  assert.match(text, /Top skills/);
  assert.match(text, /code-review×19/);
  assert.match(text, /Counts uses, not tokens/);
  const noSkills = { ...RANGE, skills: [] };
  sendState({ ...STATE, insights: { ...STATE.insights, ranges: { 1: noSkills, 7: noSkills, 30: noSkills } } });
  assert.doesNotMatch(elementsById['insights-body'].textContent, /Top skills/);
});

/** WCAG relative luminance of an `rgb(r, g, b)` string. */
function luminanceOfRgb(color: string): number {
  const [red, green, blue] = (color.match(/\d+/g) ?? []).map((channel) => Number(channel) / 255).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

test('the button and the bars get random colours that stay readable: white text on them, and visible on a light and a dark theme', async () => {
  const colorsSeen = new Set<string>();
  for (let load = 0; load < 40; load++) {
    const { rootElement, elementsById, sendState } = await loadPanel();
    sendState({ ...STATE, usage: { ...STATE.usage, fiveHour: { percent: 10, label: '10%', caption: '' }, context: { percent: 20, label: '20%', caption: '' } } });
    const colors = ['--button-start', '--button-end', '--accent-start', '--accent-end'].map((name) => rootElement.styleProperties[name]);
    const barColors = findAll(elementsById.meters, hasClass('meter-fill')).map((fill) => fill.styleProperties['--bar-color']);
    assert.ok(barColors.length >= 2 && barColors.every((color) => /^rgb\(/.test(color)));
    for (const color of [...colors, ...barColors]) {
      const luminance = luminanceOfRgb(color);
      assert.ok(1.05 / (luminance + 0.05) >= 4.5, `${color} is too light for white text`);
      assert.ok((luminance + 0.05) / (0.013 + 0.05) >= 3, `${color} is too dark for a dark theme`);
      colorsSeen.add(color);
    }
  }
  assert.ok(colorsSeen.size > 20); // not the same colours every time
});
