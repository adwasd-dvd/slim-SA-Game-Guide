# 贴图拆包与压缩格式方案

面向 `SA-pet-sim` 当前资源问题：

- `public/data/client-tiles/tiles-atlas.png` 约 `22.6M`
- `public/data/client-tiles/tiles.json` 约 `1.2M`
- 当前 atlas 是 `4096 x 20314` 的 `RGBA PNG`
- 当前帧数 `5784`
- atlas 总像素约 `83.2M`
- 实际帧像素约 `54.7M`
- 填充率约 `65.7%`

结论：当前包大，不只是因为贴图多，还因为：

1. 所有资源被做进一个大 atlas。
2. atlas 使用 RGBA 真彩 PNG，而原始资源本质上是 8-bit palette/indexed art。
3. packing 是简单横向 row packing，存在约三分之一面积浪费。
4. 运行时一次性加载全 atlas，无法按地图/战斗/宠物懒加载。
5. JSON manifest 字段重复较多，虽然 gzip 后不算最大头，但可以顺手压。

## 当前脚本问题点

`scripts/extract-client-tiles.mjs` 当前流程：

```text
collectTileIds()
  -> read adrn_136.bin records
  -> decode real_136.bin
  -> indexed pixels 转 RGBA
  -> buildAtlas(entries)
  -> encode RGBA PNG
  -> write tiles.json
```

关键问题在这里：

```js
const ATLAS_W = 4096;
...
const rgba = Buffer.alloc(width * height * 4);
...
chunk("IHDR", Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])]))
```

`8, 6` 表示 8-bit RGBA PNG。对石器这种老资源，优先应改成 indexed PNG：

```text
IHDR color type 3
PLTE: 256 色调色板
tRNS: 透明色 alpha
IDAT: 每像素 1 byte palette index
```

浏览器可以直接显示 palette PNG，不需要运行时自己解码。

## 第一阶段方案：Indexed PNG + 分包

这是最推荐先做的方案，收益大，改动风险低。

### 1. 不再生成单体 atlas

输出按 profile/domain 拆分：

```text
public/data/profiles/classic-core/packs/
  ui-field.png
  ui-field.json
  player-4char.png
  player-4char.json
  map-tiles-100.png
  map-tiles-100.json
  npc-field-100.png
  npc-field-100.json
  pets-core-lowlevel.png
  pets-core-lowlevel.json
```

也可以先粗分：

```text
map-tiles-core.png
npc-field-core.png
pets-core.png
player-4char.png
ui-field.png
```

再优化成按地图/区域拆。

### 2. 每个 pack 都用 indexed PNG

`extract-client-tiles.mjs` 不要把 indexed pixels 立刻转 RGBA。保留：

```js
{
  tileId,
  pixels, // Uint8Array, one palette index per pixel
  width,
  height,
  bitmapNo,
  graphicNo,
  xoffset,
  yoffset,
  hit,
  ...
}
```

然后 build atlas 时写入 `Uint8Array atlasIndexes`，最后用 `encodeIndexedPng` 输出。

优点：

- 图片仍然是浏览器原生可解码 PNG
- 每像素从 RGBA 4 byte 输入变成 palette index 1 byte 输入
- 保留原始调色板和透明色
- 不改变渲染层太多，CSS background / canvas 都还能用

### 3. 改 packing

当前 row packing 按原顺序摆放。模拟结果：

| 宽度 | 当前顺序面积 | 按高度排序面积 |
| ---: | ---: | ---: |
| `1024` | `72.9M px` | `59.8M px` |
| `2048` | `76.2M px` | `57.8M px` |
| `4096` | `83.2M px` | `58.0M px` |
| `8192` | `94.8M px` | `59.4M px` |

也就是说，只改排序，不改格式，理论 atlas 面积就能少约 `30%`。

建议：

1. 第一版：entries 按 `height desc, width desc` 排序后 row pack。
2. 第二版：实现 skyline / max-rects bin packing。
3. 第三版：按 domain/map 拆包后，每包独立 packing。

因为 runtime 通过 manifest 找坐标，帧顺序变化不影响渲染。

### 4. compact manifest

当前 `tiles.json`：

- raw: `1,205,637 bytes`
- gzip: `131,379 bytes`

把每帧从对象改成数组后：

- raw: `276,413 bytes`
- gzip: `68,338 bytes`
- brotli: `35,585 bytes`

manifest 不是最大头，但拆包后会有很多小 json，建议顺手压。

推荐格式：

```json
{
  "v": 1,
  "image": "map-tiles-core.png",
  "w": 2048,
  "h": 9000,
  "fields": ["x", "y", "w", "h", "xo", "yo", "hit", "prio", "bitmap", "graphic"],
  "frames": {
    "1001": [0, 0, 64, 48, -32, -24, 0, 0, 369001, 1001]
  }
}
```

或者更紧：

```json
{
  "v": 1,
  "image": "map-tiles-core.png",
  "w": 2048,
  "h": 9000,
  "fields": ["id", "x", "y", "w", "h", "xo", "yo", "hit", "prio", "bitmap", "graphic"],
  "frames": [
    [1001, 0, 0, 64, 48, -32, -24, 0, 0, 369001, 1001]
  ]
}
```

运行时加载后再转成 `Map<number, Frame>`。

## 第二阶段方案：SAPack v1 自定义包

只有当 indexed PNG + 分包还不够小，才做自定义包。

自定义包适合：

- 大型宠物/怪物战斗帧
- 图鉴/战斗才会用的稀疏资源
- 不适合塞进大 atlas 的超大帧

