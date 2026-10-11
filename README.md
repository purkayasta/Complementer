# Complementer

Shows what Claude Code does not: how full your context is, how much of your 5-hour and weekly limits you have used, and a place to manage your sessions.

Independent project, not affiliated with Anthropic.

<p align="center">
  <img src="media/usage.png" alt="5-hour and weekly usage meters with reset countdowns, above the New session button" width="340">
  &nbsp;&nbsp;
  <img src="media/insights.png" alt="Insights: token tiles and a 13-week usage heatmap" width="340">
</p>

## Features

- **Usage meters.** Context, 5-hour and weekly limits in the status bar and the Sessions panel, with reset countdowns. Yellow above 50%, red from 80%.
- **Session manager.** Chats grouped by project, each with its own context %. Search, open, read as a transcript, or delete (to the Trash, or permanently with ✕). Start a new session in one click.
- **Insights.** Over 7, 30 or 90 days: tokens, cache hit rate, active days, a 13-week heatmap, top projects, top skills, model mix and streak.
- **Context breakdown.** Under the Context meter: a full-width bar of what the used context is made of (fixed baseline, tool results, assistant text, your messages) and, under Details, the biggest items and the skills used in that session. The split is an estimate.
- **Account.** Your email, plan and organization.

## Getting started

1. Install the extension. It requires the Claude Code extension.
2. Open the Complementer icon in the activity bar.
3. Run **Complementer: Enable live meters** to show the 5-hour and weekly limits.

Context % and the session list work without step 3.

## Live meters

Plan limits are only available through Claude Code's status line. Enabling live meters adds a small passthrough in front of it. The extension asks first, shows the exact change, and keeps your own status line working. **Disable live meters**, or uninstalling, restores your settings exactly. With two copies installed, removing one leaves the other's live meters alone.

## Commands

| Command | Action |
|---|---|
| Complementer: Enable live meters | Show the 5-hour and weekly limits (asks first) |
| Complementer: Disable live meters | Restore your original status line |
| Complementer: New Claude session | Start a new chat |
| Complementer: Dock panel beside Claude chat | Move the panel next to the Claude chat |

## Privacy

Everything stays on your machine. There are no network calls and no telemetry. The extension reads your Claude Code session logs, the status-line data, and your email, plan and organization from `~/.claude.json`. It stores only daily token totals and daily skill counts, never chat content.

## Requirements

VS Code 1.85 or newer and the Claude Code extension. Node.js is not needed on macOS and Linux. On Windows, live meters need `node` on your PATH; enabling them stops with a message if it is missing. Tested on macOS only; Linux and Windows are untested.

## Contributing

Contributions are welcome. Open an issue first, and send a pull request once a maintainer confirms it. See [CONTRIBUTING.md](CONTRIBUTING.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE). If the extension is useful to you, please star it on [GitHub](https://github.com/purkayasta/complementer).
