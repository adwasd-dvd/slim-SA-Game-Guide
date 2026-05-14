# StoneAge Web Port Slimming Guide

This note is for using the local reference project as evidence, then guiding
`SA-pet-sim` toward a small, playable, source-faithful web package.

Target project:

- https://github.com/adwasd-dvd/SA-pet-sim/tree/master
- Inspected commit during this pass: `3a3b747` (`2026-05-14 12:32:22 -0700`)

## Goal

Find the minimum content and resources that still feel like classic StoneAge:

- playable first-session loop
- original visual language and map/pet style
- small web download
- profile-based future expansion
- no broken warps, half quests, or fake replacement content

The key idea: shrink by content dependency closure first, then split resources
into lazy packs. Do not start by manually deleting maps.

## Evidence Snapshot

Local reference project, original-ish full client and server data:

| Area | Size | Meaning |
| --- | ---: | --- |
| `Client-side/ref-full-win-client` | about `2.6G` | full Windows client package |
| `Client-side/ref-full-win-client/data` | about `2.5G` | main client resources |
| `data/real_136.bin` | about `1.53G` | biggest sprite/bitmap data pack |
| `data/wayisa/R00/real.es` | about `700M` | another huge art pack |
| `data/bgm` | about `68M` | WAV music |
| `Client-side/ref-full-win-client/map` | about `68M` | client visual map DAT files |
| `Server-side/clean-data` | about `69M` | clean server data |
| `Server-side/clean-data/gmsv-data/data/map` | about `25.8M` | server logic maps |
| `Server-side/clean-data/gmsv-data/data/npc` | about `2.46M` | NPC scripts/config |

Conclusion: the largest cost is client art packaging, not server maps or gameplay
code. Map pruning matters, but atlas/pet/player/resource packaging matters more.

`SA-pet-sim` current baseline:

| Area | Size / Count | Meaning |
| --- | ---: | --- |
| repo checkout | about `101M` | already much smaller than full client |
| `public/` | about `63.5MiB raw`, `25.9MiB gzip-estimated` | current shipped frontend/data surface |
| shared public assets | about `28.4MiB raw`, `21.9MiB gzip-estimated` | not yet profile-filtered |
| `public/data/client-tiles/tiles-atlas.png` | about `22.6M` | current largest web asset |
| current floors | `260` | full-dev generated world |
| current NPCs | `2353` | full-dev generated world |
| classic-core estimate | `134` floors, `1590` NPCs | closure estimate, not full runtime pruning yet |
| estimated classic-core saving | `14.9MiB raw`, `1.6MiB gzip` | low gzip saving because shared atlas is still monolithic |

Conclusion: `SA-pet-sim` already has the right foundation. The next win is making
profile pruning real and splitting `tiles-atlas.png` by domain/profile.

## Non-Negotiables

For a faithful web port profile:

- keep original maps, NPC names, pets, enemies, and items when enabled
- keep a quest either complete or closed
- close or hide disabled entrances instead of linking to empty/missing maps
- do not use a global map-count cap as design
- do not ship unopened maps just because they exist
- do not invent replacement art when original resources exist
- keep advanced/later-version content as optional packs

For a deliberate lightweight remix profile, it is acceptable to shorten caves or
rewrite routing, but label that profile differently, for example
`classic-lite-remix`. Do not mix this with the source-faithful profile.

## Recommended Profiles

### `classic-core`

First playable old-school package.

Keep:

- start in classic village flow: 渔村 / 萨姆吉尔村
- first pet capture and training loop
- core shops: item, weapon, pet, meat, hospital, save
- equipment and simple item usage
- adult ceremony as first real milestone
- representative low-to-mid level encounters
- classic pet families needed by enabled maps plus a small iconic set

Do not include by default:

- 伊甸, 瑞尔亚斯, longzoro, holiday/event maps
- family/manor content
- casino, race, quiz, arena-only interiors
- profession/high-tech systems
- fusion/cooking unless a chosen source-complete quest requires them

Important current issue in `SA-pet-sim`: `classic-village-service-loops` is too
broad because it matches generic shop/hospital terms across later regions. Add
region allow-lists so core shop closure does not pull EDEN/Ruieryashi/longzoro
service floors into `classic-core`.

