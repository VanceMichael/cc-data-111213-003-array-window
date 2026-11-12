import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
export const sample = 'fixtures/temperature/.zarray';
export async function inspect(filename) {
  const metadata = JSON.parse(await readFile(filename, 'utf8'));
  if (metadata.zarr_format !== 2) throw new Error('仅识别 Zarr v2 资料');
  if (metadata.shape.length !== metadata.chunks.length) throw new Error('维数不一致');
  return { metadata, availableChunks: (await readdir(dirname(filename)))
    .filter(name => /^\d+(?:\.\d+)*$/.test(name)).sort(),
    attributes: JSON.parse(await readFile(join(dirname(filename), '.zattrs'), 'utf8')) };
}
