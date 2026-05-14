import fs from "node:fs";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const manifestPath = args.find((arg) => !arg.startsWith("--"));
const widthArg = args.find((arg) => arg.startsWith("--width="));
const packWidth = Number(widthArg?.split("=")[1] || 2048);

if (!manifestPath) {
  console.error("Usage: node tools/plan-profile-packs.mjs path/to/tiles.json [--width=2048]");
  process.exit(1);
}

const source = fs.readFileSync(manifestPath);
const atlas = JSON.parse(source);
const frames = Object.values(atlas.frames || {}).map(normalizeFrame);
if (!frames.length) throw new Error("No frames found in atlas manifest");

const groups = {
  "ui-field": [],
  "player-core": [],
  "map-tiles": [],
  "large-sprites-sapack-candidate": [],
  "npc-field-or-small-sprites": []
};

for (const frame of frames) groups[classify(frame)].push(frame);

const unifiedHeightSortedArea = packArea([...frames].sort(byHeight), packWidth);
const currentArea = atlas.atlasWidth * atlas.atlasHeight;
const report = {
  source: manifestPath,
  assumptions: [
    "This tool only reads tiles.json, so pet/NPC distinction is heuristic.",
    "Use world-data.js + enemybase tables later to convert large-sprites into exact pet/battle packs.",
    "Estimated pack areas assume height-sorted row packing, not skyline/max-rects."
  ],
  currentAtlas: {
    width: atlas.atlasWidth,
    height: atlas.atlasHeight,
    area: currentArea,
    frames: frames.length,
    frameArea: sumArea(frames),
    fillRatio: ratio(sumArea(frames), currentArea),
    manifestBytes: source.length,
    manifestGzipBytes: gzipSize(source)
  },
  simpleRepackAtWidth: {
    width: packWidth,
    heightSortedArea: unifiedHeightSortedArea,
    areaSavingsVsCurrent: currentArea - unifiedHeightSortedArea,
    areaSavingsRatio: ratio(currentArea - unifiedHeightSortedArea, currentArea)
  },
  suggestedPacks: Object.fromEntries(
    Object.entries(groups).map(([name, items]) => [name, packStats(name, items, packWidth)])
  ),
  firstImplementationOrder: [
    "ui-field",
    "player-core",
    "map-tiles",
    "npc-field-or-small-sprites",
    "large-sprites-sapack-candidate"
  ]
};

console.log(JSON.stringify(report, null, 2));

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

function classify(frame) {
  const area = frame.width * frame.height;
  if (frame.id >= 25000) return "ui-field";
  if (frame.id >= 10201 && frame.id <= 10518) return "player-core";
  if (frame.id < 10000) return "map-tiles";
  if (area > 40000) return "large-sprites-sapack-candidate";
  return "npc-field-or-small-sprites";
}

function packStats(name, items, width) {
  const sorted = [...items].sort(byHeight);
  const packedHeight = rowPackHeight(sorted, width);
  const packedArea = width * packedHeight;
  const compact = compactManifest(`${name}.png`, width, packedHeight, sorted);
  const compactBytes = Buffer.byteLength(compact);
  return {
    frames: items.length,
    frameArea: sumArea(items),
    maxWidth: items.length ? Math.max(...items.map((item) => item.width)) : 0,
    maxHeight: items.length ? Math.max(...items.map((item) => item.height)) : 0,
    rowPack: {
      width,
      height: packedHeight,
      area: packedArea,
      fillRatio: ratio(sumArea(items), packedArea)
    },
    indexedPixelInputBytes: sumArea(items),
    rgbaPixelInputBytes: sumArea(items) * 4,
    compactManifestBytes: compactBytes,
    compactManifestGzipBytes: gzipSize(compact),
    compactManifestBrotliBytes: brotliSize(compact)
  };
}

function rowPackHeight(items, width) {
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const frame of items) {
    if (x > 0 && x + frame.width > width) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    x += frame.width;
    rowH = Math.max(rowH, frame.height);
  }
  return y + rowH;
}

function packArea(items, width) {
  return width * rowPackHeight(items, width);
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

function sumArea(items) {
  return items.reduce((sum, item) => sum + item.width * item.height, 0);
}

function ratio(value, total) {
  return total ? Number((value / total).toFixed(4)) : 0;
}

function gzipSize(value) {
  return zlib.gzipSync(Buffer.isBuffer(value) ? value : Buffer.from(value), { level: 9 }).length;
}

function brotliSize(value) {
  return zlib.brotliCompressSync(Buffer.isBuffer(value) ? value : Buffer.from(value), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
  }).length;
}

