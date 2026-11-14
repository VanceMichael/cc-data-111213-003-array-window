import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { openZarrArray } from './window.js';

export const sample = 'fixtures/temperature/.zarray';
export async function inspect(filename) {
  const metadata = JSON.parse(await readFile(filename, 'utf8'));
  if (metadata.zarr_format !== 2) throw new Error('仅识别 Zarr v2 资料');
  if (metadata.shape.length !== metadata.chunks.length) throw new Error('维数不一致');
  return { metadata, availableChunks: (await readdir(dirname(filename)))
    .filter(name => /^\d+(?:\.\d+)*$/.test(name)).sort(),
    attributes: JSON.parse(await readFile(join(dirname(filename), '.zattrs'), 'utf8')) };
}

/*
 * 按逻辑数组窗口领取资料，并通过现有 Archive 登记一份回执。
 * 调用方只给出时间/探头维的切片，块路径、块坐标、解码与缺省判断都在内部完成。
 */
export async function claimWindows(filename, windowSpecs, archive) {
  const store = await openZarrArray(filename);
  const inventory = await inspect(filename);
  const result = await store.claim(windowSpecs);
  const manifest = {
    source: filename,
    fingerprint: result.fingerprint,
    stats: result.stats,
    windows: result.windows.map(window => ({
      window: window.window,
      dimensions: window.dimensions,
      shape: window.shape,
      indices: window.indices,
      data: Array.from(window.data),
      missing: Array.from(window.missing),
      fillValue: window.fillValue,
      missingCount: window.missing.reduce((sum, bit) => sum + bit, 0),
    })),
  };
  const receipt = archive
    ? await archive.accept(Buffer.from(JSON.stringify(manifest, null, 2)),
        { kind: 'window-claim', source: filename, inventory: { shape: inventory.metadata.shape,
          chunks: inventory.metadata.chunks, dtype: inventory.metadata.dtype,
          order: inventory.metadata.order, availableChunks: inventory.availableChunks } })
    : null;
  return { manifest, receipt };
}
