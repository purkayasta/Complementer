// Plan limits asked straight from the user's own installed `claude`, the way the official extension does it: start
// `claude` in stream-json mode and send the control request `get_usage`. No message is sent (no plan usage) and no
// session is logged. This request is undocumented (the official extension marks it EXPERIMENTAL), so every failure
// returns undefined and the panel the ↻ button in the panel is the fallback.
import { spawn } from 'node:child_process';
import type { Limit } from './types';
import { tryParseJson } from './utils';
import { USAGE_QUERY_TIMEOUT_MS } from './consts';

const REQUEST_ID = 'complementer-usage';

export interface UsageLimits {
  fiveHourLimit?: Limit;
  weeklyLimit?: Limit;
}

/** `{ utilization: 14, resets_at: '2026-10-11T23:10:00+00:00' }` -> Limit. */
function toLimit(window: any): Limit | undefined {
  const percent = window?.utilization;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined;
  const resetsAtMs = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
  return { percent, resetsAt: Number.isFinite(resetsAtMs) ? Math.floor(resetsAtMs / 1000) : undefined };
}

/** The limits in the reply to our request among the lines `claude` printed, or undefined if there are none. */
export function parseUsageOutput(output: string): UsageLimits | undefined {
  const replies = output
    .split('\n')
    .map((line) => tryParseJson(line))
    .filter((message) => message?.type === 'control_response' && message.response?.request_id === REQUEST_ID && message.response.subtype === 'success');
  const rateLimits = replies[0]?.response?.response?.rate_limits;
  const limits = { fiveHourLimit: toLimit(rateLimits?.five_hour), weeklyLimit: toLimit(rateLimits?.seven_day) };
  return limits.fiveHourLimit || limits.weeklyLimit ? limits : undefined;
}

/**
 * Ask `claude` for the plan limits and stop it. Only the local settings are loaded and no MCP servers start, so the
 * user's hooks and servers are not run for this.
 * @param binaryPath The `claude` executable.
 * @param workingDirectory Must be a folder only the user can write to (the extension's storage): `claude` reads `.claude/settings.local.json` from it, so a shared folder like /tmp would let another user plant hooks.
 */
export function queryUsage(binaryPath: string, workingDirectory: string): Promise<UsageLimits | undefined> {
  return new Promise((resolve) => {
    try {
      const child = spawn(binaryPath, ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'local', '--strict-mcp-config'], { cwd: workingDirectory, stdio: ['pipe', 'pipe', 'ignore'] });
      const finish = (limits: UsageLimits | undefined) => {
        clearTimeout(timer);
        child.kill();
        resolve(limits);
      };
      const timer = setTimeout(() => finish(undefined), USAGE_QUERY_TIMEOUT_MS);
      let unfinishedLine = ''; // the end of the last chunk, which may stop mid-line
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        const lines = (unfinishedLine + chunk).split('\n');
        unfinishedLine = lines.pop() ?? '';
        const limits = parseUsageOutput(lines.join('\n'));
        if (limits) finish(limits);
      });
      child.on('error', () => finish(undefined));
      child.on('exit', () => finish(undefined));
      child.stdin.on('error', () => {});
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'get_usage' } }) + '\n');
    } catch {
      resolve(undefined);
    }
  });
}
