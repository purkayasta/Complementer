# Complementer: Design (as built)

VS Code extension that complements the official Claude Code extension. Independent project, not affiliated with Anthropic. TypeScript (strict), compiled with `tsc` to `out/` (CommonJS); no bundler, no runtime dependencies. This document describes what exists; `../plans/roadmap-v1-v2.md` lists the v1 and v2 milestones (released together as 1.0.0) and what is left before publishing, and `/CLAUDE.md` holds the working conventions.

## Goal

Show, from the first message and per session: how full the context is and how much of the 5-hour and weekly plan limits is used. Add a session manager (new session, open any chat, read, delete) and local usage insights. Performance and accuracy are the main themes.

## Non-goals

- No UI inside the official Claude chat panel. VS Code has no API for it, and the official panel allows no network or file access for injected code. The panel docks beside it instead.
- No backend, accounts, telemetry or network calls.
- No pricing or cost estimates. Only the session cost Claude Code itself reports is shown.
- No stored chat content.

## Surfaces

1. **Status bar:** `Ctx 62% | 5h 41% | wk 18%` for the selected session. Background warning above 50%, error from 80% (worst of the three). Tooltip: account, exact tokens, reset times, session cost, today's tokens, stale and live-off notes.
2. **Sessions panel** (one webview view in its own activity-bar container; files in `src/views/`):
   - Account: email, plan tier (organization type plus seat tier, e.g. "Team · Standard") and organization; hidden when not signed in with an account.
   - Usage bars (5-hour, weekly, then context, so the long context block is last) with "Resets in ..." captions; bars yellow above 50%, red from 80%.
   - **New session** button.
   - Chat list grouped by project (groups are keyed by full folder path, so two folders with the same name stay apart and show their path): "Ungrouped" (a new session whose log has no folder yet; it moves into its project once one is recorded) and the open workspace's project start expanded, as does the project of the session being followed; every other project is collapsed until clicked (choices are remembered; a search opens matching groups and header clicks do nothing while it is active). Rows: title, per-chat context %, age, active dot (modified in the last 5 minutes); search, project filter, Active toggle. Click opens the chat in the official view and pins the bars to it; "Follow latest" unpins. Hover **Read** (markdown transcript), **Delete** (to the Trash) and **✕** (permanent delete); see below.
   - Insights with a 7/30/90-day switch: tiles (tokens, output, cache hit %, active days), a 13-week heatmap (click a day for its total, output and top projects), top projects, model mix, streak and busiest day.

## Per session vs account

| Data | Scope | Source |
|---|---|---|
| Context tokens | session | live payload, else the last main-thread usage in that session's log |
| Context % | session | tokens divided by the model's window size; shown only if the size is known |
| Session cost | session | live payload only |
| 5-hour and weekly % | account | newest live payload from any session |

The shown session is the pinned chat, or else the newest session in the workspace (the live payload that last reported there, otherwise the newest chat whose working directory is inside a workspace folder). A pinned session whose log disappears is unpinned.

## Data sources (verified)

