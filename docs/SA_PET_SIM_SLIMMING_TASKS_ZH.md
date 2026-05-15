# SA-pet-sim 瘦身开发任务书

面向项目：

- https://github.com/adwasd-dvd/SA-pet-sim/tree/master
- 本次参考的远端提交：`3a3b747`

更完整的策略说明见：

- `docs/SA_WEB_PORT_SLIMMING_GUIDE.md`

## 一句话结论

不要先手工删地图。先做“内容闭包 profile”，再做“资源分包 + 懒加载”。

本地证据显示，原始客户端最大体积来自美术资源包：

- `real_136.bin` 约 `1.53G`
- `wayisa/R00/real.es` 约 `700M`
- 原始客户端 `data/` 约 `2.5G`
- 服务端地图数据约 `25.8M`

所以真正的瘦身路径是：

1. 明确 `classic-core` 到底启用哪些任务/地图/NPC/宠物。
2. 没启用的地图入口关闭，不打进默认包。
3. 把现在单体的 `tiles-atlas.png` 拆成按 profile/domain 加载的资源包。
4. 玩家人物、宠物、音频都按启用内容收敛。

## 当前 SA-pet-sim 基线

现有项目已经有正确基础：

- `scripts/build-classic-content-closure.mjs`
- `scripts/report-classic-core-package.mjs`
- `docs/planning/CLASSIC_CORE_CONTENT_PROFILE.md`
- `docs/planning/CLASSIC_CORE_CLOSURE_MANIFEST.md`
- `docs/planning/CLASSIC_CORE_PACKAGE_REPORT.md`

目前报告里的关键数字：

| 项 | 当前 |
| --- | ---: |
| `public/` | 约 `63.5MiB raw / 25.9MiB gzip` |
| `tiles-atlas.png` | 约 `22.6M` |
| full-dev 地图 | `260` 层 |
| classic-core 估算地图 | `134` 层 |
| full-dev NPC | `2353` |
| classic-core 估算 NPC | `1590` |

问题是：现在主要还是“估算和报告”，还没有真正输出一个被裁剪后的 profile 包。

## 内容 Profile 设计

### `classic-core`

默认启动包，只放第一阶段可玩内容。

保留：

- 渔村 / 萨姆吉尔村启动体验
- 第一次抓宠
- 商店、医院、存点、装备、肉店、宠物店
- 基础练级和低级遇敌
- 成人仪式
- 经典宠物族群的必要成员和少量代表成员

默认不放：

- 伊甸
- 瑞尔亚斯
- longzoro
- 家族/庄园
- 赌场、赛宠、猜谜、竞技场房间
- 职业、高科技
- 合成、料理
- 后期活动宠、GP 宠、融合时代宠

### `classic-rebirth`

转生包，先不要塞进默认 `classic-core`。

保留条件：四洞 + 漆黑洞窟 + 转生链条完整可玩。

当前闭包压力：

| 任务线 | 当前 source-only 楼层 |
| --- | ---: |
| 琉璃洞窟 | `16` |
| 玄黄洞窟 | `15` |
| 碧青洞窟 | `19` |
| 深红洞窟 | `16` |
| 漆黑洞窟 / 人物转生 | `21` |

如果做忠实移植，不要砍层数，先作为可选包完整导入和验证。

如果以后决定做轻量复刻，另开 `classic-lite-remix`，不要和忠实 profile 混在一起。

### `classic-advanced-2.0`

后续可选包：

- 英雄岛
- 红暴
- 四圣石
- 金虎

### `classic-advanced-2.5`

更后续的可选包：

- 玛蕾菲雅
- 精灵王 / 精灵少女 / 黑暗精灵王

## 第一批必须改的文件

### 1. 新增 profile 配置

新增：

```text
profiles/content-profiles.json
```

建议结构：

```json
{
  "classic-core": {
    "allowedRegions": ["sainasu", "jyaruga"],
    "blockedRegions": ["EDEN", "ruieryashi", "longzoro", "moon"],
    "enabledLines": [
      "classic-village-start",
      "classic-village-service-loops",
      "first-pet-capture-training",
      "adult-ceremony"
    ],
    "blockedSystems": [
      "profession",
      "petfusion",
      "cook",
      "family",
      "casino",
      "race",
      "quiz"
    ],
    "playerBodies": ["SPR_001em"],
    "playerBodyLimit": 4,
    "iconicPetFamilies": ["乌力", "布伊", "加美", "凯比", "人龙", "火鸡", "老虎", "暴龙"]
  },
  "classic-rebirth": {
    "extends": "classic-core",
    "enabledLines": [
      "glass-cave-proof",
      "yellow-cave-proof",
      "blue-cave-proof",
      "red-cave-proof",
      "dark-cave-rebirth"
    ]
  }
}
```

目的：防止 `医院`、`宠物店`、`武器店` 这种泛词把所有后期区域的商店都吸进 `classic-core`。

