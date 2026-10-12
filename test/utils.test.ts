import test from 'node:test';
import assert from 'node:assert';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { writeCosts, createQueue, createTimer, sumContextTokens } from '../src/utils';
import { createTemporaryDirectory, writeTextFile } from './helpers';

test('writeCosts keeps the highest value of what another window saved, and can skip the merge after a removal', async () => {
  const filePath = path.join(await createTemporaryDirectory(), 'costs.json');
  await writeTextFile(filePath, JSON.stringify({ a: 5, b: 1, junk: 'x' }));
  const costs: Record<string, number> = { a: 2, c: 3 };
  await writeCosts(filePath, costs, true);
  assert.deepStrictEqual(costs, { a: 5, c: 3, b: 1 });
  assert.deepStrictEqual(JSON.parse(await fsPromises.readFile(filePath, 'utf8')), costs);
  const withoutB = { a: costs.a, c: costs.c };
  await writeCosts(filePath, withoutB, false);
  assert.deepStrictEqual(JSON.parse(await fsPromises.readFile(filePath, 'utf8')), { a: 5, c: 3 }); // not brought back
});

test('createQueue runs tasks one after another, and a failed task does not stop the next', async () => {
  const enqueue = createQueue();
  const order: string[] = [];
  const first = enqueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('first');
  });
  const failing = enqueue(async () => {
    order.push('failing');
    throw new Error('boom');
  });
  const last = enqueue(async () => order.push('last'));
  await first;
  await assert.rejects(failing, /boom/);
  await last;
  assert.deepStrictEqual(order, ['first', 'failing', 'last']);
});

test('createTimer keeps a pending run by default, pushes it back with restart, and can be cancelled', async () => {
  let runs = 0;
  const timer = createTimer(() => runs++, 20);
  timer.schedule();
  timer.schedule(); // kept: still one run
  assert.strictEqual(timer.isPending, true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.strictEqual(runs, 1);
  assert.strictEqual(timer.isPending, false);
  timer.schedule();
  timer.cancel();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.strictEqual(runs, 1); // cancelled
  timer.schedule();
  await new Promise((resolve) => setTimeout(resolve, 10));
  timer.schedule(true); // restart: the 20 ms start again
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.strictEqual(runs, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.strictEqual(runs, 2);
});

test('sumContextTokens adds input and cache tokens and counts bad values as 0', () => {
  assert.strictEqual(sumContextTokens({ input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 999 }), 112);
  assert.strictEqual(sumContextTokens({ input_tokens: -5, cache_creation_input_tokens: 'x', cache_read_input_tokens: 7 }), 7);
  assert.strictEqual(sumContextTokens(undefined), 0);
});