### `classic-rebirth`

Classic 1.82-like endgame spine.

Keep only when complete:

- 琉璃洞窟
- 玄黄洞窟
- 碧青洞窟
- 深红洞窟
- 漆黑洞窟
- 转生 NPC/boss/reward chain

Current closure pressure:

| Line | Source-only floors in current manifest |
| --- | ---: |
| 琉璃洞窟 | `16` |
| 玄黄洞窟 | `15` |
| 碧青洞窟 | `19` |
| 深红洞窟 | `16` |
| 漆黑洞窟 / 人物转生 | `21` |

Faithful path: import and validate the full chain, then ship as an optional pack
or gated profile.

Remix path: create `classic-lite-remix` and shorten caves by rule:

- entrance floor
- one signature ecology/enemy floor
- task/NPC/boss floor
- exit/top/final floor

Only use this path if the project intentionally becomes a lightweight remake
rather than a faithful port.

### `classic-side`

Optional old-memory side tasks after core is stable.

Good candidates:

- 伐木任务
- 小猪爱情故事
- 恐龙博士
- 亚姆的斧头
- 阿布洞窟
- 强盗洞穴
- JOT / SOT, only when locally source-complete

### `classic-advanced-2.0`

Optional pack after core/rebirth.

Keep:

- 英雄岛
- 红暴
- 四圣石
- 金虎

Current estimate is small in map bytes, but pet/battle art dependencies still
need validation.

### `classic-advanced-2.5`

Optional pack after 2.0.

Keep:

- 玛蕾菲雅
- 精灵王 / 精灵少女 / 黑暗精灵王 lines

Do not let this leak into `classic-core`.

### `full-dev`

Developer-only analysis profile.

Keep broad source data here so future content can be staged, but never use it as
the default web package.

## Slimming Path For `SA-pet-sim`

### Phase 1: Make Profile Pruning Real

Current scripts already estimate profile size:

- `scripts/build-classic-content-closure.mjs`
- `scripts/report-classic-core-package.mjs`
- `docs/planning/CLASSIC_CORE_CONTENT_PROFILE.md`
- `docs/planning/CLASSIC_CORE_CLOSURE_MANIFEST.md`
- `docs/planning/CLASSIC_CORE_PACKAGE_REPORT.md`

Next change: generate a real profile output directory, not just reports.

Recommended output shape:

```text
dist-profiles/
  classic-core/
    index.html
    assets/
    data/
      world-data.js
      profile-manifest.json
      maps/
      client-maps/
      packs/
  classic-rebirth/
  classic-advanced-2.0/
  classic-advanced-2.5/
```

Recommended public URL shape:

```text
/data/profiles/classic-core/profile-manifest.json
/data/profiles/classic-core/world-data.js
/data/profiles/classic-core/maps/100.ls2map
/data/profiles/classic-core/client-maps/100.dat
/data/profiles/classic-core/packs/map-tiles-core.png
/data/profiles/classic-core/packs/map-tiles-core.json
/data/profiles/classic-core/packs/npc-field-core.png
/data/profiles/classic-core/packs/npc-field-core.json
/data/profiles/classic-core/packs/pets-core.png
/data/profiles/classic-core/packs/pets-core.json
/data/profiles/classic-core/packs/player-4char.png
/data/profiles/classic-core/packs/player-4char.json
/data/profiles/classic-core/packs/ui-field.png
/data/profiles/classic-core/packs/ui-field.json
```

Add commands:

```json
{
  "build:profile:classic-core": "SA_CONTENT_PROFILE=classic-core node scripts/build-profile.mjs",
  "build:profile:rebirth": "SA_CONTENT_PROFILE=classic-rebirth node scripts/build-profile.mjs",
  "report:profiles": "node scripts/report-profiles.mjs"
}
```

`build-profile.mjs` should:

- read the closure manifest
- copy only enabled `maps/*.ls2map`
- copy only enabled `client-maps/*.dat`
- generate a profile-filtered `world-data.js`
- write closed-exit records for disabled warp targets
- write `profile-manifest.json` with asset pack URLs and sizes
- fail on missing map/NPC/item/enemy/pet dependencies

