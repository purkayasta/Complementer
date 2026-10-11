# Changelog

## 1.0.0

First stable release.

- Status bar and Sessions panel with context, 5-hour and weekly meters (yellow above 50%, red from 80%).
- Session manager: chats grouped by project, each with its context %. Search, open, read as a transcript, delete (to the Trash or permanently), new session.
- Context breakdown: a full-width stacked bar under the Context meter shows what the used context is made of: the fixed baseline and what the session added (tool results, tool calls, assistant text, your messages, attachments). "Details" lists the biggest items and the skills used in that session. The split is an estimate.
- Insights: tokens, cache hit rate, 13-week heatmap, top projects, top skills (from the logs still on disk), model mix and streak, for 7, 30 and 90 days.
- Live meters through the Claude Code status line: asks first, locked against two windows editing at once, restored exactly on disable or uninstall. Uninstalling one of two copies leaves the other's live meters alone.
