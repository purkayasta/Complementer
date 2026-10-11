// Runs from the "vscode:uninstall" script (plain node, once VS Code removes the extension): puts the user's own
// statusLine back, so settings.json is not left pointing at a hook nobody maintains.
import os from 'node:os';
import path from 'node:path';
import { disableStatusLine, parseHookCommand } from './setup';
import { tryReadText, tryParseJson } from './utils';

/**
 * The storage directory is the hook's last argument: `sh '<dir>/hook.sh' '<dir>'` or `node "<dir>\\hook.js" "<dir>"`.
 * @param command A statusLine.command from settings.json.
 * @returns undefined unless the command is one of this extension's hook commands
 */
export const findStorageDirectory = (command: unknown): string | undefined => parseHookCommand(command)?.storageDirectory;

export async function main(homeDirectory = os.homedir()) {
  const settingsPath = path.join(homeDirectory, '.claude', 'settings.json');
  const settings = tryParseJson((await tryReadText(settingsPath)) ?? '');
  const storageDirectory = findStorageDirectory(settings?.statusLine?.command);
  if (storageDirectory) await disableStatusLine({ settingsPath, storageDirectory });
}

if (require.main === module) main().catch(() => {}); // uninstalling must never fail because of us
