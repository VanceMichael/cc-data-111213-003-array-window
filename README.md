# 分块观测阵列的逻辑窗口领取

array-window 用于合作资料的本地查看和来源保存。当前版本支持人工触发的整份资料查看、字节级归档，以及按**逻辑数组窗口**领取温度切片：调用方只给出时间维与探头维的切片（支持步长、负索引），块路径、块坐标解码与缺省判断全部在内部完成，不需要自己拼 `0.1` 这类块文件名。资料对象按内容摘要保存，每次领取保留单独回执。自动组织领域资料的能力与人工查看入口分别演进。

## 运行环境

使用 Node.js 22。依赖已锁定；首次准备执行 `npm ci --ignore-scripts`，正式运行无需下载资料或软件。全部样例使用合成数据与本机来源，不连接生产系统。

```bash
npm run check
npm test
npm run demo
```

`npm run demo` 在临时目录实际读取资料、归档并重新核验摘要，依次展示步长切片与负索引、全缺省区域、损坏块失败、不支持编码拒绝、C/F 序与大小端/未压缩等价性、交叠窗口块复用和元数据换版检测，退出时清理临时内容。正常演示应在九十秒内结束。

## 资料操作

```bash
npm start -- inspect fixtures/temperature/.zarray
npm start -- capture fixtures/temperature/.zarray .local/archive
npm start -- list .local/archive
npm start -- claim fixtures/temperature/.zarray fixtures/windows.json .local/archive
```

窗口文件形如 `{ "windows": [ { "time": [0, 5, 2], "sensor": [1, 3, 1] } ] }`，每个切片是 `[start, stop, step]`，遵循 NumPy 语义（`null` 取默认端点，支持负索引与负步长）。`claim` 的每个窗口独立返回逻辑坐标 `indices`、结果形状 `shape`、数值 `data` 与缺失掩码 `missing`，并在归档目录写入一份 `window-claim` 回执。一次任务可领取多个交叠窗口，块数据只读取一次并在任务内复用；连续领取之间不保留整阵列缓存，内存只与命中的块和窗口大小有关，不会先展开整个阵列。

### 缺省、补值与损坏的区分

- 块文件不存在是**合法缺省**：对应单元取元数据 `fill_value`，掩码置 1，不算领取失败。
- 已落盘块内部等于 `fill_value` 的数值是真实写入（例如补值或真实零度），掩码保持 0。文件名里的数字是块坐标而非测点编号，不能当作探头编号使用。
- 传输失败（权限、IO 错误等）与 gzip 解压失败、字节数不符的块是**损坏块**，抛出 `BAD_CHUNK`/`CHUNK_READ_FAILED`，绝不当作缺省块静默补齐。

### 支持与拒绝的编码

支持 Zarr v2、C/F 两种阵列顺序、大小端与 `|` 端序标记，dtype 限 `i1/u1/i2/u2/i4/u4/f4/f8`，压缩限 gzip 或未压缩（`null`），不接受任何 filters。Zarr v3、zstd/blz/lz4 等压缩器、delta/scaleoffset/shuffle 过滤器、8 字节整数、半精度浮点、字符串与固定长度字节等在打开时即以 `UNSUPPORTED_ENCODING` 明确拒绝。非整除边缘块按实际字节数自适应解释（C 序短块、F 序完整容量均可）。

### 元数据换版

打开资料时计算覆盖 `shape/chunks/dtype/order/fill_value/维度名` 的坐标含义指纹；领取前与块读取后各核对一次。运行中元数据换版会抛出 `METADATA_CHANGED`，避免把旧窗口坐标套用到含义已变化的阵列上，每个窗口结果也带有当时的指纹便于追溯。

`capture` 只表示来源字节已保存，不声称领域流程已自动完成。已有查看功能只展示现有资料，不替代业务接纳判断。`scripts/create-fixtures.js` 用于维护者重建合成资料（含主资料、F 序大端 gzip、未压缩 f4 三份等价样例）；运行与测试直接读取已提交的资料。

## 目录约定

- `src/domain.js`：现有领域读取、查看接口与窗口领取登记入口。
- `src/window.js`：逻辑窗口领取核心（切片解析、块调度、解码、掩码、指纹一致性）。
- `src/archive.js`：内容对象、来源回执与完整性检查。
- `fixtures/`：本地资料与领域配置。
- `test/`：已有行为的运行验证，使用独立临时目录。

## Linux 环境

`Dockerfile` 使用 Node.js 22 镜像；浏览器项目使用包含 Chromium 的运行镜像。可执行 `docker build -t array-window:local .` 后运行 `docker run --rm --network none array-window:local npm test`。测试中的 HTTP、MQTT 和门户都仅绑定回环地址；不需要第二个容器。构建阶段准备依赖，运行时不安装依赖。
