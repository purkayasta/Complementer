import test from 'node:test';
import assert from 'node:assert';
import { parsePayload, pickSessions, isWithin, effectiveLimit, isStale } from '../src/live';

const payload = {
  session_id: 'abc-1',
  cwd: '/p/a',
  model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' },
  cost: { total_cost_usd: 0.18 },
  context_window: { context_window_size: 1000000, used_percentage: 5, current_usage: { input_tokens: 2, cache_creation_input_tokens: 574, cache_read_input_tokens: 44454 } },
  rate_limits: { five_hour: { used_percentage: 75, resets_at: 1791664200 }, seven_day: { used_percentage: 12, resets_at: 1792170000 } },
};

test('parsePayload reads the captured shape', () => {
  assert.deepStrictEqual(parsePayload(JSON.stringify(payload), 5), {
    sessionId: 'abc-1',
    workingDirectory: '/p/a',
    modelName: 'Sonnet 5.5',
    modelId: 'claude-sonnet-5-5',
    contextPercent: 5,
    contextWindowSize: 1000000,
    contextTokens: 45030,
    fiveHourLimit: { percent: 75, resetsAt: 1791664200 },
    weeklyLimit: { percent: 12, resetsAt: 1792170000 },
    costUsd: 0.18,
    updatedAt: 5,
  });
});

test('parsePayload tolerates missing rate_limits, missing usage and junk', () => {
  const state = parsePayload(JSON.stringify({ ...payload, rate_limits: undefined, context_window: { used_percentage: 'x' } }), 1);
  assert.strictEqual(state?.fiveHourLimit, undefined);
  assert.strictEqual(state?.contextPercent, undefined);
  assert.strictEqual(parsePayload('{oops', 1), null);
  assert.strictEqual(parsePayload('{"cwd":"/x"}', 1), null);
});

test('pickSessions: context from the workspace session, limits from the newest payload', () => {
  const inWorkspace = parsePayload(JSON.stringify(payload), 100);
  const elsewhere = parsePayload(JSON.stringify({ ...payload, session_id: 'b', cwd: '/other' }), 200);
  assert.ok(inWorkspace && elsewhere);
  const picked = pickSessions([inWorkspace, elsewhere], ['/p']);
  assert.strictEqual(picked.contextSession?.sessionId, 'abc-1');
  assert.strictEqual(picked.limitsSession?.sessionId, 'b');
  assert.strictEqual(pickSessions([inWorkspace], ['/pp']).contextSession, undefined); // '/pp' is not inside '/p'
});

test('effectiveLimit: a passed reset time means the window restarted; stale after 10 minutes', () => {
  assert.deepStrictEqual(effectiveLimit({ percent: 75, resetsAt: 100 }, 101_000), { percent: 0, hasReset: true });
  assert.deepStrictEqual(effectiveLimit({ percent: 75, resetsAt: 200 }, 101_000), { percent: 75, hasReset: false });
  assert.strictEqual(effectiveLimit(undefined, 0), undefined);
  const state = parsePayload(JSON.stringify(payload), 0);
  assert.ok(state);
  assert.strictEqual(isStale(state, 9 * 60_000), false);
  assert.strictEqual(isStale(state, 11 * 60_000), true);
});

test('isWithin: the prefix must end at a path boundary; windows ignores case and slash style', () => {
  assert.strictEqual(isWithin('/p/a/b', '/p/a', false), true);
  assert.strictEqual(isWithin('/p/a', '/p/a/', false), true);
  assert.strictEqual(isWithin('/p/ab', '/p/a', false), false);
  assert.strictEqual(isWithin('C:\\Users\\Me\\proj\\src', 'c:/users/me/proj', true), true);
  assert.strictEqual(isWithin('C:\\Users\\Me\\proj2', 'c:/users/me/proj', true), false);
});
