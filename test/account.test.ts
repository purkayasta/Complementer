import test from 'node:test';
import assert from 'node:assert';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { parseAccount, readAccountIfChanged } from '../src/live';
import { createTemporaryDirectory, writeTextFile } from './helpers';

test('team account: plan type and seat tier are combined once', () => {
  const claudeConfig = { oauthAccount: { emailAddress: 'a@b.co', organizationType: 'claude_team', seatTier: 'team_standard', organizationName: 'Acme' } };
  assert.deepStrictEqual(parseAccount(claudeConfig), { email: 'a@b.co', plan: 'Team · Standard', organization: 'Acme' });
});

test('individual plans and missing fields never throw', () => {
  assert.strictEqual(parseAccount({ oauthAccount: { emailAddress: 'a@b.co', organizationType: 'claude_max' } })?.plan, 'Max');
  assert.strictEqual(parseAccount({ oauthAccount: { emailAddress: 'a@b.co', billingType: 'stripe_subscription' } })?.plan, 'Stripe Subscription');
  assert.strictEqual(parseAccount({ oauthAccount: { emailAddress: 'a@b.co' } })?.plan, '');
  assert.strictEqual(parseAccount({}), undefined); // API-key users have no oauthAccount
  assert.strictEqual(parseAccount(null), undefined);
});

test('the config file is only parsed again when its modification time changed', async () => {
  const configPath = path.join(await createTemporaryDirectory(), '.claude.json');
  const missing = await readAccountIfChanged(configPath, undefined);
  assert.deepStrictEqual(missing, { account: undefined, modifiedAtMs: 0 }); // no file: a first answer, not an error
  assert.strictEqual(await readAccountIfChanged(configPath, 0), undefined);
  await writeTextFile(configPath, JSON.stringify({ oauthAccount: { emailAddress: 'a@b.co', organizationType: 'claude_max' } }));
  const first = await readAccountIfChanged(configPath, 0);
  assert.strictEqual(first?.account?.email, 'a@b.co');
  assert.strictEqual(await readAccountIfChanged(configPath, first?.modifiedAtMs), undefined); // unchanged: not read
  await writeTextFile(configPath, JSON.stringify({ oauthAccount: { emailAddress: 'new@b.co' } }));
  await fsPromises.utimes(configPath, new Date(), new Date(Date.now() + 5000));
  assert.strictEqual((await readAccountIfChanged(configPath, first?.modifiedAtMs))?.account?.email, 'new@b.co');
});
