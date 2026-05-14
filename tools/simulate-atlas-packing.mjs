import fs from "node:fs";
import zlib from "node:zlib";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node tools/simulate-atlas-packing.mjs path/to/tiles.json");
  process.exit(1);
}

const source = fs.readFileSync(file);
const atlas = JSON.parse(source);
const frames = Object.values(atlas.frames || {});
if (!frames.length) throw new Error("No frames found in atlas manifest");

const frameArea = frames.reduce((sum, frame) => sum + frame.width * frame.height, 0);
const atlasArea = atlas.atlasWidth * atlas.atlasHeight;
const largest = [...frames]
  .sort((a, b) => b.width * b.height - a.width * a.height)
  .slice(0, 12)
  .map((frame) => ({
    id: frame.tileId,
    width: frame.width,
    height: frame.height,
    area: frame.width * frame.height,
    bitmapNo: frame.bitmapNo,
    graphicNo: frame.graphicNo
  }));

const compact = compactManifest(atlas, frames);
const compactText = Buffer.from(JSON.stringify(compact));

const report = {
  current: {
    atlasWidth: atlas.atlasWidth,
    atlasHeight: atlas.atlasHeight,
    frames: frames.length,
    frameArea,
    atlasArea,
    fillRatio: Number((frameArea / atlasArea).toFixed(4)),
    manifestBytes: source.length,
    manifestGzipBytes: zlib.gzipSync(source, { level: 9 }).length
  },
  rowPackingEstimates: [1024, 2048, 4096, 8192].map((width) => ({
    width,
    originalOrderHeight: rowPack(frames, width),
    heightSortedHeight: rowPack([...frames].sort((a, b) => b.height - a.height || b.width - a.width), width),
    areaSortedHeight: rowPack([...frames].sort((a, b) => b.width * b.height - a.width * a.height), width)
  })).map((item) => ({
    ...item,
    originalOrderArea: item.width * item.originalOrderHeight,
    heightSortedArea: item.width * item.heightSortedHeight,
    areaSortedArea: item.width * item.areaSortedHeight
  })),
  compactManifest: {
    bytes: compactText.length,
    gzipBytes: zlib.gzipSync(compactText, { level: 9 }).length,
    brotliBytes: zlib.brotliCompressSync(compactText, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
    }).length
  },
  roughBuckets: bucketFrames(frames),
  largest
};

console.log(JSON.stringify(report, null, 2));

function rowPack(items, width) {
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

function compactManifest(atlas, frames) {
  return {
    v: 1,
    image: atlas.image,
    w: atlas.atlasWidth,
    h: atlas.atlasHeight,
    fields: ["id", "x", "y", "w", "h", "xo", "yo", "hit", "prio", "bitmap", "graphic"],
    frames: frames.map((frame) => [
      Number(frame.tileId),
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      frame.xoffset ?? 0,
      frame.yoffset ?? 0,
      frame.hit ?? 0,
      frame.prioType ?? 0,
      frame.bitmapNo ?? 0,
      frame.graphicNo ?? 0
    ])
  };
}

function bucketFrames(frames) {
  const buckets = {
    mapLikeTileIdBelow10000: { count: 0, area: 0 },
    playerKnownRange: { count: 0, area: 0 },
    largeAreaOver40000: { count: 0, area: 0 },
    uiLikeTileIdAtLeast25000: { count: 0, area: 0 },
    other: { count: 0, area: 0 }
  };

  for (const frame of frames) {
    const area = frame.width * frame.height;
    let bucket = buckets.other;
    if (frame.tileId >= 10201 && frame.tileId <= 10518) bucket = buckets.playerKnownRange;
    else if (frame.tileId >= 25000) bucket = buckets.uiLikeTileIdAtLeast25000;
    else if (frame.tileId < 10000) bucket = buckets.mapLikeTileIdBelow10000;
    else if (area > 40000) bucket = buckets.largeAreaOver40000;
    bucket.count += 1;
    bucket.area += area;
  }
  return buckets;
}

