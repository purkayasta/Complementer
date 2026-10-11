# Context breakdown and skill usage (v2)

Status: draft for review. Companion to `complementer-design.md` (what is built) and `../plans/roadmap-v1-v2.md` (v2 task list).

## Goal

Show what is bloating the selected session's context so the user can avoid re-reading big things or decide when to `/compact`, and show which skills are used most, per session and across all sessions. Everything is derived from local logs; nothing is sent anywhere.

## Decisions already made

- **Placement:** inside the Usage section of the Sessions panel (no new section). One stacked bar under the Context meter, a one-line legend, and a collapsed-by-default "Details" toggle. Details holds category sizes (with per-tool subtotals), "Biggest items" and "Skills used". Mockups: `.superpowers`-style screens `usage-breakdown.html` and `usage-breakdown-v2.html` (brainstorm session, not committed).
- **Purpose:** spot what is bloating the context (so top offenders are in scope).
- **Skills:** session list in Details, plus a "Top skills" list in Insights that follows the 7/30/90-day switch.
- **Skills backfill:** a separate `skills.json` with its own offsets, filled once from the logs still on disk. The token history file is not touched.

## Facts the design rests on

- Logs have no category labels, so the fixed part (system prompt, tools, MCP, memory, skills) cannot be split: it is shown as one **baseline**, the total context at the first response.
- Total context at a response is `input + cache_read + cache_creation` of its usage, the number the context meter already uses.
- A skill call is an assistant `tool_use` block named `Skill` with `input.skill`. Typed `/name` commands are logged as `<command-name>` text and cannot be told apart from built-ins (`/clear`, `/model`), so **only Skill tool calls are counted**.
- One API response is logged once per content block, so a `Skill` tool_use block is its own line and is counted once; offsets keep a re-read from counting it twice.
- **Not verified:** how a compaction appears in a real log (the sample logs contain none). The breakdown does not look for a compaction marker: when a response's context is smaller than the previous one's (a compaction or a rewind), the sizes are dropped and the baseline restarts at that response; skills and turns are kept.

## Components

### `src/breakdown.ts` (new, I/O)
Reads the selected session's log through `iterateLineBatches` and keeps running **sizes in characters** per kind: tool calls (the arguments the assistant sent), tool results (by tool name), assistant text, assistant thinking, user text, attachments (by attachment type). Also keeps:
- the latest response's total context and the first response's total (baseline),
- the top N tool results as `{ tool, target, chars, turn }` (target = file path or command, truncated),
- per-skill call counts for the session.

It stores sizes and names only, never message text. An in-memory cache keyed by log path holds `{ offset, running totals }`; when the log grows only the new bytes are read, and selecting another session replaces the cache. Nothing is persisted for this part. Reads are async and batched.

### `view-model.ts` (pure, tested)
`computeBreakdown(running, windowSize)`:
- growth = latest total − baseline total; each kind's characters are scaled so the parts sum exactly to the growth. Baseline and total are exact; the split is an estimate.
- Returns `undefined` when the window size is unknown, there is a single response, or growth is not positive (never guess).
- Takes the top offenders and top 5 skills, sorted.
`buildPanelState` gains an optional `breakdown` and, in `insights`, an optional `topSkills` per range.

### `src/skills.ts` (new, I/O) and `skills.json`
A small scanner, same pattern as `Scanner`/`History` but its own file:
```
skills.json: { version: 1, days: { "YYYY-MM-DD": { "<skill>": count } }, fileStates: { "<log path>": { offset } } }
```
- Pre-filter on the raw bytes (`"name":"Skill"`) before any JSON parsing, so the one-time pass over existing logs is cheap.
- Written atomically like `history.json`. A missing, unreadable or wrong-version file is moved to `.bad` and rebuilt from the logs on disk.
- Deleting a session keeps its counts (like token totals); only logs deleted before the first pass are missed, and Insights says "from available logs".
- `computeInsights` sums days for the 7/30/90-day ranges and returns the top 5.
- This is a new persisted shape, so it ships with a test for load, save, wrong version and re-scan.

### Panel (`panel.html`, `panel.css`, `panel.ts`)
- Under the Context meter: one full-width stacked bar of what the used context is made of (the Context meter above shows how full the window is), legend of the three largest parts, "▸ Details".
- Details (collapsed by default; the choice lives in the webview state): category rows with per-tool subtotals, "Biggest items", "Skills used" (name, bar, "×N uses"). Hidden when empty. A line says "Baseline and total are exact. The split is an estimate."
- Insights: a "Top skills" list next to Top projects and Model mix.
- Rendered with DOM calls and `textContent` only (tool names, paths and skill names come from log files). Colours via classes or `style.setProperty`; no inline styles (CSP).

### Wiring (`extension.ts`)
Recompute the breakdown when the selected session changes or its log grows, debounced like the existing refresh. Run the skills scan with the existing scanner cycle. No new timers beyond that.

## Testing

- `breakdown`: parts sum to the growth; repeated-block rule; single response; unknown window size; truncation of targets; skill counting from `Skill` tool_use blocks only.
- `skills`: backfill from fixture logs, incremental scan from stored offsets, load/save atomicity, wrong version, deleted log keeps its counts.
- `view-model`: top-N ordering, empty cases, range sums.
- Panel script against the fake DOM: collapsed by default, toggle, empty states, no HTML injection of names.
- Manual: compare the breakdown with `/context` in a real session (required before release; not done by tests).

## Out of scope

Tokens per skill, per-skill cost, a pricing table, typed-slash-command counting, a second sidebar view, persisting breakdowns, exporting.

## Risks

- The split is approximate; if it proves noisy, ship fewer honest categories.
- Thinking text is empty in the logs sampled (only a signature is stored), so "Thinking" is usually zero and its tokens land in the other parts. The estimate label says so.
- Very large logs: the in-memory incremental read must stay cheap (checked against the 50 MB case).
