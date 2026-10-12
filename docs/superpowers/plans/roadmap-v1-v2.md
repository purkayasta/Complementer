# Complementer: Roadmap v1 and v2

Companion to `../specs/complementer-design.md`, which describes what is built. v1 and v2 are two milestones that ship together as one release, **1.0.0 (stable)**. Both are built; what is left is the manual checks below and publishing. Nothing is planned after 1.0.0 yet.

## v1: Live meters, session manager, insights (built)

**Outcome:** from the first message, the status bar and a Sessions panel show context %, 5-hour % and weekly %, per session where that applies, with a session manager and local usage insights.

| # | Task | Status |
|---|---|---|
| 1 | Scaffold: TypeScript (strict, compiled to `out/`), ESLint, `node --test` | Done |
| 2 | Log parser with the repeated-block rule (largest `output_tokens` per `message.id`) | Done |
| 3 | Incremental scanner: stored offsets, byte-level pre-filter, stat-only rescans, watcher + poll | Done |
| 4 | Live feed: `hook.sh` / `hook.js`, enable/disable with consent and exact restore | Done |
| 5 | History + atomic store (`history.json`, tokens only), with a migration from the first layout | Done |
| 6 | Status bar (warning above 50%, error from 80%) | Done |
| 7 | Sessions panel: usage bars with reset countdowns, New Chat, searchable chat list with per-chat context % | Done |
| 8 | Per-session selection: click opens the chat in the official Claude Code view and the bars follow it | Done |
| 9 | Learned context window sizes per model; no percentage shown when unknown | Done |
| 10 | Chat history browser (titles from `ai-title`, read-only transcript), grouped by project: the workspace's project and "Ungrouped" (new sessions with no folder yet) open, the rest collapsed | Done |
| 11 | Account section: email, plan tier, organization (from the cached profile) | Done |
| 12 | Delete a session (to the Trash by default, or permanently with the ✕ button, everywhere Claude Code keeps it), with path safety | Done |
| 13 | Insights: tiles, 60-day heatmap, top projects, model mix, streak, 1/7/30-day switch | Done |
| 14 | Panel as real files under `src/views/` (HTML, CSS, script) with a strict CSP; linted and type-checked | Done |
| 15 | Code quality pass: descriptive names, `const`-first, no sync I/O, types in `src/types.ts`, constants in `src/consts.ts`, pure `view-model.ts`, class-based `extension.ts`, ESLint enforced | Done |
| 16 | New icon (spark inside a gauge), packaging into `release/`, README, `CLAUDE.md`, MIT license | Done |
| 17 | Permanent delete (✕ button, own confirmation); restored logs are not recounted; uninstall restores the user's status line | Done |
| 18 | Chat index slows to every 30 s while a recently written log is over 50 MB; account file parsed only when it changes; saves queued | Done |
| 19 | README (with screenshots in `media/`) reduced to what the extension adds; `CONTRIBUTING.md` and `CHANGELOG.md` added (Marketplace shows README and CHANGELOG from the package) | Done |
| 20 | Migration to TypeScript; live meters read as off when the hook is not in `statusLine`; hardened delete and setup races | Done |
| - | Pricing and cost estimates | Dropped (see spec, "Rejected ideas") |

**Verification so far:** 69 tests (unit, webview against a fake DOM, extension against a stubbed `vscode` and a fake home), lint, strict `tsc` over two projects, an independent recount of token totals, and real-data smoke runs.

**Verified by hand on macOS** (real VS Code): the UI, live meters (enable, disable, uninstall restoring `statusLine`).

**Not yet verified** (do before publishing 1.0.0):
- Linux, and Windows (`hook.js`, path matching): unit-tested on macOS only.
- Whether sessions from another project folder resume properly in the current workspace.

## v2: What is eating my context

**Outcome:** a section that breaks the context window into parts, like `/context` but always visible, for the selected session.

**Spike result (one real session, 107 assistant records):**
- Logs have no category labels, so the fixed part (system prompt, tools, MCP, memory, skills) cannot be split exactly. It can only be shown as one "fixed baseline": total context at the first response (35,154 tokens in the sample).
- Derivable: growth since the baseline (127,390 − 35,154 there), split by record kind: tool results (largest after assistant output), assistant text and thinking, user text, and attachments (`skill_listing`, `prompt_snapshot`, `edited_text_file`, `hook_success`, ...), plus per-tool-name sizes.
- Method: measure each kind's size in characters and scale so the parts sum exactly to the measured growth. The total is exact; the split is labelled as an estimate.
- Decision: ship "baseline + growth split by kind and tool", not a fake system-prompt breakdown.

| # | Task | Done when | Status |
|---|---|---|---|
| 1 | A `breakdown` module over the session log (reads via `iterateLineBatches`; pure computation in the view model), with tests on fixtures | Parts sum to the measured context within a stated tolerance | Done |
| 2 | Breakdown inside Usage for the selected session: a full-width stacked bar under the Context meter (colour-keyed legend; token counts rounded, one decimal for k/M/B), with the list and top items under a collapsed "Details" | Matches `/context` for a manual check in a real session | Built; manual check against `/context` still to do |
| 3 | Top offenders: largest tool results and files read, with the turn they came from | Each item shows size and turn | Done |

Skills used (per session, in Details) and Top skills (Insights) were added to v2; see `../specs/2026-10-11-context-breakdown-and-skills-design.md`.

**Risk:** the split can only be approximate. If it proves too noisy, ship fewer, honest categories.

## Release 1.0.0

v1 and v2 are published together as `1.0.0`; `package.json` and `CHANGELOG.md` say so.

**Before publishing:**
- Publisher ID is decided: `pritompurkayasta` (extension ID `pritompurkayasta.complementer`).
- Decide between the Marketplace and `.vsix` files on GitHub releases (packages are build output and are never committed). One `README.md` serves both GitHub and the Marketplace page, so keep it plain: `vsce` rejects SVG images and rewrites relative links (including `media/*.png`, which is not packaged) using `repository` in `package.json`, so the images must be pushed to GitHub.
- Create the GitHub repository (named `complementer`; `repository`, `homepage` and `bugs` in `package.json` already point at `github.com/purkayasta/complementer`).

**Still to verify by hand before publishing:** the v1 items under "Not yet verified" above, and the v2 breakdown against `/context` in a real session.

## Cross-cutting rules

- Nothing leaves the machine. No telemetry.
- Every external format (log, payload, official commands) is parsed or called in one place and treated as optional.
- Show only what can be read. No guessing and no fake precision.
- Persisted shapes change only with a migration and a test.
- New behaviour goes into `view-model.ts` (pure, tested) before it goes into `extension.ts`.
- Each milestone ends with a manual check against `/context` and `/usage` in a real session.
- Do not start a milestone before the previous one's exit criteria hold.
