# Changelog

## Unreleased

- Live meters: turning them on or off is now locked, so two VS Code windows cannot overwrite your status line.
- Live meters: `settings.json` keeps its permissions and symlink, and a quote in the home folder no longer blocks disable or uninstall.
- Live meters: the hook copy is replaced atomically, and a clear message appears when another copy of the extension owns your status line.
- The panel and tooltip show "Live meters are off" (click to enable) whenever the hook is not in your status line, instead of stale data.
- Context % stays visible after a "limit reached" notice.
- Delete refuses when two chats share a session id. The permanent fallback no longer fails on files already in the Trash.
- Usage totals ignore replies that another session wrote into a log.
- Documentation: new README with screenshots, contributing guide and pull request template.
- Internal: the code base is now TypeScript. Behaviour is unchanged.

## 0.1.0

- Status bar and Sessions panel with context, 5-hour and weekly meters.
- Session list grouped by project: open, read, delete (Trash or permanent), new session.
- Usage insights: tokens, heatmap, top projects, model mix, streak.
- Live meters through the Claude Code status line, restored on disable or uninstall.
