import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const atlasPngPath = positional[0];
const atlasManifestPath = positional[1];
const packPlanPath = positional[2];
const packsDirArg = getArg("--packs-dir");
const onlyArg = getArg("--only");
const limitFramesArg = getArg("--limit-frames");
const sampleArg = getArg("--sample-mismatches");
const reportPath = getArg("--report");
const failOnDiff = !args.includes("--allow-diff");

if (!atlasPngPath || !atlasManifestPath || !packPlanPath || !packsDirArg) {
  console.error([
    "Usage: node tools/compare-pack-rendering.mjs path/to/tiles-atlas.png path/to/tiles.json path/to/profile-texture-pack-plan.json",
    "  --packs-dir=public/data/profiles/classic-core/packs",
    "  [--only=boot-ui-field,boot-player-core]",
    "  [--limit-frames=500]",
    "  [--sample-mismatches=20]",
    "  [--report=compare-pack-rendering-report.json]",
    "  [--allow-diff]"
  ].join("\n"));
  process.exit(1);
}

const packsDir = path.resolve(packsDirArg);
const only = onlyArg ? new Set(onlyArg.split(",").map((item) => item.trim()).filter(Boolean)) : null;
const limitFrames = limitFramesArg ? Number(limitFramesArg) : 0;
const sampleLimit = sampleArg ? Number(sampleArg) : 20;

const atlasManifest = JSON.parse(fs.readFileSync(atlasManifestPath, "utf8"));
const packPlan = JSON.parse(fs.readFileSync(packPlanPath, "utf8"));
const sourceAtlas = decodePngRgba(fs.readFileSync(atlasPngPath));
const sourceFrameById = new Map(Object.values(atlasManifest.frames || {}).map((frame) => [Number(frame.tileId ?? frame.id), normalizeFrame(frame)]));

if (sourceAtlas.width !== Number(atlasManifest.atlasWidth) || sourceAtlas.height !== Number(atlasManifest.atlasHeight)) {
  throw new Error(`Source atlas png size ${sourceAtlas.width}x${sourceAtlas.height} does not match manifest ${atlasManifest.atlasWidth}x${atlasManifest.atlasHeight}`);
}

const results = [];
let checkedFrames = 0;
let exactFrames = 0;
let mismatchedFrames = 0;
let missingSourceFrames = 0;
let missingPackFrames = 0;
const mismatches = [];

