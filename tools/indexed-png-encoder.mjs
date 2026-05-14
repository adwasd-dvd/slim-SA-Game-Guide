import zlib from "node:zlib";

export function encodeIndexedPng(width, height, indexes, paletteRgba, options = {}) {
  if (!Number.isInteger(width) || width <= 0) throw new Error("width must be a positive integer");
  if (!Number.isInteger(height) || height <= 0) throw new Error("height must be a positive integer");
  if (!(indexes instanceof Uint8Array) && !Buffer.isBuffer(indexes)) {
    throw new Error("indexes must be a Uint8Array or Buffer");
  }
  if (indexes.length !== width * height) {
    throw new Error(`indexes length ${indexes.length} does not match ${width}x${height}`);
  }
  if (!Array.isArray(paletteRgba) || paletteRgba.length > 256) {
    throw new Error("paletteRgba must be an array with at most 256 RGBA colors");
  }

  const palette = normalizePalette(paletteRgba);
  const compressionLevel = options.compressionLevel ?? 9;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width + 1);
    raw[row] = 0;
    Buffer.from(indexes.buffer, indexes.byteOffset + y * width, width).copy(raw, row + 1);
  }

  const chunks = [
    chunk("IHDR", Buffer.concat([u32(width), u32(height), Buffer.from([8, 3, 0, 0, 0])])),
    chunk("PLTE", Buffer.from(palette.flatMap(([r, g, b]) => [r, g, b]))),
    chunk("tRNS", Buffer.from(palette.map(([, , , a]) => a))),
    chunk("IDAT", zlib.deflateSync(raw, { level: compressionLevel })),
    chunk("IEND", Buffer.alloc(0))
  ];
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), ...chunks]);
}

export function compactFrameManifest({ image, atlasWidth, atlasHeight, frames }) {
  const out = {
    v: 1,
    image,
    w: atlasWidth,
    h: atlasHeight,
    fields: ["id", "x", "y", "w", "h", "xo", "yo", "hit", "prio", "bitmap", "graphic"],
    frames: []
  };
  for (const frame of frames) {
    out.frames.push([
      Number(frame.tileId ?? frame.id),
      frame.x,
      frame.y,
      frame.width ?? frame.w,
      frame.height ?? frame.h,
      frame.xoffset ?? frame.xo ?? 0,
      frame.yoffset ?? frame.yo ?? 0,
      frame.hit ?? 0,
      frame.prioType ?? frame.prio ?? 0,
      frame.bitmapNo ?? frame.bitmap ?? 0,
      frame.graphicNo ?? frame.graphic ?? 0
    ]);
  }
  return out;
}

function normalizePalette(paletteRgba) {
  const out = [];
  for (let i = 0; i < 256; i += 1) {
    const color = paletteRgba[i] || [0, 0, 0, 255];
    out.push([
      clampByte(color[0]),
      clampByte(color[1]),
      clampByte(color[2]),
      clampByte(color[3] ?? 255)
    ]);
  }
  return out;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Number(value) || 0));
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

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

