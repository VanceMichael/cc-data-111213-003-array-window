import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Archive } from './archive.js';
import { inspect, sample, claimWindows } from './domain.js';
import { openZarrArray, WindowError } from './window.js';

const [command = 'help', file, windowsFile, archiveDirectory = '.local/archive'] = process.argv.slice(2);

async function buildDemoScratch() {
  const root = await mkdtemp(join(tmpdir(), 'window-claim-'));
  const i2 = (values) => {
    const buffer = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
    return gzipSync(buffer);
  };
  // 与 fixtures/temperature 相同的逻辑阵列，其中 2.0 块被写成损坏的 gzip
  const broken = join(root, 'broken');
  await mkdir(broken);
  await writeFile(join(broken, '.zarray'), JSON.stringify({ zarr_format: 2, shape: [5, 3],
    chunks: [2, 2], dtype: '<i2', compressor: { id: 'gzip', level: 1 },
    fill_value: -32768, order: 'C', filters: null }));
  await writeFile(join(broken, '.zattrs'), JSON.stringify({ dimensions: ['time', 'sensor'], unit: '摄氏度' }));
  for (const [key, values] of Object.entries({ '0.0': [10, 0, 11, 12], '1.0': [13, 14, 15, 16],
    '0.1': [20, -32768, 21, -32768] })) {
    await writeFile(join(broken, key), i2(values));
  }
  await writeFile(join(broken, '2.0'), gzipSync(Buffer.from([0x10, 0x00, 0x11, 0x00, 0x12, 0x00])));
  // 破坏 gzip 尾部校验
  const corrupt = join(broken, '2.0');
  const bad = await readFile(corrupt); bad[bad.length - 1] ^= 0xff;
  await writeFile(corrupt, bad);

  // 超出支持范围的编码：Zstd 压缩 / delta 过滤器 / 8 字节整数
  const unsupported = join(root, 'unsupported-zstd');
  await mkdir(unsupported);
  await writeFile(join(unsupported, '.zarray'), JSON.stringify({ zarr_format: 2, shape: [4],
    chunks: [2], dtype: '<i4', compressor: { id: 'zstd' },
    fill_value: 0, order: 'C', filters: null }));
  const delta = join(root, 'unsupported-delta');
  await mkdir(delta);
  await writeFile(join(delta, '.zarray'), JSON.stringify({ zarr_format: 2, shape: [4],
    chunks: [2], dtype: '<i4', compressor: null,
    fill_value: 0, order: 'C', filters: [{ id: 'delta', dtype: '<i4', astype: '<i4' }] }));
  const i8 = join(root, 'unsupported-i8');
  await mkdir(i8);
  await writeFile(join(i8, '.zarray'), JSON.stringify({ zarr_format: 2, shape: [4],
    chunks: [2], dtype: '<i8', compressor: null,
    fill_value: 0, order: 'C', filters: null }));
  return root;
}

