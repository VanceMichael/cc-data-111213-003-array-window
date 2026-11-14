import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  openZarrArray, normalizeSlice, WindowError, UnsupportedEncodingError,
  BadChunkError, ChunkReadError, MetadataChangedError, ZarrWindowStore,
} from '../src/window.js';
import { claimWindows } from '../src/domain.js';
import { Archive } from '../src/archive.js';

const samplePath = 'fixtures/temperature/.zarray';

/* 主资料逻辑阵列（fill=-32768，块 2x2，缺失块 1.1）：
 * 10     0    20
 * 11    12    21
 * 13    14  缺省(缺块 1.1)
 * 15    16  缺省(缺块 1.1)
 * 17    18  补值(块 2.0 内真实 -32768，非缺省)
 */

test('步长切片返回独立形状、坐标与数据', async () => {
  const store = await openZarrArray(samplePath);
  const result = await store.claim([{ time: [0, 5, 2], sensor: [0, 3, 1] }]);
  const window = result.windows[0];
  assert.deepEqual(window.shape, [3, 3]);
  assert.deepEqual(window.indices, [[0, 2, 4], [0, 1, 2]]);
  assert.deepEqual(Array.from(window.data), [10, 0, 20, 13, 14, -32768, 17, 18, -32768]);
  // 2.2 与缺失块 1.1 覆盖的单元才是缺省；块内真实的 0 不是缺省
  assert.deepEqual(Array.from(window.missing), [0, 0, 0, 0, 0, 1, 0, 0, 1]);
  assert.equal(window.fillValue, -32768);
});

test('负索引与负步长遵循 NumPy 语义', async () => {
  const store = await openZarrArray(samplePath);
  const result = await store.claim([
    { time: [-2, null, 1], sensor: [1, 3, 1] },
    { time: [null, null, -1], sensor: [null, null, 1] },
  ]);
  assert.deepEqual(result.windows[0].indices, [[3, 4], [1, 2]]);
  assert.deepEqual(Array.from(result.windows[0].data), [16, -32768, 18, -32768]);
  assert.deepEqual(Array.from(result.windows[0].missing), [0, 1, 0, 1]);
  const reversed = result.windows[1];
  assert.deepEqual(reversed.indices, [[4, 3, 2, 1, 0], [0, 1, 2]]);
  assert.equal(reversed.data[0], 17);
  assert.equal(reversed.data.at(-1), 20);
});

test('全缺省区域按 fill_value 表达且不报错', async () => {
  // 缺失块 1.1 覆盖 time 2-3 × sensor 2；time[2..3]、sensor[2] 整列均无落盘块
  const store = await openZarrArray(samplePath);
  const result = await store.claim([{ time: [2, 4, 1], sensor: [2, 3, 1] }]);
  assert.deepEqual(result.windows[0].shape, [2, 1]);
  assert.deepEqual(Array.from(result.windows[0].data), [-32768, -32768]);
  assert.deepEqual(Array.from(result.windows[0].missing), [1, 1]);
  assert.equal(result.stats.chunksLoaded, 0);
  assert.equal(result.stats.chunksMissing, 1);
});

test('块内等于 fill_value 的真实补值不被标记为缺失，块坐标不等于测点编号', async () => {
  // 块 0.1（C 序 2x2）：(0,2)=20、(0,3)=-32768、(1,2)=21、(1,3)=-32768（越界格点）
  const store = await openZarrArray(samplePath);
  const result = await store.claim([{ time: [0, 2, 1], sensor: [2, 3, 1] }]);
  assert.deepEqual(Array.from(result.windows[0].data), [20, 21]);
  // 块存在，块内即便有等于 fill_value 的字节，缺失掩码也必须是 0
  assert.deepEqual(Array.from(result.windows[0].missing), [0, 0]);
  // 对照：缺失块 1.1 覆盖的 (2,2) 才是真缺省
  const absent = await store.claim([{ time: [2, 3, 1], sensor: [2, 3, 1] }]);
  assert.deepEqual(Array.from(absent.windows[0].data), [-32768]);
  assert.deepEqual(Array.from(absent.windows[0].missing), [1]);
});

