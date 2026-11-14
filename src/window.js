import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gunzipAsync = promisify(gunzip);

/* ------------------------------------------------------------------ */
/* 错误分类：传输/坏块必须显式失败，不能落到 fill_value 缺省补齐路径上 */
/* ------------------------------------------------------------------ */
export class WindowError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WindowError';
    this.code = code;
  }
}
export class UnsupportedEncodingError extends WindowError {
  constructor(message) { super(message, 'UNSUPPORTED_ENCODING'); this.name = 'UnsupportedEncodingError'; }
}
export class ChunkReadError extends WindowError {
  constructor(message) { super(message, 'CHUNK_READ_FAILED'); this.name = 'ChunkReadError'; }
}
export class BadChunkError extends WindowError {
  constructor(message) { super(message, 'BAD_CHUNK'); this.name = 'BadChunkError'; }
}
export class MetadataChangedError extends WindowError {
  constructor(message) { super(message, 'METADATA_CHANGED'); this.name = 'MetadataChangedError'; }
}

/* --------------------------------------------------------- */
/* 支持的数值编码：1/2/4 字节整数、4/8 字节浮点，大小端均可   */
/* 8 字节整数、半精度、字符串、复数、固定长度字节等明确拒绝   */
/* --------------------------------------------------------- */
const NATIVE_LITTLE_ENDIAN = (() => {
  const probe = new Uint8Array(Uint16Array.of(1).buffer);
  return probe[0] === 1;
})();

const DTYPE_KIND = {
  i1: { size: 1, ctor: Int8Array, view: (dv, offset, le) => dv.getInt8(offset) },
  u1: { size: 1, ctor: Uint8Array, view: (dv, offset, le) => dv.getUint8(offset) },
  i2: { size: 2, ctor: Int16Array, view: (dv, offset, le) => dv.getInt16(offset, le) },
  u2: { size: 2, ctor: Uint16Array, view: (dv, offset, le) => dv.getUint16(offset, le) },
  i4: { size: 4, ctor: Int32Array, view: (dv, offset, le) => dv.getInt32(offset, le) },
  u4: { size: 4, ctor: Uint32Array, view: (dv, offset, le) => dv.getUint32(offset, le) },
  f4: { size: 4, ctor: Float32Array, view: (dv, offset, le) => dv.getFloat32(offset, le) },
  f8: { size: 8, ctor: Float64Array, view: (dv, offset, le) => dv.getFloat64(offset, le) },
};
const REJECTED_KINDS = {
  i8: '8 字节有符号整数', u8: '8 字节无符号整数', f2: '半精度浮点',
  c8: '复数', c16: '复数', U: 'Unicode 字符串', S: '字节字符串',
  V: '固定长度字节', b: '布尔型', t: '时间型',
};

function parseDtype(dtype) {
  if (typeof dtype !== 'string') throw new UnsupportedEncodingError(`dtype 不是字符串: ${JSON.stringify(dtype)}`);
  const match = /^([<|>])(.+)$/.exec(dtype);
  if (!match) throw new UnsupportedEncodingError(`不支持的 dtype 写法: ${dtype}`);
  const [, marker, kind] = match;
  if (REJECTED_KINDS[kind]) throw new UnsupportedEncodingError(`不支持的编码 ${dtype}：${REJECTED_KINDS[kind]}`);
  const descriptor = DTYPE_KIND[kind];
  if (!descriptor) throw new UnsupportedEncodingError(`不支持的 dtype: ${dtype}`);
  return { marker, kind, ...descriptor };
}

function validateMetadata(meta) {
  if (meta.zarr_format !== 2) {
    throw new UnsupportedEncodingError(`仅识别 Zarr v2 资料，当前 zarr_format=${JSON.stringify(meta.zarr_format)}`);
  }
  if (!Array.isArray(meta.shape) || !Array.isArray(meta.chunks)
      || meta.shape.length !== meta.chunks.length || meta.shape.length === 0) {
    throw new WindowError('shape 与 chunks 必须是等长的非空数组', 'BAD_METADATA');
  }
  if (!meta.shape.every(n => Number.isInteger(n) && n > 0)
      || !meta.chunks.every(n => Number.isInteger(n) && n > 0)) {
    throw new WindowError('shape 与 chunks 必须是正整数', 'BAD_METADATA');
  }
  if (meta.order !== 'C' && meta.order !== 'F') {
    throw new UnsupportedEncodingError(`不支持的阵列顺序 order=${JSON.stringify(meta.order)}，仅支持 C/F`);
  }
  if (meta.compressor !== null && !(meta.compressor && meta.compressor.id === 'gzip')) {
    const id = meta.compressor && meta.compressor.id;
    throw new UnsupportedEncodingError(`不支持的压缩器: ${JSON.stringify(id)}，仅支持 gzip 与未压缩(null)`);
  }
  if (meta.filters !== null && !(Array.isArray(meta.filters) && meta.filters.length === 0)) {
    throw new UnsupportedEncodingError('不支持任何 filters（delta/scaleoffset/shuffle 等），仅接受 null 或空数组');
  }
  if (meta.fill_value !== null && typeof meta.fill_value !== 'number') {
    throw new WindowError('fill_value 必须是数值或 null', 'BAD_METADATA');
  }
  return { ...parseDtype(meta.dtype), compressed: meta.compressor !== null };
}

