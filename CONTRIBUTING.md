# Contributing

Contributions are welcome: bug reports, ideas, documentation, tests and code.

## Process

1. **Open an issue first.** For a bug, give the steps to reproduce, your OS and your VS Code version. For an idea, explain the problem it solves. Check existing issues for duplicates.
2. **Wait for confirmation.** A maintainer will accept the change, ask for adjustments, or explain why it does not fit. Do not start a pull request before this.
3. **Open the pull request.** Link the issue (`Closes #123`). A pull request without a confirmed issue may be closed.

Typo and small documentation fixes can skip step 1.

## Before you start

Read [CLAUDE.md](CLAUDE.md) for the code layout and conventions, and `docs/superpowers/specs/complementer-design.md` for the design. Ground rules:

- No new runtime dependencies, network calls, telemetry, or cost estimates.
- Never break a user's existing Claude Code setup, especially `statusLine` and `settings.json`.
- Async file access only. Use descriptive names. Shared types go in `src/types.ts`, constants in `src/consts.ts`.

## Setup

You need Node.js and npm.

```
npm install
npm run build    # compile to out/
npm test         # build, then run all tests
npm run lint
npm run check    # type-check: src + test, and the webview script
npm run package  # lint, check, test, then build release/*.vsix
```

Press `F5` to run the extension in a development host. To release, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Testing

Both are required for every pull request:

1. **Automated.** `npm test` must pass. Add a test for any new behaviour.
2. **Manual.** Press `F5` and try your change in the Sessions panel, status bar or commands. If you touch live meters, confirm that Enable followed by Disable leaves `statusLine` exactly as it was. Describe the steps and result in the pull request.

State anything you could not test. A real VS Code run, Linux and Windows are not yet verified.

## Pull request checklist

- [ ] An issue exists and a maintainer confirmed it
- [ ] `npm run lint`, `npm run check` and `npm test` pass
- [ ] Manual test done, with steps and result in the description
- [ ] `CHANGELOG.md` updated (and the spec or roadmap, if behaviour changed)
- [ ] Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`), imperative and lowercase, under about 72 characters
- [ ] No `.vsix`, `out/`, or files from `~/.claude` committed

Keep pull requests small and focused.
