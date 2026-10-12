# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Complementer is a VS Code extension that complements the official Claude Code extension: context and plan-limit meters (status bar and a Sessions panel), a session manager (new session, open, read, delete), and usage insights. Independent project, not affiliated with Anthropic. TypeScript (strict), compiled with `tsc` to `out/` (CommonJS); no bundler and no runtime dependencies.

Specs and roadmap: `docs/superpowers/specs/complementer-design.md` (what is built and why) and `docs/superpowers/plans/roadmap-v1-v2.md` (v1 and v2 milestones, released together as 1.0.0; what is left before publishing). Read the spec before changing behaviour.

## Commands

```
npm run build   # clean, tsc (src + test), tsc (webview script), copy hook.sh / panel.html / panel.css into out/
npm test        # builds, then node:test on out/test, 113 tests; must pass
npm run build && node --test out/test/logs.test.js   # one test file (add --test-name-pattern="..." for one test)
npm run lint    # ESLint (also enforces naming and const/let)
npm run check   # tsc --noEmit over two projects: src + test, and src/views/panel.ts (the webview script, with DOM types)
npm run package # runs lint + check + tests, then builds (`out/` is git-ignored; the .vsix ships `out/src` only) release/complementer-<version>.vsix
```

Run lint, check and test before saying work is done. Never commit `*.vsix` (git-ignored); `release/` only holds build output.

## Layout

```
src/extension.ts        VS Code wiring: class ComplementerExtension (status bar, panel provider, commands, watchers, timers)
src/types.ts            Every shared interface and type alias (types only). Other files `import type` from here
src/consts.ts           Every module-level constant (hook.ts and views/panel.ts keep their own: they run standalone)
src/view-model.ts       Pure functions: which session is shown, meters, insights, panel state, formatters. No vscode, no I/O.
src/logs.ts             parseUsageLine, iterateLineBatches, readNewRecords, History (totals + offsets, one atomic file), Scanner
src/breakdown.ts        createSessionTally, addEntry, readSessionTally: sizes of what fills the shown session's context (in memory, names and sizes only)
src/skills.ts           parseSkillUses, SkillHistory: per-day and per-session skill call counts in skills.json (own file and offsets; v2, v1 is migrated)
src/chats.ts            ChatIndex, renderTranscript, getSessionPaths (everything Claude keeps per session)
src/live.ts             parsePayload, pickSessions, isWithin, effectiveLimit, LiveFeed; also parseAccount / readAccount from ~/.claude.json (display fields only) (watches live/<sessionId>.json)
src/usage.ts            queryUsage, parseUsageOutput: plan limits from the user's own `claude` via the `get_usage` control request (undocumented; the ↻ button is the fallback)
src/setup.ts            planEnable / enableStatusLine / disableStatusLine: chains the user's statusLine through the hook
src/uninstall.ts        vscode:uninstall script: restores the user's statusLine
src/utils.ts            Shared helpers: non-throwing file and JSON reads (tryReadText, tryParseJson), small pure functions
src/hook.sh, hook.ts    statusLine passthrough (POSIX sh on macOS/Linux, Node on Windows); same contract
src/views/              The Sessions panel as real files: panel.html (template), panel.css, panel.ts (browser script),
                        tsconfig.json (DOM + @types/vscode-webview)
test/                   *.test.ts plus helpers.ts; extension.test.ts runs the real extension against a stubbed `vscode`
```

## Conventions (the linter enforces most of these)

