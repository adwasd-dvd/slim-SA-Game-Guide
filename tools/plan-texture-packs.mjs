import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const atlasPath = positional[0];
const keepSetPath = positional[1];
const packWidth = Number(getArg("--width") || 2048);
const startFloor = Number(getArg("--start-floor") || 1000);
const mapBucketSize = Number(getArg("--map-bucket-size") || 1000);
const regionFloorThreshold = Number(getArg("--region-floor-threshold") || 3);
const outPath = getArg("--out");

if (!atlasPath || !keepSetPath) {
  console.error([
    "Usage: node tools/plan-texture-packs.mjs path/to/tiles.json path/to/texture-keep-set.json",
    "  [--width=2048]",
    "  [--start-floor=1000]",
    "  [--shared-floor-threshold=auto]",
    "  [--map-bucket-size=1000]",
    "  [--region-floor-threshold=3]",
    "  [--out=profile-texture-pack-plan.json]"
  ].join("\n"));
  process.exit(1);
}

const atlas = JSON.parse(fs.readFileSync(atlasPath, "utf8"));
const keepSet = JSON.parse(fs.readFileSync(keepSetPath, "utf8"));
const frameById = new Map(Object.values(atlas.frames || {}).map((frame) => [Number(frame.tileId ?? frame.id), normalizeFrame(frame)]));
const floorIds = Object.keys(keepSet.floorDetails || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
const sharedFloorThreshold = Number(getArg("--shared-floor-threshold") || Math.max(8, Math.ceil(floorIds.length * 0.2)));
const profileId = keepSet.source?.profileId || "profile";

const mapUsage = countFloorUsage(floorIds, (floor) => keepSet.floorDetails[String(floor)]?.mapTileIds || []);
const sharedMapIds = [...mapUsage.entries()]
  .filter(([, count]) => count >= sharedFloorThreshold)
  .map(([id]) => id)
  .sort((a, b) => a - b);
const sharedMapIdSet = new Set(sharedMapIds);
const bucketFloors = groupFloorsByBucket(floorIds, mapBucketSize);
const regionMapIdsByBucket = buildRegionMapIdsByBucket({ bucketFloors, sharedMapIdSet });
const regionMapIdSets = Object.fromEntries(
  Object.entries(regionMapIdsByBucket).map(([bucket, ids]) => [bucket, new Set(ids)])
);

const sharedPackIds = [];
const packs = [
  packRecord({
    id: "boot-ui-field",
    domain: "ui-field",
    load: "boot",
    ids: keepSet.domains?.["ui-field"]?.ids || []
  }),
  packRecord({
    id: "boot-player-core",
    domain: "player-core",
    load: "boot",
    ids: keepSet.domains?.["player-core"]?.ids || []
  }),
  packRecord({
    id: "npc-field-core",
    domain: "npc-field",
    load: "enter-floor-shared",
    ids: keepSet.domains?.["npc-field"]?.ids || []
  }),
  packRecord({
    id: "pets-encounter-core",
    domain: "pets-encounter",
    load: "battle-or-album",
    ids: keepSet.domains?.["pets-encounter"]?.ids || []
  })
];
sharedPackIds.push("npc-field-core");

if (sharedMapIds.length) {
  packs.push(packRecord({
    id: "map-tiles-shared-core",
    domain: "map-tiles",
    load: "enter-floor-shared",
    ids: sharedMapIds
  }));
  sharedPackIds.unshift("map-tiles-shared-core");
}

for (const [bucket, ids] of Object.entries(regionMapIdsByBucket)) {
  if (!ids.length) continue;
  packs.push(packRecord({
    id: `map-tiles-region-${bucket}`,
    domain: "map-tiles",
    load: "enter-region",
    region: bucket,
    ids
  }));
}

const floorPacks = {};
for (const floor of floorIds) {
  const detail = keepSet.floorDetails[String(floor)] || {};
  const bucket = String(bucketForFloor(floor, mapBucketSize));
  const regionMapIds = regionMapIdSets[bucket] || new Set();
  const mapDeltaIds = uniqueSorted((detail.mapTileIds || []).filter((id) => {
    const number = Number(id);
    return !sharedMapIdSet.has(number) && !regionMapIds.has(number);
  }));
  const floorPackIds = [...sharedPackIds];
  if (regionMapIds.size) floorPackIds.push(`map-tiles-region-${bucket}`);
  if (mapDeltaIds.length) {
    const packId = `floor-${floor}-map-delta`;
    packs.push(packRecord({
      id: packId,
      domain: "map-tiles",
      load: "enter-floor",
      floor,
      region: bucket,
      ids: mapDeltaIds
    }));
    floorPackIds.push(packId);
  }
  if ((detail.encounterImageNos || []).length) floorPackIds.push("pets-encounter-core");
  floorPacks[String(floor)] = {
    packs: floorPackIds,
    mapTileIds: detail.mapTileIds?.length || 0,
    mapDeltaIds: mapDeltaIds.length,
    npcGraphicIds: detail.npcGraphicIds?.length || 0,
    encounterImageNos: detail.encounterImageNos?.length || 0,
    missingIds: detail.missingIds || []
  };
}

const bootPackIds = ["boot-ui-field", "boot-player-core"];
const startFloorPacks = floorPacks[String(startFloor)]?.packs || sharedPackIds;
const startupPackIds = uniqueStrings([...bootPackIds, ...startFloorPacks]);
const packById = new Map(packs.map((pack) => [pack.id, pack]));
const startupIds = uniqueSorted(startupPackIds.flatMap((id) => packById.get(id)?.ids || []));
const startupPresentIds = startupIds.filter((id) => frameById.has(id));
const floorDeltaPacks = packs.filter((pack) => pack.id.startsWith("floor-"));
const regionPacks = packs.filter((pack) => pack.id.startsWith("map-tiles-region-"));
const allFrameArea = keepSet.summary?.allFrameArea || sumFrameArea([...frameById.keys()], frameById);
const keepPresentFrameArea = keepSet.summary?.presentFrameArea || sumFrameArea(keepSet.presentKeepIds || [], frameById);
const startupFrameArea = sumFrameArea(startupPresentIds, frameById);

const report = {
  v: 1,
  source: {
    atlasPath,
    keepSetPath,
    profileId,
    startFloor,
    packWidth,
    sharedFloorThreshold,
    mapBucketSize,
    regionFloorThreshold
  },
  assumptions: [
    "Packs are planning records; the actual crop/repack builder should consume each pack's ids.",
    "map-tiles-shared-core contains map tile IDs used by at least sharedFloorThreshold enabled floors.",
    "Region map packs contain map tile IDs reused by at least regionFloorThreshold floors inside the same map bucket.",
    "Floor map packs are deltas after removing global shared and region shared map tile IDs.",
    "npc-field-core and pets-encounter-core stay as single lazy packs for the first implementation because they are small versus map tiles.",
    "Row-pack numbers are estimates for height-sorted packing; indexed PNG output should be smaller than RGBA pixel input."
  ],
  summary: {
    floors: floorIds.length,
    packs: packs.length,
    regionPacks: regionPacks.length,
    floorDeltaPacks: floorDeltaPacks.length,
    sharedMapTileIds: sharedMapIds.length,
    sharedMapFrameArea: sumFrameArea(sharedMapIds, frameById),
    regionMapTileIds: uniqueSorted(regionPacks.flatMap((pack) => pack.ids)).length,
    regionMapFrameArea: sumFrameArea(uniqueSorted(regionPacks.flatMap((pack) => pack.ids)), frameById),
    allFrameArea,
    keepPresentFrameArea,
    maxFloorDeltaFrameArea: maxBy(floorDeltaPacks, (pack) => pack.frameArea)?.frameArea || 0,
    largestRegionPacks: regionPacks
      .slice()
      .sort((a, b) => b.frameArea - a.frameArea)
      .map((pack) => ({
        id: pack.id,
        region: pack.region,
        ids: pack.ids.length,
        frameArea: pack.frameArea,
        rowPackArea: pack.rowPack.area
      })),
    largestFloorDeltas: floorDeltaPacks
      .slice()
      .sort((a, b) => b.frameArea - a.frameArea)
      .slice(0, 12)
      .map((pack) => ({
        id: pack.id,
        floor: pack.floor,
        ids: pack.ids.length,
        frameArea: pack.frameArea,
        rowPackArea: pack.rowPack.area
      })),
    bootPackIds,
    bootFrameArea: sumFrameArea(bootPackIds.flatMap((id) => packById.get(id)?.ids || []), frameById),
    startupPackIds,
    startupPresentIds: startupPresentIds.length,
    startupFrameArea,
    startupFrameAreaRatioVsAll: ratio(startupFrameArea, allFrameArea),
    startupFrameAreaRatioVsKeep: ratio(startupFrameArea, keepPresentFrameArea),
    startupRowPackArea: rowPackStats(idsToFrames(startupPresentIds), packWidth).area,
    missingKeepIds: keepSet.missingKeepIds || []
  },
  runtimeManifestSketch: {
    v: 1,
    profile: profileId,
    bootPacks: bootPackIds.map(packPath),
    sharedPacks: sharedPackIds.map(packPath),
    encounterPacks: ["pets-encounter-core"].map(packPath),
    floors: Object.fromEntries(Object.entries(floorPacks).map(([floor, value]) => [floor, {
      packs: value.packs.map(packPath)
    }]))
  },
  packs,
  floorPacks
};

const text = `${JSON.stringify(report, null, 2)}\n`;
if (outPath) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, text);
} else {
  process.stdout.write(text);
}