for (const pack of packPlan.packs || []) {
  if (only && !only.has(pack.id)) continue;
  if (limitFrames > 0 && checkedFrames >= limitFrames) break;

  const manifestPath = path.join(packsDir, `${pack.id}.json`);
  const pngPath = path.join(packsDir, `${pack.id}.png`);
  if (!fs.existsSync(manifestPath) || !fs.existsSync(pngPath)) {
    results.push({
      id: pack.id,
      status: "missing-pack-files",
      manifestExists: fs.existsSync(manifestPath),
      pngExists: fs.existsSync(pngPath)
    });
    continue;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const packAtlas = decodePngRgba(fs.readFileSync(pngPath));
  const packFrameById = new Map(parseCompactFrames(manifest).map((frame) => [frame.id, frame]));

  let packChecked = 0;
  let packExact = 0;
  let packMismatch = 0;
  for (const id of uniqueSorted(pack.presentIds || pack.ids || [])) {
    if (limitFrames > 0 && checkedFrames >= limitFrames) break;
    const sourceFrame = sourceFrameById.get(Number(id));
    const packFrame = packFrameById.get(Number(id));
    checkedFrames += 1;
    packChecked += 1;

    if (!sourceFrame) {
      missingSourceFrames += 1;
      mismatchedFrames += 1;
      packMismatch += 1;
      pushMismatch({
        packId: pack.id,
        frameId: Number(id),
        reason: "missing-source-frame"
      });
      continue;
    }
    if (!packFrame) {
      missingPackFrames += 1;
      mismatchedFrames += 1;
      packMismatch += 1;
      pushMismatch({
        packId: pack.id,
        frameId: Number(id),
        reason: "missing-pack-frame"
      });
      continue;
    }

    const diff = compareFramePixels({
      sourceAtlas,
      packAtlas,
      sourceFrame,
      packFrame
    });
    if (diff.changedPixels === 0) {
      exactFrames += 1;
      packExact += 1;
    } else {
      mismatchedFrames += 1;
      packMismatch += 1;
      pushMismatch({
        packId: pack.id,
        frameId: Number(id),
        reason: "pixel-mismatch",
        changedPixels: diff.changedPixels,
        totalPixels: diff.totalPixels,
        sample: diff.sample
      });
    }
  }

  results.push({
    id: pack.id,
    status: "checked",
    framesChecked: packChecked,
    exactFrames: packExact,
    mismatchedFrames: packMismatch
  });
}

const summary = {
  packsChecked: results.filter((item) => item.status === "checked").length,
  checkedFrames,
  exactFrames,
  mismatchedFrames,
  exactRatio: ratio(exactFrames, checkedFrames),
  missingSourceFrames,
  missingPackFrames,
  mismatchSamples: mismatches.length
};

const report = {
  v: 1,
  source: {
    atlasPngPath: path.resolve(atlasPngPath),
    atlasManifestPath: path.resolve(atlasManifestPath),
    packPlanPath: path.resolve(packPlanPath),
    packsDir,
    only: only ? [...only] : null,
    limitFrames,
    sampleLimit,
    failOnDiff
  },
  summary,
  results,
  mismatches
};

const text = `${JSON.stringify(report, null, 2)}\n`;
if (reportPath) {
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  fs.writeFileSync(reportPath, text);
} else {
  process.stdout.write(text);
}

if (failOnDiff && mismatchedFrames > 0) process.exit(1);

function pushMismatch(mismatch) {
  if (mismatches.length < sampleLimit) mismatches.push(mismatch);
}

function compareFramePixels({ sourceAtlas, packAtlas, sourceFrame, packFrame }) {
  if (sourceFrame.w !== packFrame.w || sourceFrame.h !== packFrame.h) {
    return {
      changedPixels: sourceFrame.w * sourceFrame.h,
      totalPixels: sourceFrame.w * sourceFrame.h,
      sample: {
        reason: "size-mismatch",
        source: { w: sourceFrame.w, h: sourceFrame.h },
        pack: { w: packFrame.w, h: packFrame.h }
      }
    };
  }
  if (!frameWithin(sourceAtlas, sourceFrame) || !frameWithin(packAtlas, packFrame)) {
    return {
      changedPixels: sourceFrame.w * sourceFrame.h,
      totalPixels: sourceFrame.w * sourceFrame.h,
      sample: { reason: "out-of-bounds" }
    };
  }

  let changedPixels = 0;
  const totalPixels = sourceFrame.w * sourceFrame.h;
  let sample = null;
  for (let row = 0; row < sourceFrame.h; row += 1) {
    for (let col = 0; col < sourceFrame.w; col += 1) {
      const sourceIdx = ((sourceFrame.y + row) * sourceAtlas.width + (sourceFrame.x + col)) * 4;
      const packIdx = ((packFrame.y + row) * packAtlas.width + (packFrame.x + col)) * 4;
      const sr = sourceAtlas.rgba[sourceIdx];
      const sg = sourceAtlas.rgba[sourceIdx + 1];
      const sb = sourceAtlas.rgba[sourceIdx + 2];
      const sa = sourceAtlas.rgba[sourceIdx + 3];
      const pr = packAtlas.rgba[packIdx];
      const pg = packAtlas.rgba[packIdx + 1];
      const pb = packAtlas.rgba[packIdx + 2];
      const pa = packAtlas.rgba[packIdx + 3];
      if (sr !== pr || sg !== pg || sb !== pb || sa !== pa) {
        changedPixels += 1;
        if (!sample) {
          sample = {
            x: col,
            y: row,
            source: [sr, sg, sb, sa],
            pack: [pr, pg, pb, pa]
          };
        }
      }
    }
  }
  return { changedPixels, totalPixels, sample };
}

function frameWithin(image, frame) {
  return frame.x >= 0
    && frame.y >= 0
    && frame.w > 0
    && frame.h > 0
    && frame.x + frame.w <= image.width
    && frame.y + frame.h <= image.height;
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

function normalizeFrame(frame) {
  return {
    id: Number(frame.tileId ?? frame.id),
    x: Number(frame.x),
    y: Number(frame.y),
    w: Number(frame.width ?? frame.w),
    h: Number(frame.height ?? frame.h)
  };
}

function decodePngRgba(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) throw new Error("Not a PNG file");

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}`);
  }

  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const rowBytes = width * 4;
  const expected = (rowBytes + 1) * height;
  if (inflated.length < expected) throw new Error(`PNG data too short: ${inflated.length} < ${expected}`);
  const rgba = Buffer.alloc(width * height * 4);

  let input = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[input];
    input += 1;
    const outStart = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[input + x];
      const left = x >= 4 ? rgba[outStart + x - 4] : 0;
      const up = y > 0 ? rgba[outStart + x - rowBytes] : 0;
      const upLeft = y > 0 && x >= 4 ? rgba[outStart + x - rowBytes - 4] : 0;
      rgba[outStart + x] = unfilterByte(filter, raw, left, up, upLeft);
    }
    input += rowBytes;
  }
  return { width, height, rgba };
}

function unfilterByte(filter, raw, left, up, upLeft) {
  switch (filter) {
    case 0:
      return raw;
    case 1:
      return (raw + left) & 0xff;
    case 2:
      return (raw + up) & 0xff;
    case 3:
      return (raw + Math.floor((left + up) / 2)) & 0xff;
    case 4:
      return (raw + paeth(left, up, upLeft)) & 0xff;
    default:
      throw new Error(`Unsupported PNG filter ${filter}`);
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function uniqueSorted(values) {
  return [...new Set([...values].map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
}

function ratio(value, total) {
  return total ? Number((value / total).toFixed(4)) : 0;
}

function getArg(name) {
  const arg = args.find((item) => item.startsWith(`${name}=`));
  return arg ? arg.split("=").slice(1).join("=") : null;
}