- **Names say what they are.** No one- or two-letter identifiers (except `i`, `j`, `id`, and the Node aliases `fs`, `os`, `vm`). Functions are verb-first camelCase (`computeMeters`, `readNewRecords`); classes and typedefs are PascalCase; constants are UPPER_SNAKE. Avoid abbreviations (`workingDirectory`, not `cwd`; `inputTokens`, not `in`).
- **`const` over `let`.** Restructure with `map`/`flatMap`/`reduce`, helper functions and `tryParseJson` before reaching for `let`. A `let` is acceptable only for genuine loop state (see `iterateLineBatches`).
- **Async only.** No `*Sync` fs or child_process calls anywhere (the extension host's event loop is shared with every other extension). Use `fs/promises`, `src/utils.ts` helpers, `for await`.
- **Types in TypeScript, shared shapes in `src/types.ts`.** Annotate inline (`function f(chat: Chat): string`), `import type { Chat } from './types'`, and declare class fields once at the top of the class. Keep a short `/** description */` or `//` comment only where it explains something the types cannot. `any` is allowed for parsed JSON from Claude's own files (it has no fixed shape); narrow it as soon as you can.
- **Constants live in `src/consts.ts`** (UPPER_SNAKE), not at the top of each module. Exceptions: `hook.ts` is copied alone into the user's storage folder and `views/panel.ts` runs in the browser, so neither can import it.
- **Descriptive data shapes.** Persisted and cross-module fields are fully spelled out (`cacheReadTokens`, `modifiedAtMs`). Changing a persisted shape needs a migration (see `migrateHistoryV1` and the `had`/`hadStatusLine` fallback in `setup.ts`).
- Put decisions in `view-model.ts` (pure, unit-tested; it also fills the panel.html template); keep `extension.ts` to wiring.
- The webview script renders with `textContent`/DOM calls only. Chat titles come from log files and must never be inserted as HTML. The CSP allows only our nonce'd script and stylesheet (no inline styles: use classes or `style.setProperty`).

## Domain facts that bite

- One API response is logged **once per content block** with the same `message.id`, and the blocks can carry different `output_tokens`. Keep the largest and add only the difference (`History.addRecord`). Summing or keeping the first is wrong by double digits.
- Plan limits (5-hour, weekly) are account-wide. Two sources: the statusLine payload (`rate_limits`, terminal sessions only, and only after a first reply), and `queryUsage` (src/usage.ts), which starts the official extension's own `claude` binary and sends the `get_usage` control request, as the official panel does; it sends no message and logs no session. The chat panel never runs the statusLine. Context % needs the model's window size, learned from live payloads into `windows.json`; with no known size, show nothing (never guess).
- Token totals are anonymous aggregates and are kept when a session is deleted. Chat content is never stored.
- The panel's **Refresh** button (the ↻ icon at the right of the Usage heading) must resume the *followed* session, not a throwaway one: it opens a terminal in that session's folder, runs `claude --resume <session id>`, sends "hi", waits for the limits, runs `/exit` and closes the terminal (`refreshLimits` in `extension.ts`). The resumed session reports a live payload, which is the only thing that feeds the Context meter and breakdown bar (the chat panel never runs the statusLine), so a Context bar missing for a chat-panel-only session is expected until Refresh. Only when no session is followed does it start a fresh `--session-id` helper (in `activationSessionIds`, never followed). The background `queryUsage` timer is separate and feeds limits only. Refresh only counts a live payload written after it started (resumed sessions keep old payloads for days), runs one at a time, and asks first when the chat changed in the last minute (it may be open in the chat panel).
- Skill counts are saved per day (Insights "Top Skills", do not change it) and per session id (`skills.json` v2, `sessions`), which feeds the "skills ×N" line on each chat row; the followed session's "Skills used" under Details is still tallied in memory from its log. A v1 file keeps its day counts and gets a one-off sessions-only backfill (`needsSessionBackfill`).
- With nothing pinned the panel follows the **newest chat** in the workspace, not the last session that reported live; otherwise a new chat (no payload yet) would keep showing the old session's meters and Refresh would resume the old one. New chats that appear after startup get one automatic Refresh, behind the setting `complementer.autoActivateNewChats` (`ask` default, or `off`; never silent, since the resume adds a message to a chat that is usually open in the chat panel), 10 s after they go quiet (`activateNewChats` in `extension.ts`). With `off`, or after dismissing the question, the panel note says the context is estimated from the log and points to ↻.
- The cost on a chat row is only what Claude Code reports live (`costUsd`), kept as the highest value per session in `session-costs.json` (`learnSessionCosts`); never estimated from tokens (no pricing table). The Insights Cost tile sums `day-costs.json` (local day -> cost): each rise of a session's highest cost is added to the day it was seen (`learnCosts` in `view-model.ts`); days with nothing recorded show `--`. Nothing is back-filled, and deleting a chat keeps the day totals.
- `claude-vscode.newConversation` only pings an already-open chat; use `claude-vscode.primaryEditor.open` (optionally with a session id).
- `getSessionPaths` is the only place that decides what a delete touches; it refuses anything that is not a UUID-named log inside `~/.claude/projects`. Delete moves to the Trash by default (`useTrash: true`); the row's ✕ button deletes for good (`useTrash: false`) behind its own confirmation, and one answer never confirms the other. Both go through `getSessionPaths`.
- Skills are counted from assistant `tool_use` blocks named `Skill` only. Typed `/name` commands cannot be told from built-ins (`/clear`, `/model`), so they are not counted. Names from logs pass `NAME_PATTERN` before they are counted or shown.
- The context breakdown measures sizes in characters and scales them to the measured growth in tokens since the first response: baseline and total are exact, the split is an estimate. No compaction marker has been seen in a real log, so compaction is detected by the context shrinking below the last response: the sizes are then dropped and the baseline restarts (skills and turns are kept).

## Don't

- Don't patch or edit files of the official Claude Code extension, call undocumented endpoints, or read credentials/tokens. The one deliberate exception is `src/usage.ts`: it runs the installed `claude` binary and sends it the undocumented `get_usage` control request (no network call or credential read of our own). Every failure must leave the panel working, with the ↻ button still refreshing; do not widen this to other requests. Reading `~/.claude.json` is limited to the `oauthAccount` display fields.
- Don't add a pricing table or cost estimates, a backend, telemetry, or network calls.
- Don't add dependencies for a few lines of code. Runtime has none; dev dependencies are ESLint (with typescript-eslint), TypeScript and the type packages.
- Don't commit `.vsix` files, `out/`, `node_modules`, or anything from `~/.claude`.

## Testing notes

- Tests are compiled with the source and run from `out/test`; paths like `path.join(__dirname, '..', 'src')` point at the compiled `out/src`. Tests that need VS Code load `out/src/extension.js` through a stubbed `vscode` module and a fake `HOME` (see `test/extension.test.ts`); dispose the extension after each test or the process will not exit.
- The webview script is tested by running the compiled `out/src/views/panel.js` against a minimal fake DOM built from the real `panel.html` (`test/panel.test.ts`).
- A real VS Code run of the UI, Linux, and Windows have not been verified; say so rather than claiming it.

## Docs

`README.md` is also the Marketplace page: keep it short and about what the extension adds, no developer notes (those go in `CONTRIBUTING.md`). Update `CHANGELOG.md` per release, and the spec and roadmap when behaviour changes.

## Git

Use Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`), imperative and lowercase subject under about 72 characters, with a short body explaining why when it is not obvious. Keep commits focused. Do not commit or push without being asked.
