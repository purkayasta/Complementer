# Deployment

How to build, install locally, and publish Complementer. Publisher ID: `pritompurkayasta` (extension ID `pritompurkayasta.complementer`).

## 1. Prepare the release

1. Bump `version` in `package.json` (and `package-lock.json`): `npm version <patch|minor|major> --no-git-tag-version`.
2. Add the new version's section to `CHANGELOG.md` (the Marketplace shows it).
3. Update `README.md`, the spec and the roadmap if behaviour changed.
4. Commit (Conventional Commits, e.g. `chore: release 1.0.1`).

## 2. Build the package

```
npm ci
npm run package      # lint + check + tests, then release/complementer-<version>.vsix
```

`npm run package` stops at the first failure. `release/` and `*.vsix` are git-ignored; never commit them.

## 3. Test the package locally

```
code --install-extension release/complementer-<version>.vsix --force
```

Then run **Developer: Reload Window**. Check the Sessions panel and the status bar in a real VS Code window before publishing. A real-VS-Code run, Linux and Windows have not been verified yet.

## 4. Publish to the VS Code Marketplace

Shortcut (after the one-time setup below): `npm run deploy` packages first (lint, check, tests, build) and then publishes the `.vsix` it just built. It uses POSIX shell syntax (macOS/Linux); on Windows use the manual commands.

One-time setup:

1. Create the publisher `pritompurkayasta` at https://marketplace.visualstudio.com/manage.
2. Create a Personal Access Token in Azure DevOps (organization: **All accessible organizations**, scope: **Marketplace → Manage**).

```
npx --yes @vscode/vsce@4.0.0 login pritompurkayasta     # paste the token
npx --yes @vscode/vsce@4.0.0 publish --no-dependencies  # publishes package.json's version
```

Or publish the file you already tested:

```
npx --yes @vscode/vsce@4.0.0 publish --packagePath release/complementer-<version>.vsix
```

`vsce` rewrites relative links in `README.md` using `repository` in `package.json`, so images under `media/` must be pushed to GitHub first, and SVG images are rejected.

## 5. Optional: Open VSX (VSCodium, Cursor and others)

```
npx --yes ovsx publish release/complementer-<version>.vsix -p <open-vsx-token>
```

## 6. Tag and GitHub release

```
git tag v<version>
git push origin main --tags
gh release create v<version> release/complementer-<version>.vsix --title "v<version>" --notes-file CHANGELOG.md
```

Attaching the `.vsix` lets people install without the Marketplace: `code --install-extension complementer-<version>.vsix`.

## Rolling back

The Marketplace cannot republish the same version. Fix forward with a new patch version, or unpublish from https://marketplace.visualstudio.com/manage (or `npx @vscode/vsce unpublish pritompurkayasta.complementer`).

## Notes

- The extension has no runtime dependencies, so `--no-dependencies` is correct.
- The `.vsix` ships `out/src` only; `vscode:prepublish` runs `npm run build` automatically on `publish`.
- Uninstalling runs `out/src/uninstall.js`, which restores the user's original `statusLine`; do not change that without a migration.
