import test from 'node:test';
import assert from 'node:assert';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { writeCosts } from '../src/utils';
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
