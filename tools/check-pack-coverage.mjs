import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const atlasPath = positional[0];
const worldArg = args.find((arg) => arg.startsWith("--world="));
const enemyBaseArg = args.find((arg) => arg.startsWith("--enemybase="));
const closureArg = args.find((arg) => arg.startsWith("--closure="));
const profileArg = args.find((arg) => arg.startsWith("--profile="));
const floorsArg = args.find((arg) => arg.startsWith("--floors="));
const failOnMissing = args.includes("--fail-on-missing");
const maxItemsArg = args.find((arg) => arg.startsWith("--max-items="));
const maxItems = Number(maxItemsArg?.split("=")[1] || 80);

if (!atlasPath || !worldArg || !enemyBaseArg) {
  console.error("Usage: node tools/check-pack-coverage.mjs path/to/tiles.json --world=src/world-data.js --enemybase=public/data/enemybase2.txt [--closure=docs/planning/classic-core-closure-manifest.json --profile=classic-core] [--floors=100,1000] [--fail-on-missing] [--max-items=80]");
  process.exit(1);
}

const worldPath = path.resolve(worldArg.split("=").slice(1).join("="));
const enemyBasePath = path.resolve(enemyBaseArg.split("=").slice(1).join("="));
const closurePath = closureArg ? path.resolve(closureArg.split("=").slice(1).join("=")) : null;
const profileId = profileArg?.split("=").slice(1).join("=") || null;
const atlas = JSON.parse(fs.readFileSync(atlasPath, "utf8"));
const frameIds = new Set(Object.keys(atlas.frames || {}).map(Number));
const fullWorld = await loadWorld(worldPath);
const floorSet = loadFloorSet({ floorsArg, closurePath, profileId });
const world = floorSet ? filterWorldByFloors(fullWorld, floorSet) : fullWorld;
const enemyBase = parseEnemyBase(enemyBasePath);
const refs = collectWorldRefs(world);
const npcCoverage = checkNpcCoverage(refs.npcGraphics, frameIds);
const encounterCoverage = checkEncounterCoverage(refs.enemyTempNos, enemyBase, frameIds);
const missingEncounterFrameImageNos = new Set(encounterCoverage.missingFrames.map((item) => item.imageNo));
const matchedEncounterFrameImageNos = new Set(encounterCoverage.matchedFrames.map((item) => item.imageNo));

const summary = {
  atlasPath,
  worldPath,
  enemyBasePath,
  closurePath,
  profileId,
  floorFilterCount: floorSet?.size || null,
  atlasFrames: frameIds.size,
  maps: Object.keys(world.maps || {}).length,
  npcGraphics: refs.npcGraphics.size,
  missingNpcGraphicFrames: npcCoverage.missing.length,
  enemyTempNos: refs.enemyTempNos.size,
  enemyBaseRows: enemyBase.size,
  missingEnemyBaseRows: encounterCoverage.missingEnemyBase.length,
  missingEnemyImageNos: encounterCoverage.missingImageNo.length,
  encounterImageNos: encounterCoverage.imageNos.size,
  missingEncounterFrameImageNos: missingEncounterFrameImageNos.size,
  missingEncounterFrameRefs: encounterCoverage.missingFrames.length,
  matchedEncounterFrameImageNos: matchedEncounterFrameImageNos.size,
  matchedEncounterFrameRefs: encounterCoverage.matchedFrames.length
};

const report = {
  summary,
  missingNpcGraphicFrames: npcCoverage.missing.slice(0, maxItems),
  missingEnemyBaseRows: encounterCoverage.missingEnemyBase.slice(0, maxItems),
  missingEnemyImageNos: encounterCoverage.missingImageNo.slice(0, maxItems),
  missingEncounterImageFrames: encounterCoverage.missingFrames.slice(0, maxItems),
  notes: [
    "Use --closure and --profile to check only a generated content profile instead of full-dev world-data.",
    "Use --fail-on-missing in CI/profile builds after the profile-specific keep-set is generated.",
    "missingEncounterImageFrames means an enabled encounter/battle resolves to an enemybase imageNo that is not present in the atlas manifest.",
    "missingEnemyBaseRows means world-data references a tempNo not present in enemybase2.txt."
  ]
};

console.log(JSON.stringify(report, null, 2));

if (failOnMissing && (
  summary.missingNpcGraphicFrames ||
  summary.missingEnemyBaseRows ||
  summary.missingEnemyImageNos ||
  summary.missingEncounterFrameImageNos
)) {
  process.exitCode = 1;
}

async function loadWorld(file) {
  const mod = await import(pathToFileURL(file).href);
  return mod.WORLD || mod.default?.WORLD || mod.default || {};
}