async function run() {
  if (command === 'help') {
    console.log(JSON.stringify({ usage: 'npm start -- <命令> [资料路径] [窗口文件] [归档目录]',
      commands: ['inspect', 'capture', 'list', 'claim', 'demo'] }, null, 2));
  } else if (command === 'inspect') {
    if (!file) throw new Error('需要资料路径');
    console.log(JSON.stringify(await inspect(resolve(file)), null, 2));
  } else if (command === 'capture') {
    if (!file) throw new Error('需要资料路径');
    const inventory = await inspect(resolve(file));
    const receipt = await new Archive(archiveDirectory).accept(await readFile(resolve(file)),
      { source: resolve(file), inventory });
    console.log(JSON.stringify(receipt, null, 2));
  } else if (command === 'list') {
    console.log(JSON.stringify(await new Archive(file || archiveDirectory).receipts(), null, 2));
  } else if (command === 'claim') {
    if (!file) throw new Error('需要资料路径');
    if (!windowsFile) throw new Error('需要窗口定义 JSON，例如 fixtures/windows.json');
    const { windows } = JSON.parse(await readFile(resolve(windowsFile), 'utf8'));
    const archive = new Archive(archiveDirectory);
    const { manifest, receipt } = await claimWindows(resolve(file), windows, archive);
    console.log(JSON.stringify({ manifest, receipt: { id: receipt.id, sha256: receipt.sha256 } }, null, 2));
  } else if (command === 'demo') {
    const temporary = await buildDemoScratch();
    try {
      const archiveDirectory = join(temporary, 'archive');
      const inventory = await inspect(resolve(sample));
      const archive = new Archive(archiveDirectory);
      const receipt = await archive.accept(await readFile(resolve(sample)), { source: sample, inventory });

      // 1) 步长切片 + 负索引，两个交叠窗口一次领取，块数据复用
      const windowsDoc = JSON.parse(await readFile('fixtures/windows.json', 'utf8'));
      const claimed = await claimWindows(resolve(sample), windowsDoc.windows, archive);
      console.log(JSON.stringify({ 步长切片与负索引: claimed.manifest,
        登记回执: { id: claimed.receipt.id, sha256: claimed.receipt.sha256 } }, null, 2));

      // 2) 全缺省区域：只命中不存在的块 1.1，按 fill_value 表达而不是失败
      const store = await openZarrArray(resolve(sample));
      const allMissing = await store.claim([{ time: [2, 4, 1], sensor: [2, 3, 1] }]);
      console.log(JSON.stringify({ 全缺省区域: allMissing }, (key, value) =>
        value instanceof Float64Array || value instanceof Uint8Array ? Array.from(value) : value, 2));

      // 3) 损坏块：gzip 失败必须抛出，绝不当缺省块补齐
      const brokenPath = join(temporary, 'broken', '.zarray');
      let brokenOutcome;
      try {
        const brokenStore = await openZarrArray(brokenPath);
        await brokenStore.claim([{ time: [0, 5, 1], sensor: [0, 3, 1] }]);
        brokenOutcome = '意外成功';
      } catch (error) {
        brokenOutcome = { name: error.name, code: error.code, message: error.message };
      }
      console.log(JSON.stringify({ 损坏块处理: brokenOutcome }, null, 2));

      // 4) 超出支持的编码：明确拒绝
      const refusals = [];
      for (const name of ['unsupported-zstd', 'unsupported-delta', 'unsupported-i8']) {
        try {
          await openZarrArray(join(temporary, name, '.zarray'));
          refusals.push({ name, outcome: '意外接受' });
        } catch (error) {
          refusals.push({ name, outcome: { code: error.code, message: error.message } });
        }
      }
      console.log(JSON.stringify({ 不支持编码拒绝: refusals }, null, 2));

      // 5) 不同维顺序/大小端/未压缩：结果与主资料一致
      const fStore = await openZarrArray('fixtures/temperature-f/.zarray');
      const plainStore = await openZarrArray('fixtures/temperature-plain/.zarray');
      const base = await store.claim([{ time: [0, 5, 1], sensor: [0, 3, 1] }]);
      const fResult = await fStore.claim([{ time: [0, 5, 1], sensor: [0, 3, 1] }]);
      const plainResult = await plainStore.claim([{ time: [0, 5, 1], sensor: [0, 3, 1] }]);
      const same = (a, b) => JSON.stringify(Array.from(a)) === JSON.stringify(Array.from(b));
      // f4 资料仅 fill_value 不同（-9999 vs -32768）：比较非补值单元与掩码
      const nonFill = (arr, fillValue) => Array.from(arr).filter(value => value !== fillValue);
      const f4Aligned = JSON.stringify(nonFill(plainResult.windows[0].data, plainStore.metadata.fill_value))
        === JSON.stringify(nonFill(base.windows[0].data, store.metadata.fill_value));
      console.log(JSON.stringify({
        编码等价性: {
          C序小端gzip_i2: { shape: base.windows[0].shape, data: Array.from(base.windows[0].data),
            missing: Array.from(base.windows[0].missing) },
          F序大端gzip_i2: { shape: fResult.windows[0].shape,
            与主资料数据一致: same(base.windows[0].data, fResult.windows[0].data),
            与主资料掩码一致: same(base.windows[0].missing, fResult.windows[0].missing) },
          C序小端未压缩_f4: { shape: plainResult.windows[0].shape, fillValue: plainStore.metadata.fill_value,
            非补值单元与主资料一致: f4Aligned,
            与主资料掩码一致: same(base.windows[0].missing, plainResult.windows[0].missing) },
        },
      }, null, 2));

      // 6) 交叠窗口的块复用统计
      const overlap = await store.claim([
        { time: [0, 4, 1], sensor: [0, 3, 1] },
        { time: [1, 5, 1], sensor: [1, 3, 1] },
        { time: [-1, null, 1], sensor: [-1, null, 1] },
      ]);
      console.log(JSON.stringify({ 交叠窗口块复用: overlap.stats }, null, 2));

      // 7) 运行中换版：坐标含义指纹变化时拒绝继续使用
      const copyPath = join(temporary, 'mutated');
      await mkdir(copyPath);
      await writeFile(join(copyPath, '.zattrs'), await readFile('fixtures/temperature/.zattrs'));
      await writeFile(join(copyPath, '.zarray'), await readFile(resolve(sample)));
      const watcher = await openZarrArray(join(copyPath, '.zarray'));
      const mutated = JSON.parse(await readFile(join(copyPath, '.zarray'), 'utf8'));
      mutated.chunks = [3, 3];
      await writeFile(join(copyPath, '.zarray'), JSON.stringify(mutated));
      let changeOutcome;
      try {
        await watcher.checkConsistency();
        changeOutcome = '未检测到换版';
      } catch (error) {
        changeOutcome = { name: error.name, code: error.code, message: error.message };
      }
      console.log(JSON.stringify({ 元数据换版检测: changeOutcome }, null, 2));

      console.log(JSON.stringify({ 归档核验: (await archive.read(receipt.sha256)).length }, null, 2));
    } finally { await rm(temporary, { recursive: true, force: true }); }
  } else { throw new Error('支持 inspect、capture、list、claim、demo'); }
}
run().catch(error => {
  console.error(error instanceof WindowError ? `[${error.code}] ${error.message}` : error.message);
  process.exitCode = 1;
});
