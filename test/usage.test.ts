import test from 'node:test';
import assert from 'node:assert';
import { parseUsageOutput, queryUsage } from '../src/usage';

const buildReply = (overrides: object = {}) =>
  JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'complementer-usage', response: { rate_limits: { five_hour: { utilization: 14, resets_at: '2026-10-11T23:10:00.372372+00:00' }, seven_day: { utilization: 32.5, resets_at: '2026-10-16T17:00:00+00:00' } } }, ...overrides } });

test('parseUsageOutput: reads both windows from the reply, ignoring other lines', () => {
  const output = ['{"type":"system","subtype":"hook_started"}', 'not json', buildReply()].join('\n');
  assert.deepStrictEqual(parseUsageOutput(output), { fiveHourLimit: { percent: 14, resetsAt: 1791760200 }, weeklyLimit: { percent: 32.5, resetsAt: 1792170000 } });
});

test('parseUsageOutput: an error reply, someone else\'s reply, a missing window or no rate limits give nothing', () => {
  assert.strictEqual(parseUsageOutput(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: 'complementer-usage', error: 'x' } })), undefined);
  assert.strictEqual(parseUsageOutput(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'other', response: { rate_limits: { five_hour: { utilization: 1 } } } } })), undefined);
  assert.strictEqual(parseUsageOutput(buildReply({ response: { rate_limits_available: false } })), undefined);
  assert.deepStrictEqual(parseUsageOutput(buildReply({ response: { rate_limits: { seven_day: { utilization: 5 } } } })), { fiveHourLimit: undefined, weeklyLimit: { percent: 5, resetsAt: undefined } });
  assert.strictEqual(parseUsageOutput(''), undefined);
});

test('queryUsage: a binary that cannot start gives undefined instead of throwing', async () => {
  assert.strictEqual(await queryUsage('/nonexistent/claude', '/'), undefined);
});