function getArg(name) {
  const arg = args.find((item) => item.startsWith(`${name}=`));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

function normalizeFrame(frame) {
  return {
    id: Number(frame.tileId ?? frame.id),
    x: frame.x,
    y: frame.y,
    width: frame.width ?? frame.w,
    height: frame.height ?? frame.h,
    xoffset: frame.xoffset ?? frame.xo ?? 0,
    yoffset: frame.yoffset ?? frame.yo ?? 0,
    hit: frame.hit ?? 0,
    prioType: frame.prioType ?? frame.prio ?? 0,
    bitmapNo: frame.bitmapNo ?? frame.bitmap ?? 0,
    graphicNo: frame.graphicNo ?? frame.graphic ?? 0
  };
}

function packRecord({ id, domain, load, floor = null, region = null, ids }) {
  const uniqueIds = uniqueSorted(ids);
  const presentIds = uniqueIds.filter((item) => frameById.has(item));
  const missingIds = uniqueIds.filter((item) => !frameById.has(item));
  const frames = idsToFrames(presentIds).sort(byHeight);
  const rowPack = rowPackStats(frames, packWidth);
  const compact = compactManifest(`${id}.png`, packWidth, rowPack.height, frames);
  return {
    id,
    domain,
    load,
    floor,
    region,
    image: `packs/${id}.png`,
    manifest: `packs/${id}.json`,
    ids: uniqueIds,
    presentIds,
    missingIds,
    frames: presentIds.length,
    frameArea: sumFrameArea(presentIds, frameById),
    rowPack,
    indexedPixelInputBytes: sumFrameArea(presentIds, frameById),
    rgbaPixelInputBytes: sumFrameArea(presentIds, frameById) * 4,
    compactManifestBytes: Buffer.byteLength(compact),
    compactManifestGzipBytes: gzipSize(compact),
    compactManifestBrotliBytes: brotliSize(compact)
  };
}

function packPath(id) {
  return `packs/${id}.json`;
}

function countFloorUsage(floors, getIds) {
  const usage = new Map();
  for (const floor of floors) {
    for (const id of new Set(getIds(floor).map(Number).filter(Number.isFinite))) {
      usage.set(id, (usage.get(id) || 0) + 1);
    }
  }
  return usage;
}

function groupFloorsByBucket(floors, bucketSize) {
  const groups = {};
  for (const floor of floors) {
    const bucket = String(bucketForFloor(floor, bucketSize));
    if (!groups[bucket]) groups[bucket] = [];
    groups[bucket].push(floor);
  }
  return groups;
}

function bucketForFloor(floor, bucketSize) {
  if (floor < 1000) return Math.floor(floor / 100) * 100;
  if (!bucketSize || floor < bucketSize) return floor;
  return Math.floor(floor / bucketSize) * bucketSize;
}

function buildRegionMapIdsByBucket({ bucketFloors, sharedMapIdSet }) {
  const out = {};
  for (const [bucket, floors] of Object.entries(bucketFloors)) {
    const usage = countFloorUsage(floors, (floor) => keepSet.floorDetails[String(floor)]?.mapTileIds || []);
    out[bucket] = [...usage.entries()]
      .filter(([id, count]) => !sharedMapIdSet.has(Number(id)) && count >= regionFloorThreshold)
      .map(([id]) => Number(id))
      .sort((a, b) => a - b);
  }
  return out;
}

function idsToFrames(ids) {
  return ids.map((id) => frameById.get(Number(id))).filter(Boolean);
}

function rowPackStats(frames, width) {
  let x = 0;
  let y = 0;
  let rowH = 0;
  let maxRowWidth = 0;
  for (const frame of frames) {
    if (x > 0 && x + frame.width > width) {
      maxRowWidth = Math.max(maxRowWidth, x);
      x = 0;
      y += rowH;
      rowH = 0;
    }
    x += frame.width;
    rowH = Math.max(rowH, frame.height);
  }
  maxRowWidth = Math.max(maxRowWidth, x);
  const height = y + rowH;
  const area = width * height;
  const frameArea = sumArea(frames);
  return {
    width,
    height,
    area,
    maxRowWidth,
    fillRatio: ratio(frameArea, area)
  };
}

function compactManifest(image, atlasWidth, atlasHeight, frames) {
  return JSON.stringify({
    v: 1,
    image,
    w: atlasWidth,
    h: atlasHeight,
    fields: ["id", "x", "y", "w", "h", "xo", "yo", "hit", "prio", "bitmap", "graphic"],
    frames: frames.map((frame) => [
      frame.id,
      0,
      0,
      frame.width,
      frame.height,
      frame.xoffset,
      frame.yoffset,
      frame.hit,
      frame.prioType,
      frame.bitmapNo,
      frame.graphicNo
    ])
  });
}

function byHeight(a, b) {
  return b.height - a.height || b.width - a.width || a.id - b.id;
}

function uniqueSorted(values) {
  return [...new Set([...values].map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function sumFrameArea(ids, frames) {
  return ids.reduce((sum, id) => {
    const frame = frames.get(Number(id));
    return sum + (frame ? frame.width * frame.height : 0);
  }, 0);
}

function sumArea(frames) {
  return frames.reduce((sum, frame) => sum + frame.width * frame.height, 0);
}

function ratio(value, total) {
  return total ? Number((value / total).toFixed(4)) : 0;
}

function gzipSize(value) {
  return zlib.gzipSync(Buffer.from(value), { level: 9 }).length;
}

function brotliSize(value) {
  return zlib.brotliCompressSync(Buffer.from(value), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
  }).length;
}

function maxBy(items, score) {
  let best = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const itemScore = score(item);
    if (itemScore > bestScore) {
      best = item;
      bestScore = itemScore;
    }
  }
  return best;
}