### Phase 2: Split The Atlas

Current `scripts/extract-client-tiles.mjs` builds one monolithic atlas from map
tiles, NPC graphics, encounter pets, field UI, and player frames.

Change it to accept a resource keep-set:

```text
scripts/extract-client-tiles.mjs
  --profile classic-core
  --domain map-tiles
  --domain npc-field
  --domain pets
  --domain player
  --domain ui
```

Resource domains:

| Domain | Keep rule | Loading |
| --- | --- | --- |
| `map-tiles` | tile IDs used by enabled maps/client-maps | load by map/region |
| `npc-field` | NPC graphics used by enabled floors/scripts | load by map/region |
| `pets` | enemybase image IDs from enabled encounters/NPC battles plus iconic set | load before battle/album |
| `player` | only selected player bodies and required actions | load at character select/field |
| `ui` | field cursor, talk marker, window basics | boot |
| `audio` | only enabled region/battle tracks, converted from WAV | lazy by region/battle |

Expected first-pass cuts:

- player choice from many bodies to `4` classic bodies
- pets only from enabled encounters plus iconic keep-list
- no advanced/event/fusion pets in boot package
- no all-region tile atlas in `classic-core`

### Phase 3: Fix Content Closure Over-Inclusion

Add content profile config instead of only text terms.

Suggested file:

```text
profiles/content-profiles.json
```

Suggested shape:

```json
{
  "classic-core": {
    "allowedRegions": ["sainasu", "jyaruga"],
    "allowedFloorRanges": [
      [100, 199],
      [1000, 1499],
      [2000, 4999]
    ],
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
    "iconicPetFamilies": ["乌力", "布伊", "加美", "凯比", "人龙", "火鸡", "老虎", "暴龙"]
  }
}
```

The exact floor ranges should be generated from local map metadata, not guessed
forever. The config is a guardrail so generic terms like `医院` do not pull every
late-region hospital into core.

### Phase 4: Runtime Loading Contract

In `public/assets/app.js`, move from global asset assumptions to a profile
manifest:

```js
const profile = await fetch("/data/profiles/classic-core/profile-manifest.json").then((r) => r.json());
await loadPack(profile.bootPacks.ui);
await loadPack(profile.bootPacks.player);
await loadMap(profile.start.floor);
```

Rules:

- entering a map loads that map's tile/NPC packs
- battle start loads required pet/enemy pack
- opening album loads pet portrait pack on demand
- disabled warp shows source-style closed behavior
- missing pack is a hard validation error in dev, soft closed content in prod

### Phase 5: Validation Gates

Keep these existing checks:

```bash
npm run closure:classic-core
npm run report:classic-core
npm run check:maps
npm run check:movement
npm run check:npc
npm run check:resources
```

Add profile gates:

```bash
npm run build:profile:classic-core
npm run check:profile -- classic-core
npm run report:profiles
```

`check:profile` should fail if:

- enabled quest references missing map/NPC/item/enemy/pet
- enabled warp points outside the profile without a closed-exit record
- enabled battle references missing pet/enemy art
- enabled NPC uses blocked systems in the profile
- profile includes source-only floors not imported into generated world
- atlas pack misses a frame referenced by profile runtime

## Keep / Cut Decision Matrix

Score every content unit: quest, map, NPC, pet, item, or system.

| Question | Keep signal |
| --- | --- |
| Is it required for first-session play? | strong keep |
| Is it part of adult ceremony or core progression? | strong keep |
| Does it unlock rebirth or classic milestone memory? | keep, but maybe staged |
| Is the map reused by multiple enabled tasks? | keep |
| Does it contain unique NPC/boss/reward logic? | keep |
| Does it introduce only late-version systems? | cut from core |
| Is it an isolated side task with poor reward and unique maps? | stage or cut |
| Is it an event/holiday/GP/fusion-era pet? | cut from core |
| Is it unused by enabled encounters and not iconic? | cut from boot assets |

Default actions:

- `keep`: included in current profile
- `stage`: optional future profile or lazy pack
- `close`: source exists, entrance disabled in current profile
- `drop-from-boot`: resource can exist but is not downloaded at startup

## System Decisions

