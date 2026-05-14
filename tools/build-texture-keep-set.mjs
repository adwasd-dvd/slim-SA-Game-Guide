import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const atlasPath = positional[0];
const worldArg = getArg("--world");
const enemyBaseArg = getArg("--enemybase");
const closureArg = getArg("--closure");
const profileId = getArg("--profile") || null;
const floorsArg = getArg("--floors");
const mapsDir = getArg("--maps");
const clientMapsDir = getArg("--client-maps");
const outPath = getArg("--out");

const FIELD_UI_GRAPHIC_IDS = [
  25000, 25001,
  26100, 26101, 26102, 26103, 26104, 26105, 26106, 26107, 26111, 26112,
  26113, 26114, 26115, 26116, 26117, 26118, 26119, 26120, 26121, 26233,
  26234, 26235, 26236, 26237, 26238, 26248, 26249, 26260, 26294, 26295,
  26358, 26452, 28553, 35271
];

const DEFAULT_PLAYER_SPRITE_FRAME_IDS = [
  10201, 10202, 10203, 10212, 10213, 10214, 10215, 10216, 10217,
  10244, 10245, 10246, 10255, 10256, 10257, 10258, 10259, 10260,
  10287, 10288, 10289, 10298, 10299, 10300, 10301, 10302, 10303,
  10330, 10331, 10332, 10341, 10342, 10343, 10344, 10345, 10346,
  10373, 10374, 10375, 10384, 10385, 10386, 10387, 10388, 10389,
  10416, 10417, 10418, 10427, 10428, 10429, 10430, 10431, 10432,
  10459, 10460, 10461, 10470, 10471, 10472, 10473, 10474, 10475,
  10502, 10503, 10504, 10513, 10514, 10515, 10516, 10517, 10518
];

if (!atlasPath || !worldArg || !enemyBaseArg) {
  console.error([
    "Usage: node tools/build-texture-keep-set.mjs path/to/tiles.json",
    "  --world=src/world-data.js",
    "  --enemybase=public/data/enemybase2.txt",
    "  [--closure=docs/planning/classic-core-closure-manifest.json --profile=classic-core]",
    "  [--floors=100,1000]",
    "  [--maps=public/data/maps --client-maps=public/data/client-maps]",
    "  [--out=texture-keep-set.json]"
  ].join("\n"));
  process.exit(1);
}

const atlas = JSON.parse(fs.readFileSync(atlasPath, "utf8"));
const frameById = new Map(Object.values(atlas.frames || {}).map((frame) => [Number(frame.tileId ?? frame.id), normalizeFrame(frame)]));
const worldPath = path.resolve(worldArg);
const enemyBasePath = path.resolve(enemyBaseArg);
const closurePath = closureArg ? path.resolve(closureArg) : null;
const floorSet = loadFloorSet({ floorsArg, closurePath, profileId });
const world = filterWorldByFloors(await loadWorld(worldPath), floorSet);
const selectedFloors = floorSet || floorsFromWorld(world);
const enemyBase = parseEnemyBase(enemyBasePath);
const mapKeep = collectMapTextureIds({ floors: selectedFloors, mapsDir, clientMapsDir });
const npcKeep = collectNpcGraphics(world);
const encounter = collectEncounterImageNos(world, enemyBase);
const allFrameArea = sumFrameArea([...frameById.keys()], frameById);

const domains = {
  "ui-field": domainRecord(FIELD_UI_GRAPHIC_IDS, frameById),
  "player-core": domainRecord(DEFAULT_PLAYER_SPRITE_FRAME_IDS, frameById),
  "map-tiles": domainRecord(mapKeep.ids, frameById),
  "npc-field": domainRecord(npcKeep.ids, frameById),
  "pets-encounter": domainRecord(encounter.imageNos, frameById)
};