function collectWorldRefs(world) {
  const npcGraphics = new Map();
  const enemyTempNos = new Map();
  for (const [floor, map] of Object.entries(world.maps || {})) {
    const floorLabel = `${floor}${map.name ? ` ${map.name}` : ""}`;
    for (const npc of map.npcs || []) {
      const graphic = Number(npc.graphic);
      if (Number.isFinite(graphic) && graphic > 99) {
        addSource(npcGraphics, graphic, {
          floor: Number(floor),
          map: map.name || "",
          source: "npc.graphic",
          npcId: npc.id || "",
          npcName: npc.name || npc.summary || ""
        });
      }
    }
    for (const tempNo of map.encounterPets || []) {
      const value = Number(tempNo);
      if (Number.isFinite(value) && value > 0) {
        addSource(enemyTempNos, value, {
          floor: Number(floor),
          map: map.name || "",
          source: "map.encounterPets"
        });
      }
    }
    collectRecursiveTempNos(map, enemyTempNos, [`WORLD.maps.${floorLabel}`], Number(floor), map.name || "");
  }
  return { npcGraphics, enemyTempNos };
}

function loadFloorSet({ floorsArg, closurePath, profileId }) {
  const directFloors = parseFloorsArg(floorsArg);
  if (directFloors?.size) return directFloors;
  if (!closurePath) return null;

  const closure = JSON.parse(fs.readFileSync(closurePath, "utf8"));
  const selectedProfileId = profileId || closure.profiles?.[0]?.id;
  const profile = (closure.profiles || []).find((item) => item.id === selectedProfileId);
  if (!profile) {
    throw new Error(`Profile ${selectedProfileId} not found in ${closurePath}`);
  }
  const floors = new Set();
  for (const item of profile.floors || []) {
    const floor = Number(item.floor ?? item);
    if (Number.isFinite(floor)) floors.add(floor);
  }
  return floors;
}

function parseFloorsArg(arg) {
  if (!arg) return null;
  const raw = arg.split("=").slice(1).join("=");
  const floors = new Set();
  for (const part of raw.split(/[,\s]+/)) {
    if (!part) continue;
    const floor = Number(part);
    if (Number.isFinite(floor)) floors.add(floor);
  }
  return floors;
}

function filterWorldByFloors(world, floorSet) {
  const maps = {};
  for (const [floor, map] of Object.entries(world.maps || {})) {
    if (floorSet.has(Number(floor))) maps[floor] = map;
  }
  return { ...world, maps };
}

function collectRecursiveTempNos(value, out, trail, floor, mapName) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectRecursiveTempNos(item, out, [...trail, String(index)], floor, mapName));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "tempNo" || key === "PetId" || key === "EnemyTempNo") {
      const number = Number(item);
      if (Number.isFinite(number) && number > 0) {
        addSource(out, number, {
          floor,
          map: mapName,
          source: key,
          path: [...trail, key].join(".")
        });
      }
    }
    collectRecursiveTempNos(item, out, [...trail, key], floor, mapName);
  }
}

function checkNpcCoverage(npcGraphics, frameIds) {
  const missing = [];
  for (const [graphic, sources] of npcGraphics.entries()) {
    if (frameIds.has(Number(graphic))) continue;
    missing.push({
      graphic,
      sources: [...sources].slice(0, 8)
    });
  }
  missing.sort((a, b) => a.graphic - b.graphic);
  return { missing };
}

function checkEncounterCoverage(enemyTempNos, enemyBase, frameIds) {
  const missingEnemyBase = [];
  const missingImageNo = [];
  const missingFrames = [];
  const matchedFrames = [];
  const imageNos = new Set();

  for (const [tempNo, sources] of enemyTempNos.entries()) {
    const enemy = enemyBase.get(Number(tempNo));
    if (!enemy) {
      missingEnemyBase.push({ tempNo, sources: [...sources].slice(0, 8) });
      continue;
    }
    if (!enemy.imageNo || enemy.imageNo <= 99) {
      missingImageNo.push({
        tempNo,
        name: enemy.name,
        imageNo: enemy.imageNo,
        sources: [...sources].slice(0, 8)
      });
      continue;
    }
    imageNos.add(enemy.imageNo);
    const row = {
      tempNo,
      name: enemy.name,
      imageNo: enemy.imageNo,
      sources: [...sources].slice(0, 8)
    };
    if (frameIds.has(enemy.imageNo)) matchedFrames.push(row);
    else missingFrames.push(row);
  }

  missingEnemyBase.sort((a, b) => a.tempNo - b.tempNo);
  missingImageNo.sort((a, b) => a.tempNo - b.tempNo);
  missingFrames.sort((a, b) => a.imageNo - b.imageNo || a.tempNo - b.tempNo);
  matchedFrames.sort((a, b) => a.imageNo - b.imageNo || a.tempNo - b.tempNo);
  return { imageNos, missingEnemyBase, missingImageNo, missingFrames, matchedFrames };
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

function addSource(map, key, source) {
  const list = map.get(Number(key)) || [];
  const sourceKey = JSON.stringify(source);
  if (!list.some((item) => JSON.stringify(item) === sourceKey)) list.push(source);
  map.set(Number(key), list);
}
