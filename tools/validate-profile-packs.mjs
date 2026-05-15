import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const atlasManifestPath = positional[0];
const keepSetPath = positional[1];
const packPlanPath = positional[2];
const packsDirArg = getArg("--packs-dir");
const reportPath = getArg("--report");
const failOn = (getArg("--fail-on") || "error").toLowerCase();
const onlyArg = getArg("--only");
const allowMissingPackFiles = args.includes("--allow-missing-pack-files");
const onlyPackIds = onlyArg ? new Set(onlyArg.split(",").map((item) => item.trim()).filter(Boolean)) : null;

if (!atlasManifestPath || !keepSetPath || !packPlanPath) {
  console.error([
    "Usage: node tools/validate-profile-packs.mjs path/to/tiles.json path/to/texture-keep-set.json path/to/profile-texture-pack-plan.json",
    "  [--packs-dir=public/data/profiles/classic-core/packs]",
    "  [--only=boot-ui-field,boot-player-core]",
    "  [--allow-missing-pack-files]",
    "  [--report=validate-profile-packs-report.json]",
    "  [--fail-on=error|warning|none]"
  ].join("\n"));
  process.exit(1);
}

if (!new Set(["error", "warning", "none"]).has(failOn)) {
  throw new Error(`Invalid --fail-on value: ${failOn}`);
}

const atlasManifest = JSON.parse(fs.readFileSync(atlasManifestPath, "utf8"));
const keepSet = JSON.parse(fs.readFileSync(keepSetPath, "utf8"));
const packPlan = JSON.parse(fs.readFileSync(packPlanPath, "utf8"));
const packsDir = packsDirArg ? path.resolve(packsDirArg) : null;

const issues = [];
const atlasFrameById = new Map(Object.values(atlasManifest.frames || {}).map((frame) => {
  const normalized = normalizeAtlasFrame(frame);
  return [normalized.id, normalized];
}));

const packById = new Map();
for (const pack of packPlan.packs || []) {
  if (packById.has(pack.id)) {
    addIssue("error", "duplicate-pack-id", `Duplicate pack id ${pack.id}`, { packId: pack.id }, issues);
    continue;
  }
  packById.set(pack.id, pack);
}

validateManifestReferences(packPlan, packById, issues);

const floorCoverage = validateFloorCoverage({ keepSet, packPlan, packById, issues });
const packFileChecks = packsDir
  ? validatePackFiles({ packsDir, packById, issues, onlyPackIds, allowMissingPackFiles })
  : { checked: 0, withJson: 0, withPng: 0 };

const summary = {
  atlasFrames: atlasFrameById.size,
  planPacks: packById.size,
  keepFloors: Object.keys(keepSet.floorDetails || {}).length,
  floorCoverage,
  packFiles: packFileChecks,
  issues: {
    error: issues.filter((issue) => issue.level === "error").length,
    warning: issues.filter((issue) => issue.level === "warning").length
  }
};

const report = {
  v: 1,
  source: {
    atlasManifestPath: path.resolve(atlasManifestPath),
    keepSetPath: path.resolve(keepSetPath),
    packPlanPath: path.resolve(packPlanPath),
    packsDir,
    onlyPackIds: onlyPackIds ? [...onlyPackIds] : null,
    allowMissingPackFiles,
    failOn
  },
  summary,
  issues
};

const text = `${JSON.stringify(report, null, 2)}\n`;
if (reportPath) {
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  fs.writeFileSync(reportPath, text);
} else {
  process.stdout.write(text);
}

const hasError = summary.issues.error > 0;
const hasWarning = summary.issues.warning > 0;
if ((failOn === "error" && hasError) || (failOn === "warning" && (hasError || hasWarning))) {
  process.exit(1);
}

function validateManifestReferences(packPlan, packById, issues) {
  const refs = [];
  for (const id of packPlan.runtimeManifestSketch?.bootPacks || []) refs.push(idToPackId(id));
  for (const id of packPlan.runtimeManifestSketch?.sharedPacks || []) refs.push(idToPackId(id));
  for (const id of packPlan.runtimeManifestSketch?.encounterPacks || []) refs.push(idToPackId(id));
  for (const floor of Object.values(packPlan.floorPacks || {})) {
    for (const id of floor.packs || []) refs.push(idToPackId(id));
  }
  for (const ref of refs) {
    if (!ref) continue;
    if (!packById.has(ref)) addIssue("error", "unknown-pack-ref", `Pack reference ${ref} does not exist in plan`, { ref }, issues);
  }
}

function validateFloorCoverage({ keepSet, packPlan, packById, issues }) {
  let checked = 0;
  let ok = 0;
  const missingByFloor = {};
  for (const [floor, detail] of Object.entries(keepSet.floorDetails || {})) {
    checked += 1;
    const required = uniqueSorted(detail.presentIds || []);
    const floorPackInfo = packPlan.floorPacks?.[floor];
    if (!floorPackInfo) {
      addIssue("error", "missing-floor-pack-plan", `Missing floor pack plan for floor ${floor}`, { floor }, issues);
      missingByFloor[floor] = required;
      continue;
    }
    const available = new Set();
    for (const ref of floorPackInfo.packs || []) {
      const packId = idToPackId(ref);
      const pack = packById.get(packId);
      if (!pack) continue;
      for (const id of pack.presentIds || []) available.add(Number(id));
    }
    const missing = required.filter((id) => !available.has(Number(id)));
    if (missing.length) {
      missingByFloor[floor] = missing;
      addIssue("error", "floor-coverage-gap", `Floor ${floor} has ${missing.length} missing frame ids`, {
        floor,
        missingCount: missing.length,
        sample: missing.slice(0, 16)
      }, issues);
    } else {
      ok += 1;
    }
  }
  return {
    checked,
    ok,
    failed: checked - ok,
    missingByFloor
  };
}