const keepIds = uniqueSorted(Object.values(domains).flatMap((domain) => domain.ids));
const presentKeepIds = keepIds.filter((id) => frameById.has(id));
const missingKeepIds = keepIds.filter((id) => !frameById.has(id));
const report = {
  v: 1,
  source: {
    atlasPath,
    worldPath,
    enemyBasePath,
    closurePath,
    profileId,
    mapsDir: mapsDir || null,
    clientMapsDir: clientMapsDir || null
  },
  summary: {
    floors: selectedFloors.size,
    atlasFrames: frameById.size,
    allFrameArea,
    keepIds: keepIds.length,
    presentKeepIds: presentKeepIds.length,
    missingKeepIds: missingKeepIds.length,
    presentFrameArea: sumFrameArea(presentKeepIds, frameById),
    presentFrameAreaRatio: roundRatio(sumFrameArea(presentKeepIds, frameById), allFrameArea),
    domains: Object.fromEntries(Object.entries(domains).map(([name, domain]) => [name, {
      ids: domain.ids.length,
      present: domain.present.length,
      missing: domain.missing.length,
      presentFrameArea: domain.presentFrameArea
    }])),
    missingEnemyBaseRows: encounter.missingEnemyBase.length,
    missingEnemyImageNos: encounter.missingImageNo.length,
    missingMapFiles: mapKeep.missingFiles.length
  },
  domains,
  keepIds,
  presentKeepIds,
  missingKeepIds,
  encounterDiagnostics: {
    tempNos: encounter.tempNos,
    missingEnemyBase: encounter.missingEnemyBase,
    missingImageNo: encounter.missingImageNo
  },
  mapDiagnostics: {
    floorsRead: mapKeep.floorsRead,
    missingFiles: mapKeep.missingFiles
  }
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
    width: frame.width ?? frame.w,
    height: frame.height ?? frame.h,
    bitmapNo: frame.bitmapNo ?? frame.bitmap ?? 0,
    graphicNo: frame.graphicNo ?? frame.graphic ?? 0
  };
}

function domainRecord(ids, frameById) {
  const uniqueIds = uniqueSorted(ids);
  const present = uniqueIds.filter((id) => frameById.has(id));
  const missing = uniqueIds.filter((id) => !frameById.has(id));
  return {
    ids: uniqueIds,
    present,
    missing,
    presentFrameArea: sumFrameArea(present, frameById)
  };
}

async function loadWorld(file) {
  const mod = await import(pathToFileURL(file).href);
  return mod.WORLD || mod.default?.WORLD || mod.default || {};
}

function loadFloorSet({ floorsArg, closurePath, profileId }) {
  const directFloors = parseFloorsArg(floorsArg);
  if (directFloors?.size) return directFloors;
  if (!closurePath) return null;

  const closure = JSON.parse(fs.readFileSync(closurePath, "utf8"));
  const selectedProfileId = profileId || closure.profiles?.[0]?.id;
  const profile = (closure.profiles || []).find((item) => item.id === selectedProfileId);
  if (!profile) throw new Error(`Profile ${selectedProfileId} not found in ${closurePath}`);
  return new Set((profile.floors || [])
    .map((item) => Number(item.floor ?? item))
    .filter(Number.isFinite));
}

function parseFloorsArg(arg) {
  if (!arg) return null;
  const floors = new Set();
  for (const part of arg.split(/[,\s]+/)) {
    if (!part) continue;
    const floor = Number(part);
    if (Number.isFinite(floor)) floors.add(floor);
  }
  return floors;
}

function filterWorldByFloors(world, floorSet) {
  if (!floorSet) return world;
  const maps = {};
  for (const [floor, map] of Object.entries(world.maps || {})) {
    if (floorSet.has(Number(floor))) maps[floor] = map;
  }
  return { ...world, maps };
}

function floorsFromWorld(world) {
  return new Set(Object.keys(world.maps || {}).map(Number).filter(Number.isFinite));
}