不建议一开始就把地图 tile 做成自定义包，因为地图渲染需要频繁绘制，浏览器原生图片路径更稳。

### SAPack v1 设计

文件：

```text
*.sapack
*.saindex.json.br
```

或者单文件：

```text
SAP1 binary
```

单文件结构：

```text
magic:      4 bytes  "SAP1"
flags:      u32
headerLen:  u32
header:     UTF-8 JSON
palette:    256 * RGBA
chunks:     compressed frame groups
```

header 示例：

```json
{
  "v": 1,
  "kind": "pet-battle",
  "compression": "brotli",
  "pixelFormat": "indexed8",
  "palette": "embedded-rgba256",
  "frames": [
    {
      "id": 101766,
      "bitmap": 321890,
      "graphic": 15404,
      "w": 736,
      "h": 859,
      "xo": -120,
      "yo": -600,
      "chunk": 0,
      "offset": 0,
      "length": 632224
    }
  ]
}
```

chunk 数据：

```text
frame pixels stored as indexed8
optional row-RLE before brotli
chunk compressed with brotli or gzip
```

运行时：

1. fetch `.sapack`
2. parse header
3. decompress selected chunk
4. palette index -> ImageData RGBA
5. createImageBitmap
6. cache by frame id

优点：

- 不需要透明大 atlas 空洞
- 可以只解码当前战斗需要的宠物/敌人
- 对超大帧更友好

缺点：

- 运行时复杂度高
- CPU 解码成本高于浏览器原生 PNG
- CSS background 不能直接用，要走 canvas/ImageBitmap

建议使用范围：

- `pets-*`
- `battle-*`
- `album-*`

不建议第一版用于：

- `ui`
- 高频地图 tile
- NPC field sprites

## 分包索引设计

`profile-manifest.json` 应该告诉 runtime 每个 floor 需要哪些包：

```json
{
  "v": 1,
  "profile": "classic-core",
  "start": { "floor": 1000, "x": 40, "y": 35 },
  "bootPacks": {
    "ui": "packs/ui-field.json",
    "player": "packs/player-4char.json"
  },
  "floors": {
    "1000": {
      "maps": ["maps/1000.ls2map", "client-maps/1000.dat"],
      "packs": ["packs/map-tiles-1000.json", "packs/npc-field-1000.json"],
      "encounterPacks": ["packs/pets-sainasu-low.json"]
    }
  }
}
```

运行时加载：

```js
async function enterFloor(floor) {
  const floorInfo = profile.floors[String(floor)];
  await Promise.all(floorInfo.packs.map(loadPack));
  await loadMapFiles(floorInfo.maps);
  renderFloor(floor);
}

async function startBattle(encounter) {
  await Promise.all(encounter.packIds.map(loadPack));
  openBattle(encounter);
}
```

## 实施顺序

### Step 1: 测量

先加入工具：

```bash
node tools/simulate-atlas-packing.mjs public/data/client-tiles/tiles.json
node tools/plan-profile-packs.mjs public/data/client-tiles/tiles.json --width=2048
```

输出：

- 当前 atlas 面积
- 实际帧面积
- 填充率
- 按高度排序后的预估面积
- 大帧列表
- 粗分 domain pack 的面积、填充率、manifest 压缩体积

`plan-profile-packs.mjs` 只读取 `tiles.json`，所以它无法精确区分 NPC 和宠物。
它的目标是给第一刀拆包排序：

1. `ui-field`
2. `player-core`
3. `map-tiles`
4. `npc-field-or-small-sprites`
5. `large-sprites-sapack-candidate`

后续应接入 `world-data.js` 和 `enemybase*.txt`，把
`large-sprites-sapack-candidate` 精确拆成宠物、boss、NPC 战斗资源。

### Step 2: Compact manifest

先把 `tiles.json` 改成 compact manifest，风险最低。

验收：

- runtime 可以加载 compact manifest
- gzip 后比旧 manifest 小
- 渲染结果一致

### Step 3: Indexed PNG

改 `extract-client-tiles.mjs`：

- 保留 indexed pixels
- build indexed atlas
- `encodeIndexedPng`
- 写 PLTE/tRNS

验收：

- 浏览器能显示 indexed PNG
- 透明色正确
- 地图、NPC、玩家帧显示一致
- PNG 小于 RGBA 版本

### Step 4: Domain split

先粗拆：

- `ui`
- `player`
- `map-tiles`
- `npc-field`
- `pets`

验收：

- boot 不加载 map/pet 全量
- 进入地图前只加载对应 map/npc pack
- 进入战斗前再加载 pet pack

### Step 5: Profile split

把 domain split 放到 profile 下：

```text
public/data/profiles/classic-core/packs/
public/data/profiles/classic-rebirth/packs/
public/data/profiles/classic-advanced-2.0/packs/
```

验收：

- `classic-core` 不含 advanced pack
- disabled warp 不触发 pack miss
- report 输出每个 profile 的 pack 大小

### Step 6: SAPack v1

如果 indexed PNG + 分包后仍然太大，再做。

优先试在：

- `pets-core`
- `pets-rebirth`
- `battle-bosses`

验收：

- 同一批 pet frames，`.sapack + index` 比 PNG pack 小
- 首次战斗解码时间可接受
- 移动端不会明显卡顿

## 推荐结论

第一版不要直接上自定义二进制格式。

最稳路径是：

```text
RGBA 单体 PNG
  -> indexed PNG
  -> compact manifest
  -> domain split
  -> profile split
  -> 对大型稀疏战斗资源尝试 SAPack v1
```

这条路径能最快减少 boot 包，同时保持浏览器渲染简单。