function canonicalFingerprint(meta, dimensions) {
  const canonical = JSON.stringify({ zarray: meta, dimensions: dimensions ?? null });
  return createHash('sha256').update(canonical).digest('hex');
}

async function defaultReadChunk(path) {
  try {
    return await readFile(path);
  } catch (error) {
    // 仅“块不存在”等价于缺省块；其它 IO 错误由调用方统一包装为传输失败
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function mapLimit(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/* ---------------- 切片：[start, stop, step]，NumPy 语义 ---------------- */
export function normalizeSlice(spec, length) {
  // 未提供或 null 表示全量切片；显式空数组表示空选择；[null,null,-1] 照常解析
  if (Array.isArray(spec) && spec.length === 0) return [];
  const entries = spec === undefined || spec === null ? [] : spec;
  if (!Array.isArray(entries) || entries.length > 3) {
    throw new WindowError('切片必须是长度不超过 3 的数组 [start, stop, step]', 'BAD_SLICE');
  }
  let [startRaw, stopRaw, stepRaw] = entries;
  const step = stepRaw === undefined || stepRaw === null ? 1 : stepRaw;
  if (!Number.isInteger(step) || step === 0) {
    throw new WindowError(`切片步长必须是非零整数，收到 ${JSON.stringify(step)}`, 'BAD_SLICE');
  }
  for (const value of [startRaw, stopRaw]) {
    if (value !== undefined && value !== null && !Number.isInteger(value)) {
      throw new WindowError(`切片端点必须是整数或 null，收到 ${JSON.stringify(value)}`, 'BAD_SLICE');
    }
  }
  const indices = [];
  let start; let stop;
  if (step > 0) {
    start = startRaw === undefined || startRaw === null ? 0 : startRaw;
    stop = stopRaw === undefined || stopRaw === null ? length : stopRaw;
    if (start < 0) start += length;
    if (stop < 0) stop += length;
    start = Math.min(Math.max(start, 0), length);
    stop = Math.min(Math.max(stop, 0), length);
    for (let i = start; i < stop; i += step) indices.push(i);
  } else {
    start = startRaw === undefined || startRaw === null ? length - 1 : startRaw;
    stop = stopRaw; // null/undefined 保持哨兵值 -1，不能参与负索引平移
    if (start < 0) start += length;
    if (stop !== undefined && stop !== null) {
      if (stop < 0) stop += length;
      stop = Math.min(Math.max(stop, -1), length - 1);
    } else {
      stop = -1;
    }
    start = Math.min(Math.max(start, -1), length - 1);
    for (let i = start; i > stop; i += step) indices.push(i);
  }
  return indices;
}

class DecodedChunk {
  constructor(key, shape, order, values) {
    this.key = key;
    this.shape = shape;
    this.order = order;
    this.values = values; // 存储顺序（C/F）下的扁平 Float64Array
  }
  at(indices) {
    let offset = 0;
    if (this.order === 'C') {
      // C（行优先）：末维步长为 1
      let stride = 1;
      for (let d = indices.length - 1; d >= 0; d--) {
        offset += indices[d] * stride;
        stride *= this.shape[d];
      }
    } else {
      // F（列优先）：首维步长为 1
      let stride = 1;
      for (let d = 0; d < indices.length; d++) {
        offset += indices[d] * stride;
        stride *= this.shape[d];
      }
    }
    return this.values[offset];
  }
}

export class ZarrWindowStore {
  constructor(metadataPath, io) {
    this.metadataPath = resolve(metadataPath);
    this.directory = dirname(this.metadataPath);
    const custom = io && io.readChunk;
    this.readChunk = custom ? (path) => custom.call(io, path) : defaultReadChunk;
  }

  async open() {
    const loaded = await this.#loadRaw();
    this.#meta = loaded.meta;
    this.#attrs = loaded.attrs;
    this.#encoding = validateMetadata(this.#meta);
    this.#fingerprint = canonicalFingerprint(this.#meta, this.#attrs && this.#attrs.dimensions);
    return this;
  }

  #meta; #attrs; #encoding; #fingerprint;

  get fingerprint() { return this.#fingerprint; }
  get metadata() { return this.#meta; }
  get attributes() { return this.#attrs; }
  get dimensions() { return (this.#attrs && this.#attrs.dimensions) || null; }

  async #loadRaw() {
    let metaText;
    try {
      metaText = await readFile(this.metadataPath, 'utf8');
    } catch (error) {
      throw new WindowError(`无法读取元数据 ${this.metadataPath}: ${error.message}`, 'METADATA_READ_FAILED');
    }
    let meta;
    try { meta = JSON.parse(metaText); }
    catch (error) { throw new WindowError(`元数据不是合法 JSON: ${error.message}`, 'BAD_METADATA'); }
    let attrs = null;
    try {
      attrs = JSON.parse(await readFile(join(this.directory, '.zattrs'), 'utf8'));
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    return { meta, attrs };
  }

  /* 运行中换版：重新读取并比对坐标含义指纹（shape/chunks/dtype/order/fill/维度名） */
  async checkConsistency() {
    const fresh = await this.#loadRaw();
    const freshFingerprint = canonicalFingerprint(fresh.meta, fresh.attrs && fresh.attrs.dimensions);
    if (freshFingerprint !== this.#fingerprint) {
      throw new MetadataChangedError(
        `资料元数据已换版，窗口坐标含义不再一致（旧指纹 ${this.#fingerprint.slice(0, 12)}… 新指纹 ${freshFingerprint.slice(0, 12)}…）`);
    }
    return true;
  }

  #resolveDim(key) {
    const names = this.dimensions;
    if (names) {
      const byName = names.indexOf(key);
      if (byName >= 0) return byName;
    }
    if (/^\d+$/.test(key)) {
      const positional = Number(key);
      if (positional < this.#meta.shape.length) return positional;
    }
    throw new WindowError(`窗口引用了未知维度: ${JSON.stringify(key)}`, 'BAD_SLICE');
  }

  #parseWindow(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new WindowError('窗口必须是按维度命名的切片对象', 'BAD_SLICE');
    }
    const ndim = this.#meta.shape.length;
    const indices = this.#meta.shape.map((length, d) =>
      normalizeSlice(undefined, length));
    for (const [key, slice] of Object.entries(spec)) {
      const d = this.#resolveDim(key);
      indices[d] = normalizeSlice(slice, this.#meta.shape[d]);
    }
    return { spec, indices };
  }

  #chunkKey(chunkCoords) { return chunkCoords.join('.'); }

  async #loadChunk(key) {
    const path = join(this.directory, key);
    let bytes;
    try {
      bytes = await this.readChunk(path);
    } catch (error) {
      // 任何传输错误（权限、网络、IO）都是领取失败，不允许落到缺省补齐
      if (error instanceof WindowError) throw error;
      throw new ChunkReadError(`块传输失败: ${path}（${error && error.code || error.message}）`);
    }
    if (bytes === null) return { missing: true }; // 块不存在：合法缺省，不是失败
    let raw = bytes;
    if (this.#encoding.compressed) {
      try {
        raw = await gunzipAsync(bytes);
      } catch (error) {
        throw new BadChunkError(`块 ${key} gzip 解压失败，按损坏块处理而不是缺省补齐: ${error.message}`);
      }
    }
    const fullCells = this.#meta.chunks.reduce((a, b) => a * b, 1);
    const fullBytes = fullCells * this.#encoding.size;
    if (raw.length > fullBytes) {
      throw new BadChunkError(`块 ${key} 字节数 ${raw.length} 超过完整块容量 ${fullBytes}`);
    }
    if (raw.length % this.#encoding.size !== 0 || raw.length === 0) {
      throw new BadChunkError(`块 ${key} 字节数 ${raw.length} 与单元大小 ${this.#encoding.size} 不匹配`);
    }
    const cells = raw.length / this.#encoding.size;
    // 解码形状从实际字节数推导：C 序边缘块常按边缘尺寸落盘，F 序按完整块容量落盘
    const storageShape = this.#decodeShape(cells);
    const values = new Float64Array(cells);
    const needByteSwap = (this.#encoding.marker === '>' && NATIVE_LITTLE_ENDIAN)
      || (this.#encoding.marker === '<' && !NATIVE_LITTLE_ENDIAN);
    if (this.#encoding.marker === '|' || !needByteSwap) {
      const typed = new this.#encoding.ctor(raw.buffer, raw.byteOffset, cells);
      values.set(typed);
    } else {
      const view = new DataView(raw.buffer, raw.byteOffset, raw.length);
      const littleEndian = !needByteSwap; // 需要换字节序说明数据是大端
      for (let i = 0; i < cells; i++) {
        values[i] = this.#encoding.view(view, i * this.#encoding.size, littleEndian);
      }
    }
    return { missing: false, chunk: new DecodedChunk(key, storageShape, this.#meta.order, values) };
  }

  /* 由实际单元数反推块形状：C 序收缩首维，F 序收缩末维；完整块直接返回 chunks */
  #decodeShape(cells) {
    const chunks = this.#meta.chunks;
    const fullCells = chunks.reduce((a, b) => a * b, 1);
    if (cells === fullCells) return chunks.slice();
    const shape = chunks.slice();
    if (this.#meta.order === 'C') {
      shape[0] = Math.floor(cells / chunks.slice(1).reduce((a, b) => a * b, 1));
      if (shape[0] * chunks.slice(1).reduce((a, b) => a * b, 1) !== cells) {
        throw new BadChunkError('边缘块单元数无法按 C 序形状解释');
      }
    } else {
      const last = chunks.length - 1;
      shape[last] = Math.floor(cells / chunks.slice(0, last).reduce((a, b) => a * b, 1));
      if (shape[last] * chunks.slice(0, last).reduce((a, b) => a * b, 1) !== cells) {
        throw new BadChunkError('边缘块单元数无法按 F 序形状解释');
      }
    }
    return shape;
  }

  /* 一次任务领取多个（可交叠）窗口；块只取一次，窗口结果彼此独立 */
  async claim(windowSpecs) {
    if (!Array.isArray(windowSpecs) || windowSpecs.length === 0) {
      throw new WindowError('claim 需要至少一个窗口', 'BAD_SLICE');
    }
    await this.checkConsistency();
    const parsed = windowSpecs.map(spec => this.#parseWindow(spec));

    const needed = new Set();
    for (const window of parsed) {
      const acc = Array(window.indices.length).fill(0);
      const walk = (d) => {
        if (d === window.indices.length) {
          const chunkCoords = acc.map((_, dim) => Math.floor(window.indices[dim][acc[dim]] / this.#meta.chunks[dim]));
          needed.add(this.#chunkKey(chunkCoords));
          return;
        }
        for (acc[d] = 0; acc[d] < window.indices[d].length; acc[d]++) walk(d + 1);
      };
      walk(0);
    }

    const cache = new Map();
    let chunksLoaded = 0;
    let chunksMissing = 0;
    await mapLimit(needed, 8, async (key) => {
      const entry = await this.#loadChunk(key);
      cache.set(key, entry);
      if (entry.missing) chunksMissing++; else chunksLoaded++;
    });

    // 块取完后再核对一次：期间换版则本批坐标含义已失效，整批拒绝
    await this.checkConsistency();

    const fill = this.#meta.fill_value === null ? 0 : this.#meta.fill_value;
    const results = [];
    let chunkReferences = 0;
    for (const window of parsed) {
      const shape = window.indices.map(axis => axis.length);
      const total = shape.reduce((a, b) => a * b, 1);
      const data = new Float64Array(total);
      const missing = new Uint8Array(total);
      const cursor = Array(shape.length).fill(0);
      let flat = 0;
      const emit = (d) => {
        if (d === shape.length) {
          const logical = cursor.map((_, dim) => window.indices[dim][cursor[dim]]);
          const chunkCoords = logical.map((index, dim) => Math.floor(index / this.#meta.chunks[dim]));
          const key = this.#chunkKey(chunkCoords);
          const entry = cache.get(key);
          chunkReferences++;
          if (entry.missing) {
            data[flat] = fill;
            missing[flat] = 1;
          } else {
            const within = logical.map((index, dim) => index - chunkCoords[dim] * this.#meta.chunks[dim]);
            data[flat] = entry.chunk.at(within);
          }
          flat++;
          return;
        }
        for (cursor[d] = 0; cursor[d] < shape[d]; cursor[d]++) emit(d + 1);
      };
      emit(0);
      results.push({
        window: window.spec,
        dimensions: this.dimensions || shape.map((_, d) => String(d)),
        shape,
        indices: window.indices.map(axis => Array.from(axis)),
        data,
        missing,
        fillValue: this.#meta.fill_value,
        fingerprint: this.#fingerprint,
      });
    }

    return {
      fingerprint: this.#fingerprint,
      windows: results,
      stats: {
        chunksNeeded: needed.size,
        chunksLoaded,
        chunksMissing,
        chunkReferences,
        cacheHits: chunkReferences - chunksLoaded - chunksMissing,
      },
    };
  }
}

export async function openZarrArray(metadataPath, io) {
  return new ZarrWindowStore(metadataPath, io).open();
}
