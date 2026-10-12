// Every module-level constant of the extension, in one place. (hook.ts and views/panel.ts keep their own: the first is
// copied on its own into the user's storage folder and the second runs in the browser, so neither can import this file.)
import path from 'node:path';
import type { ContentKind, TokenTotals } from './types';

// ---- Session logs ----

export const USAGE_NEEDLE = Buffer.from('"output_tokens"');
export const TOKEN_KEYS = (['inputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'outputTokens'] as const) satisfies (keyof TokenTotals)[];
export const HISTORY_VERSION = 2;
export const READ_CHUNK_BYTES = 1 << 20;
export const NEWLINE_BYTE = 10;

// ---- Breakdown and skills ----

export const SKILL_CALL_NEEDLE = Buffer.from('"name":"Skill"');
export const ATTACHMENT_NEEDLE = Buffer.from('"type":"attachment"');
export const SKILLS_VERSION = 2;
export const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/; // tool and skill names from logs: no markup, and never "__proto__"
export const TOP_TOOLS = 5;
export const TOP_SKILLS_PER_SESSION = 5;
export const TOP_SKILLS_PER_CHAT = 2;
export const CONTENT_KINDS = ['toolResults', 'toolCalls', 'assistantText', 'assistantThinking', 'userText', 'attachments'] as const satisfies ContentKind[];

// ---- Chat index ----

export const TITLE_NEEDLE = Buffer.from('"ai-title"');
export const WORKING_DIRECTORY_NEEDLE = Buffer.from('"cwd":"');
export const USER_NEEDLE = Buffer.from('"type":"user"');
export const ASSISTANT_NEEDLE = Buffer.from('"type":"assistant"');
export const SIDECHAIN_NEEDLE = Buffer.from('"isSidechain":true');
export const SYNTHETIC_NEEDLE = Buffer.from('"model":"<synthetic>"'); // Claude Code's own notices ("limit reached"), not model replies
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PROMPT_LINES_TO_TRY = 5;
export const MAX_TITLE_LENGTH = 80;
export const MAX_WORKING_DIRECTORY_BYTES = 600;

// ---- Live feed ----

export const STALE_AFTER_MS = 10 * 60 * 1000;
export const KEEP_FILES_FOR_MS = 7 * 24 * 3600 * 1000;
export const WATCH_DEBOUNCE_MS = 100;
export const USAGE_QUERY_MIN_GAP_MS = 60 * 1000; // chatting also refreshes the limits, but never more often than this
export const USAGE_QUERY_FILE = 'usage-query.json'; // in live/, so every window sees the answer one window asked for
export const LOG_POLL_EVERY_TICKS = 5; // the log watcher does the work; the poll only catches what it missed
export const USAGE_QUERY_TIMEOUT_MS = 15 * 1000;
export const USAGE_QUERY_INTERVAL_MS = 5 * 60 * 1000; // under STALE_AFTER_MS, so queried limits never read as stale
export const REFRESH_LIMITS_WAIT_MS = 30 * 1000; // how long the Refresh limits terminal waits for Claude Code's first status line
export const REFRESH_LIMITS_POLL_MS = 500;
export const REFRESH_LIMITS_CLOSE_MS = 1500;
export const REFRESH_RESUME_BUSY_MS = 60 * 1000; // a chat written to this recently may be open in the chat panel: ask before resuming it
export const NEW_CHAT_CHECK_MS = 2 * 1000; // how often queued new chats are checked for having gone quiet
export const ACTIVATE_NEW_CHAT_IDLE_MS = 10 * 1000; // a new chat quiet this long has finished its first reply: activate it once

// ---- Live-meter setup ----

export const LOCK_STALE_MS = 10_000;
export const LOCK_WAIT_MS = 3_000;
export const LOCK_RETRY_MS = 50;
export const POSIX_HOOK_COMMAND = /^(?:if \[ -f '(?:[^']|'\\'')*' \]; then )?sh '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)'(?:; else sh -c '(?:[^']|'\\'')*')?(?:; fi)?$/; // the plain form older versions wrote, and the guarded one with the user's command as fallback
export const WINDOWS_HOOK_COMMAND = /^node "([^"]+)" "([^"]+)"$/;
export const INSTALLED_HOOK_PATH = /complementer[\\/]hook\.(sh|js)$/;

// ---- View model ----

export const CHAT_INDEX_THROTTLE_MS = 5000; // re-indexing a changed log reads all of it, and the active chat's log grows constantly
export const LARGE_LOG_BYTES = 50 * 1024 * 1024;
export const LARGE_LOG_THROTTLE_MS = 30 * 1000; // re-indexing costs about 1 ms per MB, so a huge growing log is indexed less often
export const INSIGHT_DAYS = 60; // also how long daily totals are kept: older days are dropped when the files are saved
export const INSIGHT_RANGES = [1, 7, 30];
export const TOP_PROJECTS_PER_DAY = 3;
export const TOP_ENTRIES_PER_RANGE = 5;

// ---- Extension wiring ----

export const VIEWS_DIRECTORY = path.join(__dirname, 'views');
export const CONFIG_SECTION = 'complementer';
export const CHAT_SCHEME = 'complementer-chat';
export const CLAUDE_OPEN_COMMAND = 'claude-vscode.primaryEditor.open'; // the official extension's own command, also behind its vscode:// open link
export const REFRESH_DEBOUNCE_MS = 150;
export const SCAN_DEBOUNCE_MS = 400;
export const SAVE_DEBOUNCE_MS = 2000;
export const POLL_INTERVAL_MS = 60 * 1000;
export const CLOCK_TICK_MS = 30 * 1000; // reset countdowns and staleness move with the clock
export const ACTIVE_SESSION_MS = 5 * 60 * 1000;
export const BACKUP_SUFFIX = '.bak'; // last good copy of a state file, made each time one loads
export const UNREADABLE_SUFFIX = '.bad';
export const IDLE_LOG_MS = 7 * 24 * 3600 * 1000; // a log untouched this long can no longer get more blocks of its last reply