### Session logs
`~/.claude/projects/<project>/<sessionId>.jsonl`, plus `<project>/<session>/subagents/*.jsonl` (sidechain records). One JSON object per line.
- Assistant records carry `message.usage` (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`), `message.id`, `message.model`, `cwd`, `sessionId`, `isSidechain`, `timestamp`.
- **One API response is logged once per content block with the same `message.id`.** The blocks can carry different `output_tokens` (542 of 10,783 records did on the test machine), so the largest value is kept and a repeat adds only the difference. Summing blocks or keeping the first is wrong by a large margin.
- `ai-title` records give Claude Code's own chat title (the last one wins). Other record types exist and are ignored safely.
- Claude Code deletes old logs, so history is only as old as the first scan.

### Account profile
`~/.claude.json` has an `oauthAccount` block with `emailAddress`, `organizationName`, `organizationType` (e.g. `claude_team`), `seatTier` (e.g. `team_standard`) and `billingType`. These are display fields; the block contains no tokens (checked by key names). `readAccount` (in `src/live.ts`) reads only those fields, checked at most once a minute and parsed only when the file changed, and never stores or transmits them. API-key users have no `oauthAccount`, so nothing is shown.

### statusLine payload (spike, Claude Code 2.1.296)
Claude Code passes a JSON payload to the `statusLine` command on stdin: `context_window.{used_percentage, context_window_size, current_usage}`, `rate_limits.{five_hour,seven_day}.{used_percentage, resets_at}`, `cost.total_cost_usd`, `session_id`, `cwd`, `model.{id, display_name}`, `prompt_cache`, and more. Every field is treated as optional. Claude Code has one `statusLine` command, so the extension chains the user's own.

### Context window size
Logs do not contain it; live payloads do. The extension records `model id -> window` from live payloads in `windows.json` and applies it to any session on that model. For a model never seen live, no context % is shown (no guessing). Assumes all sessions of a model share one window size.

### Official extension commands used
- `claude-vscode.primaryEditor.open` with a session id opens that session; without one it starts a new session. It is also what `vscode://anthropic.claude-code/open?session=...` calls. `claude-vscode.newConversation` is not used: it only notifies an already-open chat.
- `vscode.moveViews` (undocumented) docks the panel beside Claude's secondary-sidebar chat; falls back to a message.

## Architecture

```
src/extension.ts        class ComplementerExtension: status bar, panel provider, commands, watchers, timers
src/view-model.ts       pure functions: computeMeters, computeInsights, buildPanelState, formatters (unit-tested)
src/logs.ts             parseUsageLine, iterateLineBatches, readNewRecords, History, Scanner, listLogFiles
src/breakdown.ts        createSessionTally, addEntry, readSessionTally: sizes of what fills the shown session's context (in memory, names and sizes only)
src/skills.ts           parseSkillUses, SkillHistory: per-day and per-session skill call counts in skills.json (own file and offsets)
src/chats.ts            ChatIndex, renderTranscript, getSessionPaths
src/live.ts             parsePayload, pickSessions, isWithin, effectiveLimit, LiveFeed, parseAccount, readAccount
src/setup.ts            planEnable, enableStatusLine, disableStatusLine
src/uninstall.ts        vscode:uninstall script: restores the user's statusLine
src/types.ts            every shared interface and type alias
src/consts.ts           every module-level constant
src/utils.ts            non-throwing async helpers (tryReadText, tryParseJson, ...) and small pure functions
src/hook.sh, hook.ts    statusLine passthrough: POSIX sh (macOS/Linux) and Node (Windows), same contract
src/views/              panel.html (template), panel.css, panel.ts (browser script),
                        tsconfig.json (DOM types from @types/vscode-webview)
```

`parseUsageLine` is the only place that knows the log format; `parsePayload` the only place that knows the payload; the panel only receives a prepared `PanelState` object. `view-model.ts` decides everything the user sees and imports nothing from VS Code, so it is covered by plain unit tests.

## Data flow

1. `Scanner` stats each log and opens only those that grew. It reads only newly appended bytes (stored offsets) through `iterateLineBatches`, an async generator yielding the complete lines of each 1 MB chunk (also used by the chat index). Lines are rejected on raw bytes before decoding, and only usage lines are `JSON.parse`d.
2. `History.addRecord` folds records into `day -> project -> model` totals with the repeated-block rule above.
3. `History` saves one `history.json` atomically (temp file + rename); saves are queued one after another so two writers never share the temporary file. Totals and per-file offsets share the file so a crash can never leave them out of step (which would double count).
4. `ChatIndex` re-indexes only logs whose size or modification time changed, throttled (the active chat's log grows constantly): every 5 s, or every 30 s while a recently written log is over 50 MB, because re-indexing reads the whole file (about 1 ms per MB). It keeps title, working directory, modification time, and the last main-thread usage (tokens, model) per chat. Nothing from it is persisted.
5. `LiveFeed` watches `<storage>/live/<sessionId>.json` (one file per session, so concurrent sessions never overwrite each other) and the extension learns window sizes from it.
6. `computeMeters` / `buildPanelState` run once per refresh. The panel is only updated while visible and only when its serialized state changed, so idle ticks cause no re-render. A 30 s clock tick keeps countdowns and staleness current; the 60 s poll is a fallback (live files are only re-read if watching is unavailable). `deactivate` awaits the final history save.

## Storage

In the extension's `globalStorageUri`:
- `history.json` (version 2): `{version, days: {day: {workingDirectory: {modelId: {inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens, responseCount}}}}, fileStates: {logPath: {offset, lastResponse: {messageId, day, workingDirectory, modelId, ...tokens}}}}`. Tokens only; no prompts or content. Version 1 files (terse keys `in/cc/cr/out/n`, `files`) are migrated on load.
- `windows.json`: `{modelId: windowSize}`.
- `live/<sessionId>.json`: latest status payload per session; files older than 7 days are deleted.
- `hook.sh` / `hook.js`, `original-command`, `statusline-backup.json`: the live-meter chain and the exact backup used to restore it. The backup reader accepts both the current key (`hadStatusLine`) and the one older versions wrote (`had`). The installed hook copy is refreshed at startup when live meters are on.

## Deleting a session

Hover **Delete** on a chat row (or **✕** for a permanent delete, see below). After a modal confirmation (with an extra warning if the session was modified in the last 5 minutes) the extension moves everything Claude Code keeps for that session to the Trash via `workspace.fs.delete({useTrash: true})`, so it is recoverable and the session also vanishes from the official session list:
`projects/<project>/<id>.jsonl`, `projects/<project>/<id>/` (subagent logs, tool results), `file-history/<id>/`, `session-env/<id>/`, `debug/<id>.txt`, `security/security_warnings_state_<id>.json` and `.lock`.
If the Trash is unavailable it asks before deleting permanently. A separate ✕ icon button on the row skips the Trash: it has its own modal ("Delete permanently", "This cannot be undone") and the same path checks; the Trash answer never confirms it. Safety: `getSessionPaths` returns nothing unless the id is a UUID and the log sits inside `~/.claude/projects` with a matching file name, so a crafted id cannot point elsewhere. Our own copies are cleared too (its live file and the pin). The read offsets of its logs are deliberately kept: if the log is restored from the Trash it is already at its end and is not counted a second time. Usage totals are kept as well: they are anonymous per-day aggregates with no link to the session, and they record real consumption.

## Live feed (enable / disable)

- **Enable** shows a short dialog ("Turn on live meters?") with a **Show details** button revealing the file, setting and exact before/after command. Nothing is edited without consent.
- It copies the hook into storage, saves the previous `statusLine` for exact restore, and sets `statusLine.command` to run the hook, which passes the user's original command through with the same stdin.
- `hook.sh` extracts `session_id` with shell builtins only (about two process spawns on the hot path), runs the original command with `eval` in the same shell, writes the payload atomically, and only accepts ids of `[A-Za-z0-9_-]`.
- `hook.js` (Windows) does the same in Node, fully async. `enable` refuses if `node` is not on `PATH`, so a missing runtime cannot break the user's status line.
- **Disable** restores the saved value exactly, or deletes the key if there was none. If the backup file is missing or unreadable, it falls back to `original-command`.
- **Uninstall:** `package.json` has a `vscode:uninstall` script (`src/uninstall.ts`) that finds this extension's hook in `settings.json` and runs the same restore (only when the hook's storage folder is named after this extension's own `publisher.name`; another install's hook is left alone), so the user's status line is not left chained through a hook nobody maintains.
- **Usage query (primary source of limits):** `src/usage.ts` starts the `claude` binary inside the official extension (`resources/native-binary/claude`) with `--input-format stream-json --output-format stream-json --verbose --setting-sources local --strict-mcp-config` and sends `{type:'control_request', request_id, request:{subtype:'get_usage'}}`. The reply carries `rate_limits.five_hour/seven_day` with `utilization` (0-100) and ISO `resets_at`. Measured on 2.1.296: about 0.7 s, no message sent, no session log, no hooks or MCP servers started. It runs at startup, every 5 minutes (under the 10-minute stale limit), and whenever the session logs change, at most once a minute and is stored as a payload with no folder, so it feeds limits only. The request is undocumented (the official extension labels it `EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`; the documented route is the statusLine payload), so any failure leaves the data to age into stale and the ↻ button still refreshes through a terminal. No Anthropic public API covers plan windows: the Admin usage/cost and Claude Code analytics APIs need an organization admin key and report API usage, not 5-hour/weekly subscription windows.
- **Known limit (statusLine route):** Claude Code runs `statusLine` only in interactive terminal sessions. The VS Code chat panel runs it as `--output-format stream-json` and never calls it (checked on 2.1.296: the hook stayed silent until a terminal `claude` session sent a message; the hook itself works). Limits are account-wide, so one terminal session refreshes them for every session. While live is on but no payload has arrived, the panel note says so. **Refresh** (`complementer.refreshLimits`, a ↻ icon at the right of the Usage heading; there is no separate Activate button) turns live meters on if needed, opens a terminal in the followed session's folder and runs `claude --resume <session id>`, so the terminal's payload also feeds the Context meter and breakdown bar (the chat panel never reports them). If that chat changed in the last minute it asks first (it may be open in the chat panel); only one refresh runs at a time; and only a payload written after the refresh started counts, since a resumed session keeps older payloads for days. With no followed session it starts `claude --session-id <new uuid>` in the first workspace folder (home if none); that helper is never the session the panel follows (`ignoredSessionIds`). It no longer tries the usage query first; the query only runs on its timer. Measured on 2.1.296: the startup payload has the window size but no `rate_limits` and `used_percentage: null`; limits arrive only after the first reply. So once a payload newer than the click appears (the screen is up), it sends `hi`, waits up to 30 s for a payload with a 5-hour limit, then sends `/exit` and closes the terminal. This costs a few tokens and adds one short message to the resumed session. It never answers a trust prompt: on timeout the terminal stays open and a notice explains what to do. `claude -p` (print mode) was tried and does not write a payload.
- A payload older than 10 minutes is shown greyed and stale; a window whose `resets_at` has passed shows as reset.

## Webview

The panel is real files (`src/views/panel.html`, `panel.css`, `panel.ts`, compiled to `out/`) loaded through `webview.asWebviewUri` with `localResourceRoots` limited to `src/views`. The CSP is `default-src 'none'; style-src <cspSource>; script-src 'nonce-...'`: no inline styles or scripts, so styling uses classes and `style.setProperty`. All data is drawn with `textContent` and DOM calls (chat titles come from log files and are untrusted). `renderPanelHtml` (in `view-model.ts`) only fills `{{nonce}}`, `{{cspSource}}`, `{{styleUri}}` and `{{scriptUri}}`. Because the script is a real file, ESLint (browser globals) and a DOM-aware `tsc` project checks it.

## Error handling

- Malformed or truncated log lines are skipped; a partial trailing line waits for the next read.
- Missing logs directory: the panel says no chats found; no popups.
- Corrupt `history.json` is set aside as `.bad` and a fresh one is started (offsets go with it, so surviving logs are rescanned).
- Missing `rate_limits` or any other payload field: that part is hidden, never an error.
- Official extension missing: New session / open chat show a short message.

## Code conventions

Enforced by ESLint and `tsc` and described in `/CLAUDE.md`: descriptive names (no one- or two-letter identifiers), `const` over `let`, no synchronous file or process calls, types in TypeScript with shared shapes in `src/types.ts` and constants in `src/consts.ts`, persisted shapes fully spelled out with migrations when they change.

## Testing

69 tests (`npm test`), ESLint (`npm run lint`), and strict `tsc` over two projects (`npm run check`: `src` + `test`, and the webview script), all run before packaging.
- Unit: parser and repeated-block rule, incremental reads and truncation, history save/load and the version 1 migration, corrupt-file recovery, chat index, transcript, session path safety, payload parsing, path matching (including Windows rules), account parsing, the view model (meter selection, unknown window sizes, insights, streak, panel state), enable/disable round trips and both hooks run for real.
- Webview: the compiled `panel.js` runs against a fake DOM built from the real `panel.html` (levels, rows, messages, empty states).
- Integration: the compiled `extension.js` runs against a stubbed `vscode` and a fake home (panel state, learned windows, account, pinning, official commands, the full delete flow including declining and an unknown id).

**Not yet verified:** a real VS Code run of the final UI, Linux, Windows, and New session / open-chat on a real install.

## Measured

On 196 logs (about 140 MB): first scan about 120 ms, rescan with nothing new under 3 ms (unchanged logs are stat-ed, never opened), chat index 60-100 ms, about 80 MB RSS, history file under 100 KB. Totals match an independent recount exactly (5,473 responses, 3,835,824 output tokens, 760,399,539 cache-read tokens). Per-session tokens match the live payload (87,455 = 87,455).

## Risks

| Risk | Mitigation |
|---|---|
| Log format or payload changes | Isolated in `parseUsageLine` / `parsePayload`; tolerant, optional fields; fixtures |
| Editing `settings.json` breaks the user's status line | Consent dialog, chained passthrough, exact-restore Disable, node check on Windows, tests |
| Official command names change | Calls are wrapped; failure shows a message |
| `vscode.moveViews` disappears | Falls back to manual drag instructions |
| Stale live data | Per-session files, staleness label, `resets_at` handling |
| Sessions from another project do not resume in this workspace | Documented; unverified |
| A delete removes something it should not | UUID + path validation in `getSessionPaths`, confirmation, Trash, tests with a fake home |
| Name and trademark | Renamed to "Complementer" (no Anthropic mark in the name); "Claude Code" appears only as plain text; README states it is independent; no Anthropic logo |
| Publishing | Publisher is `pritompurkayasta`; changing it again changes the extension ID and orphans stored data and the hook path in `settings.json`. Early `local.` builds must be disabled and removed first |

## Rejected ideas (and why)

- **Calling an undocumented OAuth endpoint for plan limits:** replaced by the statusLine payload (no credentials, no network).
- **Patching the official extension's webview to embed meters in its input bar:** unsupported, overwritten by every update, and its panel blocks data from outside. Not built.
- **Pricing table and cost estimates:** dropped; prices change and could not be verified for new models.
- **Guessing context window sizes:** removed; wrong guesses (44% shown for a real 9%) are worse than showing nothing.
- **Monthly history files / SQLite:** one small atomic file is enough (under 100 KB for 196 logs).
- **HTML inside a JS template string:** replaced by real files under `src/views/` so tooling can see the webview code.