### 2. 改闭包脚本

修改：

```text
scripts/build-classic-content-closure.mjs
```

要求：

- 读取 `profiles/content-profiles.json`
- 每条 content line 除了文本匹配，还要受 `allowedRegions` / `blockedRegions` 约束
- `classic-core` 不能因为泛词拉入 EDEN、瑞尔亚斯、longzoro
- blocked system 的 NPC/script 不进入 core
- 输出每个被关闭的入口列表

验收：

```bash
npm run closure:classic-core
npm run report:classic-core
```

报告里应该能看到：

- `classic-core` 地图数下降
- 后期服务类内饰不再进入 core
- disabled/closed exits 数量明确

### 3. 新增真正的 profile 构建脚本

新增：

```text
scripts/build-profile.mjs
```

它要做的事：

- 根据 closure manifest 拿到当前 profile 的 floor 列表
- 只复制启用的 `maps/*.ls2map`
- 只复制启用的 `client-maps/*.dat`
- 生成 profile 过滤后的 `world-data.js`
- 生成 `profile-manifest.json`
- 记录关闭入口
- 如果缺地图、缺 NPC、缺敌人、缺宠物图，直接失败

建议输出：

```text
public/data/profiles/
  classic-core/
    profile-manifest.json
    world-data.js
    maps/
    client-maps/
    packs/
```

`package.json` 新增：

```json
{
  "build:profile:classic-core": "SA_CONTENT_PROFILE=classic-core node scripts/build-profile.mjs",
  "build:profile:rebirth": "SA_CONTENT_PROFILE=classic-rebirth node scripts/build-profile.mjs"
}
```

### 4. 拆 `tiles-atlas.png`

修改：

```text
scripts/extract-client-tiles.mjs
```

现在它会把地图 tile、NPC、宠物、UI、玩家帧都放进一个大 atlas。要改成按 domain 输出：

```text
public/data/profiles/classic-core/packs/
  map-tiles-core.png
  map-tiles-core.json
  npc-field-core.png
  npc-field-core.json
  pets-core.png
  pets-core.json
  player-4char.png
  player-4char.json
  ui-field.png
  ui-field.json
```

资源规则：

| 包 | 保留规则 | 加载时机 |
| --- | --- | --- |
| `map-tiles` | 当前 profile 地图实际用到的 tile ID | 进地图前 |
| `npc-field` | 当前地图/NPC 脚本用到的 NPC 图 | 进地图前 |
| `pets` | 启用遇敌/NPC 战斗用到的宠物图 + 经典保留名单 | 战斗/图鉴前 |
| `player` | 只保留 4 个核心人物和必要动作 | 启动/选人 |
| `ui` | 鼠标、窗口、对话基础 UI | 启动 |

先新增一个 keep-set 生成步骤，再做真正的 atlas builder：

```bash
node tools/build-texture-keep-set.mjs public/data/client-tiles/tiles.json \
  --world=src/world-data.js \
  --enemybase=public/data/enemybase2.txt \
  --closure=docs/planning/classic-core-closure-manifest.json \
  --profile=classic-core \
  --maps=public/data/maps \
  --client-maps=public/data/client-maps \
  --out=public/data/profiles/classic-core/texture-keep-set.json
```

当前 `classic-core` keep-set 结论：

- 总保留 ID：`4,694`，其中 atlas 已存在 `4,690`，缺 `4` 个遇敌图。
- `map-tiles` 独占 `4,363` 个 ID、约 `41.98M` 帧像素，是最大头。
- `ui + player` 只有 `108` 个 ID、约 `0.34M` 帧像素，可以安全放 boot。
- 因此不要做一个巨大的 `map-tiles-core.png`；应按 floor/region 继续切。

然后生成 pack plan：

```bash
node tools/plan-texture-packs.mjs public/data/client-tiles/tiles.json \
  public/data/profiles/classic-core/texture-keep-set.json \
  --start-floor=1000 \
  --out=public/data/profiles/classic-core/profile-texture-pack-plan.json
```

第一版打包器直接消费 `profile-texture-pack-plan.json` 里的 `packs[].ids`：

- `boot-ui-field`
- `boot-player-core`
- `map-tiles-shared-core`
- `map-tiles-region-1000`
- `floor-1000-map-delta`
- `npc-field-core`
- `pets-encounter-core`

当前实测：boot 只需约 `0.34M` 帧像素；进入起始楼层 `1000` 需要约 `10.4M`
帧像素，约为全 atlas 帧面积的 `19.02%`。这比加载全量 atlas 明显更适合作为
web 首屏路径。

接着用桥接版 builder 先输出 RGBA 分包：

```bash
node tools/build-texture-packs-from-atlas.mjs \
  public/data/client-tiles/tiles-atlas.png \
  public/data/client-tiles/tiles.json \
  public/data/profiles/classic-core/profile-texture-pack-plan.json \
  --out-dir=public/data/profiles/classic-core/packs \
  --report=public/data/profiles/classic-core/texture-pack-build-report.json \
  --verify-output
```