test('坏 gzip 块按损坏失败，绝不作为缺省块补齐', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bad-chunk-'));
  try {
    await writeFile(join(folder, '.zarray'), JSON.stringify({ zarr_format: 2, shape: [4],
      chunks: [2], dtype: '<i2', compressor: { id: 'gzip' }, fill_value: -1, order: 'C', filters: null }));
    const good = Buffer.alloc(4); good.writeInt16LE(1, 0); good.writeInt16LE(2, 2);
    await writeFile(join(folder, '0'), gzipSync(good));
    const bad = gzipSync(Buffer.from([3, 0, 4, 0])); bad[bad.length - 1] ^= 0xff;
    await writeFile(join(folder, '1'), bad);
    const store = await openZarrArray(join(folder, '.zarray'));
    await assert.rejects(store.claim([{ '0': [0, 4, 1] }]), (error) => {
      assert.ok(error instanceof BadChunkError);
      assert.equal(error.code, 'BAD_CHUNK');
      return true;
    });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('传输失败与缺块区分：ENOENT 是缺省，其它 IO 错误是失败', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'io-fail-'));
  try {
    await writeFile(join(folder, '.zarray'), JSON.stringify({ zarr_format: 2, shape: [4],
      chunks: [2], dtype: '<i2', compressor: null, fill_value: -1, order: 'C', filters: null }));
    const io = {
      async readChunk(path) {
        if (path.endsWith('/0')) return Buffer.from([1, 0, 2, 0]);
        if (path.endsWith('/1')) { const error = new Error('权限拒绝'); error.code = 'EACCES'; throw error; }
        return null;
      },
    };
    const store = await openZarrArray(join(folder, '.zarray'), io);
    await assert.rejects(store.claim([{ '0': [0, 4, 1] }]), (error) => {
      assert.ok(error instanceof ChunkReadError);
      assert.equal(error.code, 'CHUNK_READ_FAILED');
      return true;
    });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('多个交叠窗口共享块数据，窗口结果彼此独立', async () => {
  const store = await openZarrArray(samplePath);
  const result = await store.claim([
    { time: [0, 4, 1], sensor: [0, 3, 1] },
    { time: [1, 5, 1], sensor: [1, 3, 1] },
  ]);
  assert.equal(result.windows.length, 2);
  assert.equal(result.stats.chunksNeeded, 6);
  assert.ok(result.stats.cacheHits > 0, '交叠引用应命中缓存');
  const [a, b] = result.windows;
  assert.deepEqual(a.shape, [4, 3]);
  assert.deepEqual(b.shape, [4, 2]);
  // 修改一个窗口不影响另一个
  a.data[0] = 9999;
  assert.notEqual(b.data[0], 9999);
  assert.deepEqual(a.dimensions, ['time', 'sensor']);
});

test('连续两次领取彼此独立且不展开整个阵列', async () => {
  const store = await openZarrArray(samplePath);
  const first = await store.claim([{ time: [0, 1, 1], sensor: [0, 1, 1] }]);
  const second = await store.claim([{ time: [4, 5, 1], sensor: [2, 3, 1] }]);
  assert.deepEqual(Array.from(first.windows[0].data), [10]);
  assert.deepEqual(Array.from(second.windows[0].data), [-32768]);
  assert.deepEqual(Array.from(second.windows[0].missing), [1]);
});

test('F 序大端 gzip 与 C 序小端 gzip 结果一致', async () => {
  const base = await openZarrArray(samplePath);
  const f = await openZarrArray('fixtures/temperature-f/.zarray');
  const window = [{ time: [0, 5, 1], sensor: [0, 3, 1] }];
  const a = (await base.claim(window)).windows[0];
  const b = (await f.claim(window)).windows[0];
  assert.deepEqual(Array.from(b.data), Array.from(a.data));
  assert.deepEqual(Array.from(b.missing), Array.from(a.missing));
  assert.deepEqual(b.indices, a.indices);
});

test('未压缩 f4 解码正确，块内补值与缺块掩码区分', async () => {
  const store = await openZarrArray('fixtures/temperature-plain/.zarray');
  const result = await store.claim([{ time: [0, 5, 1], sensor: [0, 3, 1] }]);
  const window = result.windows[0];
  assert.deepEqual(Array.from(window.data), [10, 0, 20, 11, 12, 21, 13, 14, -9999, 15, 16, -9999, 17, 18, -9999]);
  assert.deepEqual(Array.from(window.missing), [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  // 块 0.1 越界格点上真实写入的 -9999（补值）不会被逻辑窗口取到；块内正常值不受影响
  const inBlock = await store.claim([{ time: [1, 2, 1], sensor: [2, 3, 1] }]);
  assert.deepEqual(Array.from(inBlock.windows[0].data), [21]);
  assert.deepEqual(Array.from(inBlock.windows[0].missing), [0]);
});

test('非整除边缘块按实际字节数解释（C 序短块与完整块均支持）', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'edge-'));
  try {
    await writeFile(join(folder, '.zarray'), JSON.stringify({ zarr_format: 2, shape: [3],
      chunks: [2], dtype: '<i2', compressor: null, fill_value: -7, order: 'C', filters: null }));
    await writeFile(join(folder, '0'), Buffer.from([1, 0, 2, 0]));
    // 末块只有 1 个逻辑单元，按 2 字节短块落盘
    await writeFile(join(folder, '1'), Buffer.from([3, 0]));
    const store = await openZarrArray(join(folder, '.zarray'));
    const result = await store.claim([{ '0': [0, 3, 1] }]);
    assert.deepEqual(Array.from(result.windows[0].data), [1, 2, 3]);
    // 字节数与单元大小不符必须判损坏
    await writeFile(join(folder, '1'), Buffer.from([3, 0, 0]));
    await assert.rejects(store.claim([{ '0': [0, 3, 1] }]), BadChunkError);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('超出支持的编码在打开时明确拒绝', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'reject-'));
  try {
    const base = { zarr_format: 2, shape: [4], chunks: [2], fill_value: 0, order: 'C', filters: null };
    const cases = [
      { ...base, dtype: '<i4', compressor: { id: 'zstd' } },
      { ...base, dtype: '<i4', compressor: null, filters: [{ id: 'delta' }] },
      { ...base, dtype: '<i8', compressor: null },
      { ...base, dtype: '<f2', compressor: null },
      { ...base, dtype: '|S4', compressor: null },
      { ...base, dtype: '<i4', compressor: null, order: 'Q' },
    ];
    for (const meta of cases) {
      await writeFile(join(folder, '.zarray'), JSON.stringify(meta));
      await assert.rejects(openZarrArray(join(folder, '.zarray')), (error) => {
        assert.ok(error instanceof UnsupportedEncodingError);
        assert.equal(error.code, 'UNSUPPORTED_ENCODING');
        return true;
      }, `应拒绝 ${meta.dtype}/${meta.compressor && meta.compressor.id}/${meta.order}`);
    }
    await writeFile(join(folder, '.zarray'), JSON.stringify({ ...base, dtype: '<i4', compressor: null, zarr_format: 3 }));
    await assert.rejects(openZarrArray(join(folder, '.zarray')), UnsupportedEncodingError);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('元数据换版后一致性检查失败，领取期间换版整批拒绝', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mutate-'));
  try {
    const zarray = { zarr_format: 2, shape: [4], chunks: [2], dtype: '<i2',
      compressor: null, fill_value: -1, order: 'C', filters: null };
    await writeFile(join(folder, '.zarray'), JSON.stringify(zarray));
    await writeFile(join(folder, '0'), Buffer.from([1, 0, 2, 0]));
    const store = await openZarrArray(join(folder, '.zarray'));
    const before = store.fingerprint;
    await writeFile(join(folder, '.zarray'), JSON.stringify({ ...zarray, chunks: [3] }));
    await assert.rejects(store.checkConsistency(), (error) => {
      assert.ok(error instanceof MetadataChangedError);
      return true;
    });
    // 打开时的指纹保留不变，旧窗口据此判定坐标含义已失效
    assert.equal(store.fingerprint, before);

    // 领取期间换版：块读取后的二次核对必须让整批领取失败
    await writeFile(join(folder, '.zarray'), JSON.stringify(zarray));
    let calls = 0;
    const mutatingIo = {
      async readChunk(path) {
        if (path.endsWith('/0')) {
          if (calls++ === 0) {
            await writeFile(join(folder, '.zarray'),
              JSON.stringify({ ...zarray, fill_value: -999 }));
          }
          return Buffer.from([1, 0, 2, 0]);
        }
        return null;
      },
    };
    const mutatingStore = new ZarrWindowStore(join(folder, '.zarray'), mutatingIo);
    await mutatingStore.open();
    await assert.rejects(mutatingStore.claim([{ '0': [0, 4, 1] }]), MetadataChangedError);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('空窗口与越界裁剪行为', async () => {
  const store = await openZarrArray(samplePath);
  const empty = await store.claim([{ time: [3, 3, 1], sensor: [0, 3, 1] }]);
  assert.deepEqual(empty.windows[0].shape, [0, 3]);
  assert.equal(empty.windows[0].data.length, 0);
  const clipped = await store.claim([{ time: [0, 99, 1], sensor: [-99, 99, 1] }]);
  assert.deepEqual(clipped.windows[0].shape, [5, 3]);
});

test('非法切片与未知维度报错', async () => {
  assert.throws(() => normalizeSlice([0, 4, 0], 10), /步长/);
  assert.throws(() => normalizeSlice([0.5], 10), /端点/);
  assert.throws(() => normalizeSlice([0, 1, 2, 3], 10), /长度不超过 3/);
  assert.deepEqual(normalizeSlice([], 10), []);
  assert.deepEqual(normalizeSlice(undefined, 4), [0, 1, 2, 3]);
  assert.deepEqual(normalizeSlice(null, 4), [0, 1, 2, 3]);
  const store = await openZarrArray(samplePath);
  await assert.rejects(store.claim([{ probe: [0, 1, 1] }]), (error) => {
    assert.ok(error instanceof WindowError);
    assert.match(error.message, /未知维度/);
    return true;
  });
});

test('claimWindows 接入资料登记：回执含窗口清单与块统计', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'registry-'));
  try {
    const archive = new Archive(join(folder, 'archive'));
    const { manifest, receipt } = await claimWindows(samplePath,
      [{ time: [0, 5, 2], sensor: [0, 3, 1] }], archive);
    assert.equal(receipt.metadata.kind, 'window-claim');
    assert.deepEqual(manifest.stats.chunksLoaded, 4);
    assert.equal(manifest.windows[0].missingCount, 2);
    const receipts = await archive.receipts();
    assert.equal(receipts.length, 1);
    const roundtrip = JSON.parse((await archive.read(receipt.sha256)).toString('utf8'));
    assert.deepEqual(roundtrip.windows[0].data, manifest.windows[0].data);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
