import { mkdir as ensureFixtureDirectory } from 'node:fs/promises';
await ensureFixtureDirectory('fixtures', {recursive:true});

import { mkdir, writeFile, rm } from 'node:fs/promises';
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

/* F 序、大端、gzip：与主资料相同的逻辑 5x3 阵列，验证不同维顺序和大小端解码结果一致 */
await rm('fixtures/temperature-f', { recursive: true, force: true });
await mkdir('fixtures/temperature-f', { recursive: true });
await writeFile('fixtures/temperature-f/.zarray', JSON.stringify({ zarr_format: 2, shape: [5, 3],
  chunks: [2, 2], dtype: '>i2', compressor: { id: 'gzip', level: 1 },
  fill_value: -32768, order: 'F', filters: null }));
await writeFile('fixtures/temperature-f/.zattrs', JSON.stringify({ dimensions: ['time', 'sensor'], unit: '摄氏度' }));
const logical = [
  [10, 0, 20],
  [11, 12, 21],
  [13, 14, -32768],
  [15, 16, -32768],
  [17, 18, -32768],
];
for (const ci of [0, 1, 2]) {
  for (const cj of [0, 1]) {
    // 与主资料完全相同的落盘块集合：1.1 与 2.1 缺失，按 fill_value 表达
    if ((ci === 1 && cj === 1) || (ci === 2 && cj === 1)) continue;
    const rows = [];
    // F（列优先）顺序：先传感器维后时间维；边缘块缺失的格点用 fill_value 占位
    for (let sIn = 0; sIn < 2; sIn++) {
      for (let tIn = 0; tIn < 2; tIn++) {
        const t = ci * 2 + tIn;
        const s = cj * 2 + sIn;
        // 先按全局形状判断格点是否存在（两个维度都要在界内），越界格点写 fill 占位
        const insideArray = t < logical.length && s < logical[0].length;
        rows.push(insideArray ? logical[t][s] : -32768);
      }
    }
    const buffer = Buffer.alloc(8);
    rows.forEach((value, index) => buffer.writeInt16BE(value, index * 2));
    await writeFile(`fixtures/temperature-f/${ci}.${cj}`, gzipSync(buffer));
  }
}

/* 未压缩、C 序、小端 f4：缺省块 1.1 不落盘；块内真实零度与补值同时存在 */
await rm('fixtures/temperature-plain', { recursive: true, force: true });
await mkdir('fixtures/temperature-plain', { recursive: true });
await writeFile('fixtures/temperature-plain/.zarray', JSON.stringify({ zarr_format: 2, shape: [5, 3],
  chunks: [2, 2], dtype: '<f4', compressor: null,
  fill_value: -9999, order: 'C', filters: null }));
await writeFile('fixtures/temperature-plain/.zattrs', JSON.stringify({ dimensions: ['time', 'sensor'], unit: '摄氏度' }));
const f4Chunks = {
  '0.0': [10, 0, 11, 12], '1.0': [13, 14, 15, 16], '2.0': [17, 18, -9999, -9999],
  '0.1': [20, -9999, 21, -9999],
};
for (const [key, values] of Object.entries(f4Chunks)) {
  const buffer = Buffer.alloc(16);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  await writeFile(`fixtures/temperature-plain/${key}`, buffer);
}
