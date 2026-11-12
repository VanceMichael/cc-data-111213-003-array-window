import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, sample } from '../src/domain.js';
import { gunzipSync } from 'node:zlib';

test('既有资料查看与本地来源符合领域约定', async () => {
  const result = await inspect(sample);
  assert.deepEqual(result.metadata.shape, [5, 3]);
  assert.equal(result.metadata.fill_value, -32768);
  assert.ok(!result.availableChunks.includes('1.1'));
  const chunk = gunzipSync(await readFile('fixtures/temperature/0.0'));
  assert.equal(chunk.readInt16LE(2), 0);
});