桥接版不解决 indexed PNG，但能先让 runtime 从“单体 atlas”切到“profile
分包 atlas”。在当前基线上，起始楼层 `1000` 的 6 个必要包合计 PNG 约
`4.5M`，相比 `tiles-atlas.png` 的 `22.6M` 已经能验证首屏瘦身方向。

再补两道校验：

```bash
node tools/validate-profile-packs.mjs \
  public/data/client-tiles/tiles.json \
  public/data/profiles/classic-core/texture-keep-set.json \
  public/data/profiles/classic-core/profile-texture-pack-plan.json \
  --packs-dir=public/data/profiles/classic-core/packs \
  --report=public/data/profiles/classic-core/validate-profile-packs-report.json
```

```bash
node tools/compare-pack-rendering.mjs \
  public/data/client-tiles/tiles-atlas.png \
  public/data/client-tiles/tiles.json \
  public/data/profiles/classic-core/profile-texture-pack-plan.json \
  --packs-dir=public/data/profiles/classic-core/packs \
  --report=public/data/profiles/classic-core/compare-pack-rendering-report.json
```

第二个命令默认会做逐帧像素对比；如果包里有像素差异，进程会非 0 退出。

第一轮目标：

- boot 不再加载全量 `tiles-atlas.png`
- 玩家人物从全量缩到 4 个
- 未启用地图/任务不会带入宠物图
- 后期宠物、活动宠、融合宠不在 core boot

### 5. 改运行时加载

修改：

```text
public/assets/app.js
```

从固定加载全局资源改成读取 profile manifest：

```js
const profile = await fetch("/data/profiles/classic-core/profile-manifest.json").then((r) => r.json());
await loadPack(profile.bootPacks.ui);
await loadPack(profile.bootPacks.player);
await loadMap(profile.start.floor);
```

规则：

- 进入地图时加载地图 tile 包和 NPC 包
- 进入战斗前加载 pet/enemy 包
- 打开图鉴时再加载图鉴相关宠物图
- warp 指向未启用地图时，显示“暂未开放/入口关闭”，不能跳空图

### 6. 新增 profile 验证

新增：

```text
scripts/check-profile.mjs
scripts/report-profiles.mjs
```

`check-profile` 必须检查：

- 启用任务没有缺地图
- 启用 NPC 没有缺脚本
- 启用遇敌没有缺 enemy/pet art
- warp 指向未打包地图时必须有 closed-exit 记录
- blocked system 没有漏进 core
- atlas pack 中存在所有 runtime 会用到的 frame

`report-profiles` 输出对比：

- full-dev
- classic-core
- classic-rebirth
- classic-advanced-2.0
- classic-advanced-2.5

每个 profile 至少报告：

- 地图数
- NPC 数
- map bytes / gzip
- client map bytes / gzip
- world-data bytes / gzip
- pet frame 数
- player frame 数
- atlas 包大小
- closed exits 数
- missing dependency 数

## 优先级

第一优先级：

1. 新增 `profiles/content-profiles.json`
2. 限制 `classic-core` 不拉后期区域商店/医院
3. 生成真正的 `public/data/profiles/classic-core`

第二优先级：

4. 拆 `tiles-atlas.png`
5. 玩家人物限制到 4 个
6. 宠物图按遇敌/战斗闭包保留

第三优先级：

7. `classic-rebirth` 单独成包
8. 导入并验证四洞 + 漆黑洞窟
9. 再决定是否做 `classic-lite-remix`

## 砍内容规则

保留：

- 第一小时能体验到的内容
- 成人仪式
- 多个任务复用的地图
- 有关键 NPC、奖励、boss、任务 flag 的地图
- 启用遇敌和战斗需要的宠物
- 经典辨识度高的宠物族群

不进 core：

- 没有核心任务依赖的后期区域
- 奖励很差且独占地图的支线
- 职业、高科技、料理、合成
- 家族、庄园、赌场、赛宠、猜谜
- 活动宠、GP 宠、融合时代宠、后期变体宠

## 洞窟怎么处理

忠实移植：

- 不砍楼层
- 四洞和漆黑完整做成 `classic-rebirth`
- 没完整前不要进入默认 core

轻量复刻：

- 另开 `classic-lite-remix`
- 每个洞只留：入口层、特色生态/敌人层、任务/boss 层、出口/顶层
- 必须输出删层说明，不伪装成原版忠实移植

## 最小可玩验收

`classic-core` 第一版合格标准：

- 可以进入萨姆吉尔/渔村
- 可以走地图、碰撞正常
- 可以和核心 NPC 对话
- 可以买卖/治疗/存点
- 可以抓第一只宠
- 可以打低级遇敌
- 可以做成人仪式
- 未开放入口不会跳坏图
- boot gzip 体积有明确报告
- `missing dependency = 0`
