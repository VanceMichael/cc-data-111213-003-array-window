import { mkdir as ensureFixtureDirectory } from 'node:fs/promises';
await ensureFixtureDirectory('fixtures', {recursive:true});

import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
await mkdir('fixtures/temperature', { recursive: true });
await writeFile('fixtures/temperature/.zarray', JSON.stringify({ zarr_format: 2, shape: [5, 3],
  chunks: [2, 2], dtype: '<i2', compressor: { id: 'gzip', level: 1 },
  fill_value: -32768, order: 'C', filters: null }));
await writeFile('fixtures/temperature/.zattrs', JSON.stringify({ dimensions: ['time', 'sensor'], unit: '摄氏度' }));
for (const [key, values] of Object.entries({ '0.0': [10, 0, 11, 12], '1.0': [13, 14, 15, 16],
  '2.0': [17, 18, -32768, -32768], '0.1': [20, -32768, 21, -32768] })) {
  const bytes = Buffer.alloc(8);
  values.forEach((value, index) => bytes.writeInt16LE(value, index * 2));
  await writeFile(`fixtures/temperature/${key}`, gzipSync(bytes));
}
await writeFile('fixtures/windows.json', JSON.stringify({ windows: [
  { time: [0, 5, 2], sensor: [0, 3, 1] }, { time: [-2, null, 1], sensor: [1, 3, 1] }
] }, null, 2));