function collectMapTextureIds({ floors, mapsDir, clientMapsDir }) {
  const ids = new Set();
  const missingFiles = [];
  const floorsRead = [];
  if (!floors?.size || (!mapsDir && !clientMapsDir)) {
    return { ids: [], missingFiles, floorsRead };
  }
  const resolvedMapsDir = mapsDir ? path.resolve(mapsDir) : null;
  const resolvedClientMapsDir = clientMapsDir ? path.resolve(clientMapsDir) : null;

  for (const floor of [...floors].sort((a, b) => a - b)) {
    let readAny = false;
    if (resolvedMapsDir) {
      const file = path.join(resolvedMapsDir, `${floor}.ls2map`);
      if (fs.existsSync(file)) {
        collectLs2MapTileIds(file, ids);
        readAny = true;
      } else {
        missingFiles.push({ floor, kind: "ls2map", file });
      }
    }
    if (resolvedClientMapsDir) {
      const file = path.join(resolvedClientMapsDir, `${floor}.dat`);
      if (fs.existsSync(file)) {
        collectClientDatTileIds(file, ids);
        readAny = true;
      } else {
        missingFiles.push({ floor, kind: "client-dat", file });
      }
    }
    if (readAny) floorsRead.push(floor);
  }
  return { ids: [...ids], missingFiles, floorsRead };
}

function collectClientDatTileIds(file, ids) {
  const buf = fs.readFileSync(file);
  if (buf.length < 8) return;
  const width = buf.readUInt32LE(0);
  const height = buf.readUInt32LE(4);
  const cellCount = width * height;
  const layerSize = cellCount * 2;
  const expected = 8 + layerSize * 3;
  if (!width || !height || buf.length < expected) return;
  for (let i = 0; i < cellCount; i += 1) {
    const tile = buf.readUInt16LE(8 + i * 2);
    const parts = buf.readUInt16LE(8 + layerSize + i * 2);
    if (tile) ids.add(tile);
    if (parts) ids.add(parts);
  }
}

function collectLs2MapTileIds(file, ids) {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.toString("ascii", 0, 6) !== "LS2MAP") return;
  const width = buf.readUInt16BE(40);
  const height = buf.readUInt16BE(42);
  const cellCount = width * height;
  const layerSize = cellCount * 2;
  const expected = 44 + layerSize * 2;
  if (!width || !height || buf.length < expected) return;
  for (let i = 0; i < cellCount; i += 1) {
    const tile = buf.readUInt16BE(44 + i * 2);
    const parts = buf.readUInt16BE(44 + layerSize + i * 2);
    if (tile) ids.add(tile);
    if (parts) ids.add(parts);
  }
}

function collectNpcGraphics(world) {
  const ids = new Set();
  for (const map of Object.values(world.maps || {})) {
    for (const npc of map.npcs || []) {
      const graphic = Number(npc.graphic);
      if (Number.isFinite(graphic) && graphic > 99) ids.add(graphic);
    }
  }
  return { ids: [...ids] };
}

function collectEncounterImageNos(world, enemyBase) {
  const tempNos = new Set();
  for (const map of Object.values(world.maps || {})) {
    for (const tempNo of map.encounterPets || []) {
      const value = Number(tempNo);
      if (Number.isFinite(value) && value > 0) tempNos.add(value);
    }
    collectRecursiveTempNos(map, tempNos);
  }

  const imageNos = new Set();
  const missingEnemyBase = [];
  const missingImageNo = [];
  for (const tempNo of [...tempNos].sort((a, b) => a - b)) {
    const enemy = enemyBase.get(tempNo);
    if (!enemy) {
      missingEnemyBase.push(tempNo);
      continue;
    }
    if (!enemy.imageNo || enemy.imageNo <= 99) {
      missingImageNo.push(tempNo);
      continue;
    }
    imageNos.add(enemy.imageNo);
  }
  return {
    tempNos: [...tempNos].sort((a, b) => a - b),
    imageNos: [...imageNos].sort((a, b) => a - b),
    missingEnemyBase,
    missingImageNo
  };
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

function uniqueSorted(values) {
  return [...new Set(values.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
}

function sumFrameArea(ids, frameById) {
  return ids.reduce((sum, id) => {
    const frame = frameById.get(Number(id));
    return sum + (frame ? frame.width * frame.height : 0);
  }, 0);
}

function roundRatio(part, total) {
  return total ? Number((part / total).toFixed(4)) : 0;
}
