# slim-SA-Game-Guide

StoneAge web port slimming guide for building a small, playable, source-faithful
classic package.

This repository is a planning and implementation guide for:

- https://github.com/adwasd-dvd/SA-pet-sim

It does not include original game assets, server data, client binaries, or copied
runtime resources. It only contains strategy, task breakdowns, and example
profile configuration.

## Core Idea

Do not start by manually deleting maps.

The practical slimming path is:

1. Build content profiles from source-data dependency closure.
2. Keep only complete playable quest lines in each profile.
3. Close or hide exits to disabled content.
4. Split the current monolithic client atlas into lazy resource packs.
5. Limit player characters, pets, audio, and advanced systems by profile.

## Documents

- [Full slimming guide](docs/SA_WEB_PORT_SLIMMING_GUIDE.md)
- [中文开发任务书](docs/SA_PET_SIM_SLIMMING_TASKS_ZH.md)
- [贴图拆包与压缩格式方案](docs/TEXTURE_SPLIT_AND_PACK_FORMAT_ZH.md)
- [Example content profile config](profiles/content-profiles.example.json)

## Tools

- `tools/simulate-atlas-packing.mjs`: reads a `tiles.json` atlas manifest and
  reports fill ratio, row-packing waste, compact-manifest size, and large frames.
- `tools/plan-profile-packs.mjs`: reads a `tiles.json` atlas manifest and
  produces a first-pass domain pack plan with estimated pack areas and manifest
  sizes.
- `tools/indexed-png-encoder.mjs`: starter encoder for browser-native indexed PNG
  packs with `PLTE` and `tRNS`.

Example:

```bash
node tools/simulate-atlas-packing.mjs ../SA-pet-sim/public/data/client-tiles/tiles.json
node tools/plan-profile-packs.mjs ../SA-pet-sim/public/data/client-tiles/tiles.json --width=2048
```

## Recommended Profile Shape

- `classic-core`: village start, first pet, shops, hospital, save, equipment,
  low-level encounters, adult ceremony.
- `classic-rebirth`: four proof caves, dark cave, rebirth flow. Optional pack
  until the whole chain is source-complete.
- `classic-advanced-2.0`: hero island, red rex, four sacred stones, golden tiger.
- `classic-advanced-2.5`: Malafiya and spirit king lines.
- `full-dev`: broad developer-only source analysis profile.

## First Implementation Target For SA-pet-sim

1. Add `profiles/content-profiles.json`.
2. Make `scripts/build-classic-content-closure.mjs` obey profile allow/block
   rules.
3. Add `scripts/build-profile.mjs` to emit a real filtered package.
4. Split `public/data/client-tiles/tiles-atlas.png` into profile/domain packs.
5. Make runtime loading read `profile-manifest.json`.
6. Add profile validation and size reports.

## Success Criteria

`classic-core` is good enough when:

- the first-session village loop is playable
- adult ceremony works end to end
- disabled routes close cleanly
- no advanced-region content leaks into the boot package
- missing dependency count is `0`
- boot gzip size is reported and intentionally budgeted