Keep in `classic-core`:

- movement/collision
- map transitions
- NPC talk/window basics
- shops
- hospital/heal
- save point
- item/equipment basics
- first pet capture/training
- turn-based battle basics
- simple quest flags

Stage or cut from `classic-core`:

- profession/class skills
- high-tech/later-version systems
- pet fusion
- cooking/synthesis
- casino/gambling
- manor/family war
- racing
- quiz rooms
- advanced arenas
- event-only scripts

Cooking and synthesis can be kept as source data but blocked in core by closing
training-room entrances or omitting those NPCs from the profile.

## Pet And Player Art Rules

Player characters:

- ship `4` bodies in core, not every original selectable body
- include only field stand/walk and required basic action frames first
- add battle/action frames only when battle display uses them

Pets:

- include all enemybase image IDs used by enabled encounters/NPC battles
- add an iconic keep-list for classic memory pets
- do not ship every family member in boot
- stage event, GP, fusion-era, "改" variants, and late-version pets

Classic pet families worth keeping early:

- 乌力系
- 布伊系
- 加美系
- 凯比系
- 人龙系
- 火鸡系
- 老虎系
- 暴龙系
- 雷龙系 if encounter/progression requires it
- cave/ecology pets needed by enabled caves

## Audio Rules

Original BGM is WAV and about `68M` in the local full client.

For web:

- convert chosen tracks to Opus or AAC
- load by region/battle, not boot
- keep only a few core tracks in `classic-core`
- stage advanced-region music with advanced profiles

## Map Strategy

Faithful port:

- do not edit floor count or map structure
- include only complete quest/resource closure
- close disabled exits

Lightweight remix:

- create separate `classic-lite-remix`
- allow cave shortening by explicit floor-role audit
- keep original visual tiles where possible
- document every removed floor and why

Floor-role audit fields:

```text
floor
name
line
role: entrance | route | unique-encounter | task-npc | boss | exit | duplicate-route
hasUniqueNpc
hasQuestFlag
hasReward
hasUniqueEncounter
mapBytes
clientMapBytes
decision: keep | merge-route | close | stage
reason
```

## Immediate Task List For `SA-pet-sim`

1. Add `profiles/content-profiles.json`.
2. Restrict `classic-core` service/shop closure to core regions.
3. Split `classic-rebirth` out of default core unless the full four-cave/dark-cave chain is generated and validated.
4. Add `scripts/build-profile.mjs`.
5. Add `dist-profiles/<profile>` or `public/data/profiles/<profile>` output.
6. Refactor `extract-client-tiles.mjs` into profile/domain atlas generation.
7. Add `profile-manifest.json` runtime loading.
8. Add profile validation gates.
9. Add a report comparing full-dev, classic-core, classic-rebirth, 2.0, and 2.5.
10. Only after those reports exist, decide whether a separate `classic-lite-remix` should shorten caves.

## Recommended Development Order

First milestone: tiny playable village.

- `classic-core` includes 萨姆吉尔 / 渔村 start, shops, hospital, save, first pet, low-level encounters
- boot resources under a fixed budget, for example `10-15MiB gzip`
- no rebirth yet

Second milestone: adult ceremony.

- complete source flow
- quest flags and rewards verified
- closed exits for non-core content

Third milestone: atlas split.

- remove monolithic `tiles-atlas.png` from boot
- load map/NPC/pet/player packs lazily
- report per-pack size

Fourth milestone: rebirth pack.

- import missing cave floors
- validate four proof caves and dark cave
- ship as optional profile or expansion pack

Fifth milestone: advanced packs.

- 2.0 memory pack
- 2.5 memory pack

## Success Criteria

A profile is ready when it can report:

- floor count
- map bytes and gzip bytes
- client DAT bytes and gzip bytes
- world model bytes and gzip bytes
- NPC/script count
- item count
- enemy group and enemy count
- pet/picture/frame count
- player frame count
- atlas pack sizes
- closed exits count
- missing dependency count is `0`

For `classic-core`, the desired shape is:

- small boot package
- complete first-session loop
- no advanced-region leakage
- original art and style
- every disabled route closed cleanly
- source evidence for every enabled quest/map/pet

