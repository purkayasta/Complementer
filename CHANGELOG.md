# Changelog

## 1.1.0

- Usage meters in the Sessions panel are now ordered 5-hour, weekly, then context, so the long context block comes last.
- Context breakdown: the legend under the bar has a colour dot per entry, matching the bar. "Biggest items" is now "Biggest tool outputs" and shows a file name or the command instead of the full path (full text on hover).
- Token counts in the breakdown are rounded (no more `~116.793500892326`); k/M/B values keep one decimal.
- Smaller text in the breakdown details.
- Each chat in the list shows its top two skills ("skills ×N"). Counts are now saved per session in skills.json (version 2); an existing file keeps its day counts and is backfilled once.
- The ↻ Refresh icon (Usage heading) resumes the followed session in a terminal (`claude --resume <id>`), sends "hi", then exits, so the context meter and limits update; with no session it starts a fresh one. It asks first if the chat changed in the last minute, and ignores a second click while running.
- Plan limits (5-hour, weekly) now appear without a terminal: the extension asks the installed Claude Code for them, as the official panel does, every 5 minutes and after new messages, at most once a minute (no message sent). The ↻ next to the Usage heading refreshes them on demand through a short terminal session (see above).
- Live meters: the panel says when it is still waiting for data and explains that only Claude Code terminal sessions report limits (the chat panel does not run the status line). The enable dialog and README say the same. The command **Complementer: Refresh limits** does the same as the ↻.

## 1.0.0

First stable release.

- Status bar and Sessions panel with context, 5-hour and weekly meters (yellow above 50%, red from 80%).
- Session manager: chats grouped by project, each with its context %. Search, open, read as a transcript, delete (to the Trash or permanently), new session.
- Context breakdown: a full-width stacked bar under the Context meter shows what the used context is made of: the fixed baseline and what the session added (tool results, tool calls, assistant text, your messages, attachments). "Details" lists the biggest items and the skills used in that session. The split is an estimate.
- Insights: tokens, cache hit rate, 13-week heatmap, top projects, top skills (from the logs still on disk), model mix and streak, for 7, 30 and 90 days.
- Live meters through the Claude Code status line: asks first, locked against two windows editing at once, restored exactly on disable or uninstall. Uninstalling one of two copies leaves the other's live meters alone.
