// Runs from the "vscode:uninstall" script (plain node, once VS Code removes the extension): puts the user's own
// statusLine back, so settings.json is not left pointing at a hook nobody maintains.
import os from 'node:os';
import path from 'node:path';
import { disableStatusLine, parseHookCommand } from './setup';
import { tryReadText, tryParseJson } from './utils';

/**
 * The storage directory is the hook's last argument: `sh '<dir>/hook.sh' '<dir>'` (older versions; newer ones wrap it in `if [ -f ... ]; then ...; fi`) or `node "<dir>\\hook.js" "<dir>"`.
 * @param command A statusLine.command from settings.json.
 * @returns undefined unless the command is one of this extension's hook commands
 */
export const findStorageDirectory = (command: unknown): string | undefined => parseHookCommand(command)?.storageDirectory;

/** This extension's `publisher.name`, which is also the name of its storage folder. Read from package.json, two levels up from out/src. */
async function readOwnExtensionId(): Promise<string | undefined> {
  const manifest = tryParseJson((await tryReadText(path.join(__dirname, '..', '..', 'package.json'))) ?? '');
  return manifest?.publisher && manifest?.name ? `${manifest.publisher}.${manifest.name}` : undefined;
}

/**
 * @param extensionId Only a hook stored under this id's storage folder is restored: another install's hook (an old
 *   name, a dev copy) is not ours to undo. With no id, nothing is touched.
 */
export async function main(homeDirectory = os.homedir(), extensionId?: string) {
  const ownId = extensionId ?? (await readOwnExtensionId());
  const settingsPath = path.join(homeDirectory, '.claude', 'settings.json');
  const settings = tryParseJson((await tryReadText(settingsPath)) ?? '');
  const storageDirectory = findStorageDirectory(settings?.statusLine?.command);
  const isOwnHook = storageDirectory && ownId && path.basename(storageDirectory).toLowerCase() === ownId.toLowerCase();
  if (isOwnHook) await disableStatusLine({ settingsPath, storageDirectory });
}

if (require.main === module) main().catch(() => {}); // uninstalling must never fail because of us
