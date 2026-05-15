import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

let crcTable = null;

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const atlasPngPath = positional[0];
const atlasManifestPath = positional[1];
const packPlanPath = positional[2];
const outDir = getArg("--out-dir");
const onlyArg = getArg("--only");
const limitArg = getArg("--limit");
const reportPath = getArg("--report");
const compressionLevel = Number(getArg("--compression-level") || 9);
const verifyOutput = args.includes("--verify-output");

if (!atlasPngPath || !atlasManifestPath || !packPlanPath || !outDir) {
  console.error([
    "Usage: node tools/build-texture-packs-from-atlas.mjs path/to/tiles-atlas.png path/to/tiles.json path/to/profile-texture-pack-plan.json",
    "  --out-dir=public/data/profiles/classic-core/packs",
    "  [--only=boot-ui-field,boot-player-core]",
    "  [--limit=5]",
    "  [--report=pack-build-report.json]",
    "  [--compression-level=9]",
    "  [--verify-output]",
    "",
    "This is the RGBA bridge builder. For final indexed PNG packs, wire the same pack plan to extractor-retained indexed pixels."
  ].join("\n"));
  process.exit(1);
}

const only = onlyArg ? new Set(onlyArg.split(",").map((item) => item.trim()).filter(Boolean)) : null;
const limit = limitArg ? Number(limitArg) : null;
const atlasManifest = JSON.parse(fs.readFileSync(atlasManifestPath, "utf8"));
const packPlan = JSON.parse(fs.readFileSync(packPlanPath, "utf8"));
const sourceImage = decodePngRgba(fs.readFileSync(atlasPngPath));
const frameById = new Map(Object.values(atlasManifest.frames || {}).map((frame) => [Number(frame.tileId ?? frame.id), normalizeFrame(frame)]));

if (sourceImage.width !== atlasManifest.atlasWidth || sourceImage.height !== atlasManifest.atlasHeight) {
  throw new Error(`PNG size ${sourceImage.width}x${sourceImage.height} does not match manifest ${atlasManifest.atlasWidth}x${atlasManifest.atlasHeight}`);
}

fs.mkdirSync(outDir, { recursive: true });

const selectedPacks = [];
for (const pack of packPlan.packs || []) {
  if (only && !only.has(pack.id)) continue;
  selectedPacks.push(pack);
  if (limit && selectedPacks.length >= limit) break;
}

const built = [];
for (const pack of selectedPacks) {
  const result = buildPack(pack);
  built.push(result);
}

const report = {
  v: 1,
  source: {
    atlasPngPath,
    atlasManifestPath,
    packPlanPath,
    outDir,
    only: only ? [...only] : null,
    limit,
    format: "rgba-png-bridge",
    verifyOutput
  },
  summary: {
    sourceAtlasBytes: fs.statSync(atlasPngPath).size,
    plannedPacks: packPlan.packs?.length || 0,
    builtPacks: built.length,
    builtFrames: built.reduce((sum, pack) => sum + pack.frames, 0),
    builtFrameArea: built.reduce((sum, pack) => sum + pack.frameArea, 0),
    builtPngBytes: built.reduce((sum, pack) => sum + pack.pngBytes, 0),
    builtManifestBytes: built.reduce((sum, pack) => sum + pack.manifestBytes, 0),
    builtManifestGzipBytes: built.reduce((sum, pack) => sum + pack.manifestGzipBytes, 0)
  },
  packs: built
};

const reportText = `${JSON.stringify(report, null, 2)}\n`;
if (reportPath) {
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  fs.writeFileSync(reportPath, reportText);
} else {
  process.stdout.write(reportText);
}

function buildPack(pack) {
  const frames = uniqueSorted(pack.presentIds || pack.ids || [])
    .map((id) => frameById.get(Number(id)))
    .filter(Boolean)
    .sort(byHeight);
  if (!frames.length) throw new Error(`Pack ${pack.id} has no source frames`);

  const width = Math.max(pack.rowPack?.width || 0, ...frames.map((frame) => frame.width));
  const placements = rowPack(frames, width);
  const outRgba = Buffer.alloc(width * placements.height * 4);
  const manifestFrames = [];

  for (const placement of placements.frames) {
    copyFrame(sourceImage, outRgba, width, placement);
    manifestFrames.push({
      ...placement.frame,
      x: placement.x,
      y: placement.y
    });
  }

  const png = encodeRgbaPng(width, placements.height, outRgba, { compressionLevel });
  if (verifyOutput) verifyPngRoundTrip(png, width, placements.height, pack.id);
  const manifest = compactManifest({
    image: `${pack.id}.png`,
    atlasWidth: width,
    atlasHeight: placements.height,
    frames: manifestFrames
  });
  const manifestText = `${JSON.stringify(manifest)}\n`;
  const pngPath = path.join(outDir, `${pack.id}.png`);
  const manifestPath = path.join(outDir, `${pack.id}.json`);
  fs.writeFileSync(pngPath, png);
  fs.writeFileSync(manifestPath, manifestText);

  return {
    id: pack.id,
    domain: pack.domain,
    load: pack.load,
    floor: pack.floor,
    region: pack.region,
    image: pngPath,
    manifest: manifestPath,
    frames: frames.length,
    width,
    height: placements.height,
    frameArea: sumArea(frames),
    rowPackArea: width * placements.height,
    fillRatio: ratio(sumArea(frames), width * placements.height),
    pngBytes: png.length,
    manifestBytes: Buffer.byteLength(manifestText),
    manifestGzipBytes: zlib.gzipSync(Buffer.from(manifestText), { level: 9 }).length,
    verified: verifyOutput
  };
}

