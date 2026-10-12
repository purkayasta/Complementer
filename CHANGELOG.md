# Changelog

## 1.2.0

- Each chat row shows its session cost when Claude Code has reported one for it (the same figure as the Usage section, no estimate). The highest cost reported per session is saved in `session-costs.json` (cost only, no chat content; removed when the chat is deleted), so a row keeps it after the live file is gone. Chats that never reported live show none.
- Insights ranges are now 1, 7 and 30 days (1 by default); 90 days is gone. The heatmap shows the last 60 days, and daily totals older than 60 days are no longer kept. A saved 90-day choice falls back to 1.
- The Account block is compact (10px). The chat list is about five rows tall and scrolls, and the "Active" filter is on by default (turn it off to see every chat; the choice is remembered).
- Removed "Biggest tool outputs" from the breakdown details (not useful enough); the per-part and per-tool sizes and the skills used stay.
- A new chat is followed as soon as it appears (before, the panel kept showing the previous session's context and limits until you picked the new one), so Refresh resumes the new chat, not an old one.
- New chats load their meters by themselves: once a chat that appeared after startup has been quiet for 10 seconds, the extension offers to resume it once in a terminal (sends "hi", then exits). The setting `complementer.autoActivateNewChats` is `ask` (default, a notification with a Load button) or `off`; there is no silent mode, because resuming adds a message to a chat that is usually open in the chat panel. Either way, the panel says when the followed chat has no live data yet and points to ↻.
- The New session button is now New Chat (the command is "Complementer: New Chat", id `complementer.newChat`). Its colour, and the colours of the meters, breakdown bar, model mix, heatmap and bar rows, are random each time the panel loads, always readable: white text on the button, and visible on light and dark themes. Warning (yellow) and danger (red) colours stay fixed.
- The Usage section no longer shows the session cost (each chat row already does).
- Insights no longer shows "Active days" (it said little); the status bar tooltip shows today's cost next to today's tokens (`--` when none was recorded) and, while live meters are off, a "Turn on live meters" link instead of plain text.
- Insights has a Cost tile for the selected range: the cost Claude Code reported live, added up per day in `day-costs.json` (amounts and dates only). It shows `--` when nothing was recorded in the range; days before this version are empty, since the cost is never estimated.
- Safer saves: the usage history, skill counts, window sizes and session costs are written through a temp file named per process, so two VS Code windows saving at once can no longer corrupt `history.json`.
- The status line hook falls back to your own command when its file is missing (settings synced to another machine, extension data cleared), so your status line is never left blank. Already-enabled setups keep their current command; turn live meters off and on again to get the fallback. Windows (the OS) has no fallback yet.
- VS Code windows share the plan-limit query through `live/usage-query.json`, so several windows start one `claude` instead of one each. The log poll runs every 5 minutes while the file watcher works (every minute without it).
- Reading a chat no longer fails on a malformed block in its log.

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