function validatePackFiles({ packsDir, packById, issues, onlyPackIds, allowMissingPackFiles }) {
  let checked = 0;
  let withJson = 0;
  let withPng = 0;

  for (const pack of packById.values()) {
    if (onlyPackIds && !onlyPackIds.has(pack.id)) continue;
    checked += 1;
    const jsonPath = path.join(packsDir, `${pack.id}.json`);
    const pngPath = path.join(packsDir, `${pack.id}.png`);
    const hasJson = fs.existsSync(jsonPath);
    const hasPng = fs.existsSync(pngPath);
    if (hasJson) withJson += 1;
    if (hasPng) withPng += 1;

    if (!hasJson) {
      addIssue(allowMissingPackFiles ? "warning" : "error", "missing-pack-json", `Missing ${pack.id}.json`, { packId: pack.id, path: jsonPath }, issues);
      continue;
    }

    const manifest = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const frames = parseCompactFrames(manifest);
    const manifestIdSet = new Set(frames.map((frame) => Number(frame.id)));
    const expected = uniqueSorted(pack.presentIds || []);
    const expectedSet = new Set(expected);
    const missing = expected.filter((id) => !manifestIdSet.has(Number(id)));
    const unexpected = [...manifestIdSet].filter((id) => !expectedSet.has(Number(id))).sort((a, b) => a - b);

    if (missing.length) {
      addIssue("error", "pack-manifest-missing-ids", `Pack ${pack.id} manifest misses ${missing.length} ids`, {
        packId: pack.id,
        missingCount: missing.length,
        sample: missing.slice(0, 16)
      }, issues);
    }
    if (unexpected.length) {
      addIssue("warning", "pack-manifest-unexpected-ids", `Pack ${pack.id} manifest has ${unexpected.length} unexpected ids`, {
        packId: pack.id,
        unexpectedCount: unexpected.length,
        sample: unexpected.slice(0, 16)
      }, issues);
    }

    validateManifestFrameBounds(pack.id, manifest, frames, issues);

    if (!hasPng) {
      addIssue(allowMissingPackFiles ? "warning" : "error", "missing-pack-png", `Missing ${pack.id}.png`, { packId: pack.id, path: pngPath }, issues);
      continue;
    }

    const pngSize = readPngSize(fs.readFileSync(pngPath));
    if (pngSize.width !== Number(manifest.w) || pngSize.height !== Number(manifest.h)) {
      addIssue("error", "png-manifest-size-mismatch", `Pack ${pack.id} png size ${pngSize.width}x${pngSize.height} differs from manifest ${manifest.w}x${manifest.h}`, {
        packId: pack.id,
        png: pngSize,
        manifest: { w: manifest.w, h: manifest.h }
      }, issues);
    }
  }

  return { checked, withJson, withPng };
}

function validateManifestFrameBounds(packId, manifest, frames, issues) {
  const width = Number(manifest.w);
  const height = Number(manifest.h);
  for (const frame of frames) {
    if (frame.x < 0 || frame.y < 0 || frame.w <= 0 || frame.h <= 0) {
      addIssue("error", "invalid-frame-rect", `Pack ${packId} has invalid rect for frame ${frame.id}`, {
        packId,
        frame
      }, issues);
      continue;
    }
    if (frame.x + frame.w > width || frame.y + frame.h > height) {
      addIssue("error", "frame-out-of-bounds", `Pack ${packId} frame ${frame.id} is outside manifest bounds`, {
        packId,
        frame,
        manifest: { w: width, h: height }
      }, issues);
    }
  }
}

function parseCompactFrames(manifest) {
  const fields = manifest.fields || [];
  const index = Object.fromEntries(fields.map((field, i) => [field, i]));
  const frames = [];
  for (const row of manifest.frames || []) {
    frames.push({
      id: Number(row[index.id]),
      x: Number(row[index.x]),
      y: Number(row[index.y]),
      w: Number(row[index.w]),
      h: Number(row[index.h])
    });
  }
  return frames;
}

function readPngSize(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) throw new Error("Not a PNG file");
  const ihdrType = buffer.toString("ascii", 12, 16);
  if (ihdrType !== "IHDR") throw new Error("Invalid PNG IHDR chunk");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function idToPackId(value) {
  if (typeof value !== "string") return "";
  const match = value.match(/([^/]+)\.json$/);
  return match ? match[1] : value;
}

function normalizeAtlasFrame(frame) {
  return {
    id: Number(frame.tileId ?? frame.id),
    x: Number(frame.x),
    y: Number(frame.y),
    w: Number(frame.width ?? frame.w),
    h: Number(frame.height ?? frame.h)
  };
}

function addIssue(level, code, message, detail, issues) {
  issues.push({ level, code, message, detail: detail || {} });
}

function uniqueSorted(values) {
  return [...new Set([...values].map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
}

function getArg(name) {
  const arg = args.find((item) => item.startsWith(`${name}=`));
  return arg ? arg.split("=").slice(1).join("=") : null;
}