function verifyPngRoundTrip(png, width, height, packId) {
  const decoded = decodePngRgba(png);
  if (decoded.width !== width || decoded.height !== height) {
    throw new Error(`Pack ${packId} PNG verify failed: ${decoded.width}x${decoded.height} !== ${width}x${height}`);
  }
}

function copyFrame(source, target, targetWidth, placement) {
  const frame = placement.frame;
  if (frame.x < 0 || frame.y < 0 || frame.x + frame.width > source.width || frame.y + frame.height > source.height) {
    throw new Error(`Frame ${frame.id} is outside source atlas bounds`);
  }
  for (let row = 0; row < frame.height; row += 1) {
    const sourceStart = ((frame.y + row) * source.width + frame.x) * 4;
    const targetStart = ((placement.y + row) * targetWidth + placement.x) * 4;
    source.rgba.copy(target, targetStart, sourceStart, sourceStart + frame.width * 4);
  }
}

function rowPack(frames, width) {
  let x = 0;
  let y = 0;
  let rowH = 0;
  const placements = [];
  for (const frame of frames) {
    if (x > 0 && x + frame.width > width) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    placements.push({ frame, x, y });
    x += frame.width;
    rowH = Math.max(rowH, frame.height);
  }
  return { width, height: y + rowH, frames: placements };
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

function compactManifest({ image, atlasWidth, atlasHeight, frames }) {
  return {
    v: 1,
    image,
    w: atlasWidth,
    h: atlasHeight,
    fields: ["id", "x", "y", "w", "h", "xo", "yo", "hit", "prio", "bitmap", "graphic"],
    frames: frames.map((frame) => [
      frame.id,
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      frame.xoffset,
      frame.yoffset,
      frame.hit,
      frame.prioType,
      frame.bitmapNo,
      frame.graphicNo
    ])
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
    throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}. Expected 8-bit RGBA non-interlaced PNG.`);
  }

  const bytesPerPixel = 4;
  const rowBytes = width * bytesPerPixel;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
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
      const left = x >= bytesPerPixel ? rgba[outStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? rgba[outStart + x - rowBytes] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? rgba[outStart + x - rowBytes - bytesPerPixel] : 0;
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

function encodeRgbaPng(width, height, rgba, options = {}) {
  if (rgba.length !== width * height * 4) throw new Error(`RGBA length does not match ${width}x${height}`);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * width * 4;
    const targetStart = y * (width * 4 + 1);
    raw[targetStart] = 0;
    rgba.copy(raw, targetStart + 1, sourceStart, sourceStart + width * 4);
  }
  const chunks = [
    chunk("IHDR", Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])),
    chunk("IDAT", zlib.deflateSync(raw, { level: options.compressionLevel ?? 9 })),
    chunk("IEND", Buffer.alloc(0))
  ];
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), ...chunks]);
}

function chunk(type, data) {
  const name = Buffer.from(type);
  return Buffer.concat([u32(data.length), name, data, u32(crc32(Buffer.concat([name, data])))]);
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0);
  return buf;
}

function crc32(buf) {
  if (!crcTable) crcTable = makeCrcTable();
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeCrcTable() {
  return new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    return c >>> 0;
  });
}

function getArg(name) {
  const arg = args.find((item) => item.startsWith(`${name}=`));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

function byHeight(a, b) {
  return b.height - a.height || b.width - a.width || a.id - b.id;
}

function uniqueSorted(values) {
  return [...new Set([...values].map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
}

function sumArea(frames) {
  return frames.reduce((sum, frame) => sum + frame.width * frame.height, 0);
}

function ratio(value, total) {
  return total ? Number((value / total).toFixed(4)) : 0;
}
