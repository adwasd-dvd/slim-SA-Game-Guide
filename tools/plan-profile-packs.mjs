import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const manifestPath = positional[0];
const widthArg = args.find((arg) => arg.startsWith("--width="));
const worldArg = args.find((arg) => arg.startsWith("--world="));
const enemyBaseArg = args.find((arg) => arg.startsWith("--enemybase="));
const packWidth = Number(widthArg?.split("=")[1] || 2048);
const worldPath = worldArg ? path.resolve(worldArg.split("=").slice(1).join("=")) : null;
const enemyBasePath = enemyBaseArg ? path.resolve(enemyBaseArg.split("=").slice(1).join("=")) : null;
const FIELD_UI_GRAPHIC_IDS = new Set([
  25000, 25001,
  26100, 26101, 26102, 26103, 26104, 26105, 26106, 26107, 26111, 26112,
  26113, 26114, 26115, 26116, 26117, 26118, 26119, 26120, 26121, 26233,
  26234, 26235, 26236, 26237, 26238, 26248, 26249, 26260, 26294, 26295,
  26358, 26452, 28553, 35271
]);

if (!manifestPath) {
  console.error("Usage: node tools/plan-profile-packs.mjs path/to/tiles.json [--width=2048] [--world=src/world-data.js] [--enemybase=public/data/enemybase2.txt]");
  process.exit(1);
}

const source = fs.readFileSync(manifestPath);
const atlas = JSON.parse(source);
const frames = Object.values(atlas.frames || {}).map(normalizeFrame);
if (!frames.length) throw new Error("No frames found in atlas manifest");
const hints = await loadSourceHints({ worldPath, enemyBasePath });

const groups = {
  "ui-field": [],
  "player-core": [],
  "map-tiles": [],
  "npc-field": [],
  "pets-encounter": [],
  "large-sprites-sapack-candidate": [],
  "unclassified-small-sprites": []
};

for (const frame of frames) groups[classify(frame, hints)].push(frame);

const unifiedHeightSortedArea = packArea([...frames].sort(byHeight), packWidth);
const currentArea = atlas.atlasWidth * atlas.atlasHeight;
const report = {
  source: manifestPath,
  sourceHints: summarizeHints(hints, frames),
  assumptions: [
    hints.loadedWorld
      ? "world-data.js was loaded, so NPC graphics and encounter tempNos are classified from generated world data."
      : "world-data.js was not provided; NPC graphics and encounter pets fall back to tileId/area heuristics.",
    hints.loadedEnemyBase
      ? "enemybase data was loaded, so encounter tempNos are resolved to imageNo frames where possible."
      : "enemybase data was not provided; pet/battle pack classification is incomplete.",
    "Estimated pack areas assume height-sorted row packing, not skyline/max-rects.",
    "Map tile classification is still heuristic unless this tool is later connected to selected profile map/client-map files."
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
    "npc-field",
    "pets-encounter",
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

function classify(frame, hints) {
  const area = frame.width * frame.height;
  if (frame.id >= 10201 && frame.id <= 10518) return "player-core";
  if (hints.encounterImageNos.has(frame.id)) return "pets-encounter";
  if (hints.npcGraphicIds.has(frame.id)) return "npc-field";
  if (FIELD_UI_GRAPHIC_IDS.has(frame.id)) return "ui-field";
  if (frame.id < 10000) return "map-tiles";
  if (area > 40000) return "large-sprites-sapack-candidate";
  return "unclassified-small-sprites";
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

async function loadSourceHints({ worldPath, enemyBasePath }) {
  const hints = {
    loadedWorld: false,
    loadedEnemyBase: false,
    worldPath,
    enemyBasePath,
    npcGraphicIds: new Set(),
    encounterTempNos: new Set(),
    recursiveTempNos: new Set(),
    enemyBaseByTempNo: new Map(),
    encounterImageNos: new Set(),
    missingEnemyBaseTempNos: new Set(),
    missingImageNos: new Set()
  };

  if (worldPath && fs.existsSync(worldPath)) {
    const mod = await import(pathToFileURL(worldPath).href);
    const world = mod.WORLD || mod.default?.WORLD || mod.default || {};
    hints.loadedWorld = true;
    collectWorldHints(world, hints);
  }

  if (enemyBasePath && fs.existsSync(enemyBasePath)) {
    hints.loadedEnemyBase = true;
    hints.enemyBaseByTempNo = parseEnemyBase(enemyBasePath);
  }

  for (const tempNo of new Set([...hints.encounterTempNos, ...hints.recursiveTempNos])) {
    const enemy = hints.enemyBaseByTempNo.get(Number(tempNo));
    if (!enemy) {
      hints.missingEnemyBaseTempNos.add(Number(tempNo));
      continue;
    }
    if (enemy.imageNo > 99) hints.encounterImageNos.add(enemy.imageNo);
    else hints.missingImageNos.add(Number(tempNo));
  }

  return hints;
}

function collectWorldHints(world, hints) {
  const maps = Object.values(world.maps || {});
  for (const map of maps) {
    for (const npc of map.npcs || []) {
      const graphic = Number(npc.graphic);
      if (Number.isFinite(graphic) && graphic > 99) hints.npcGraphicIds.add(graphic);
    }
    for (const tempNo of map.encounterPets || []) {
      const value = Number(tempNo);
      if (Number.isFinite(value) && value > 0) hints.encounterTempNos.add(value);
    }
    collectRecursiveTempNos(map, hints.recursiveTempNos);
  }
}

function collectRecursiveTempNos(value, out) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectRecursiveTempNos(item, out));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "tempNo" || key === "PetId" || key === "EnemyTempNo") {
      const number = Number(item);
      if (Number.isFinite(number) && number > 0) out.add(number);
    }
    collectRecursiveTempNos(item, out);
  }
}

function parseEnemyBase(file) {
  const out = new Map();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const cols = line.split(",");
    if (cols.length < 37) continue;
    const tempNo = Number(cols[6]);
    const imageNo = Number(cols[36]);
    if (!Number.isFinite(tempNo) || tempNo <= 0) continue;
    out.set(tempNo, {
      tempNo,
      name: cols[0] || `enemy ${tempNo}`,
      imageNo: Number.isFinite(imageNo) && imageNo > 0 ? imageNo : 0
    });
  }
  return out;
}

function summarizeHints(hints, frames) {
  const frameIds = new Set(frames.map((frame) => frame.id));
  const matchedNpcGraphics = [...hints.npcGraphicIds].filter((id) => frameIds.has(id)).length;
  const matchedEncounterImages = [...hints.encounterImageNos].filter((id) => frameIds.has(id)).length;
  const missingEncounterFrames = [...hints.encounterImageNos].filter((id) => !frameIds.has(id));
  return {
    worldPath: hints.worldPath || null,
    enemyBasePath: hints.enemyBasePath || null,
    loadedWorld: hints.loadedWorld,
    loadedEnemyBase: hints.loadedEnemyBase,
    npcGraphicIds: hints.npcGraphicIds.size,
    matchedNpcGraphics,
    encounterTempNos: hints.encounterTempNos.size,
    recursiveTempNos: hints.recursiveTempNos.size,
    enemyBaseRows: hints.enemyBaseByTempNo.size,
    encounterImageNos: hints.encounterImageNos.size,
    matchedEncounterImages,
    missingEnemyBaseTempNos: [...hints.missingEnemyBaseTempNos].slice(0, 30),
    missingEncounterFrames: missingEncounterFrames.slice(0, 30)
  };
}
