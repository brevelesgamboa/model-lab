import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

// Repackages one published checkpoint; it does not train or requantize weights.
export const upstream = Object.freeze({
  repository: "https://github.com/distillpub/post--selforg-textures",
  commit: "24ef9c1eaf3bda8360abc331d5d9509bb7b2a1f1",
  path: "public/demo/models.json",
  sha256: "32fdd6d0ae6434185abf166b86bb4b75dcf3a0ecbf1c1646e3b1b3ae03b41bee",
  model: "mixed4c_439",
  index: 41,
  license: "CC-BY-4.0",
  authors: [
    "Eyvind Niklasson",
    "Alexander Mordvintsev",
    "Ettore Randazzo",
    "Michael Levin",
  ],
});

const sourceUrl =
  `https://raw.githubusercontent.com/distillpub/post--selforg-textures/` +
  `${upstream.commit}/${upstream.path}`;
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const checkpointPath = path.join(
  projectRoot,
  "models",
  "neural-growth",
  "checkpoint.json",
);
const maxSourceBytes = 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const layerProfiles = [
  { shape: [49, 96], layout: [13, 6], scale: 2.0086004734039307 },
  { shape: [97, 12], layout: [65, 2], scale: 1.2275338172912598 },
];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= diagonalDistance) {
    return left;
  }
  return aboveDistance <= diagonalDistance ? above : upperLeft;
}

/** Decode raw parameter bytes, without image color correction or resampling. */
export function decodeRgbaPng(bytes, expectedWidth, expectedHeight) {
  if (
    !Number.isInteger(expectedWidth) ||
    !Number.isInteger(expectedHeight) ||
    expectedWidth < 1 ||
    expectedHeight < 1 ||
    expectedWidth > 1024 ||
    expectedHeight > 1024
  ) {
    throw new Error("PNG dimensions must be bounded positive integers.");
  }
  const png = Buffer.from(bytes);
  if (png.length > maxSourceBytes || !png.subarray(0, 8).equals(pngSignature)) {
    throw new Error("Invalid or oversized parameter PNG.");
  }
  const compressed = [];
  let offset = 8;
  let sawHeader = false;
  let sawData = false;
  let endedData = false;
  let sawEnd = false;
  while (offset < png.length) {
    if (offset + 12 > png.length) {
      throw new Error("Truncated PNG chunk.");
    }
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) {
      throw new Error("PNG chunk exceeds its input buffer.");
    }
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, end - 4);
    if (
      crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)
    ) {
      throw new Error(`Invalid ${type} PNG chunk checksum.`);
    }
    if (!sawHeader && type !== "IHDR") {
      throw new Error("PNG must begin with IHDR.");
    }
    if (type === "IHDR") {
      if (sawHeader || length !== 13) {
        throw new Error("Invalid PNG header.");
      }
      if (
        data.readUInt32BE(0) !== expectedWidth ||
        data.readUInt32BE(4) !== expectedHeight ||
        data[8] !== 8 ||
        data[9] !== 6 ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      ) {
        throw new Error(
          "Expected an exact-size, noninterlaced 8-bit RGBA PNG.",
        );
      }
      sawHeader = true;
    } else if (type === "IDAT") {
      if (endedData) {
        throw new Error("PNG image data must use consecutive IDAT chunks.");
      }
      sawData = true;
      compressed.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || !sawData || end !== png.length) {
        throw new Error("Invalid PNG end marker.");
      }
      sawEnd = true;
    } else {
      if (sawData) endedData = true;
      if ((png[offset + 4] & 32) === 0) {
        throw new Error(`Unsupported critical PNG chunk: ${type}.`);
      }
    }
    offset = end;
  }
  if (!sawHeader || !sawData || !sawEnd) {
    throw new Error("Incomplete parameter PNG.");
  }

  const stride = expectedWidth * 4;
  const inflatedLength = (stride + 1) * expectedHeight;
  const scanlines = inflateSync(Buffer.concat(compressed), {
    maxOutputLength: inflatedLength,
  });
  if (scanlines.length !== inflatedLength) {
    throw new Error("PNG scanline length does not match its dimensions.");
  }
  const pixels = Buffer.alloc(stride * expectedHeight);
  for (let row = 0; row < expectedHeight; row += 1) {
    const scanlineOffset = row * (stride + 1);
    const filter = scanlines[scanlineOffset];
    if (filter > 4) {
      throw new Error(`Unsupported PNG scanline filter: ${filter}.`);
    }
    for (let column = 0; column < stride; column += 1) {
      const index = row * stride + column;
      const left = column >= 4 ? pixels[index - 4] : 0;
      const above = row > 0 ? pixels[index - stride] : 0;
      const upperLeft = row > 0 && column >= 4 ? pixels[index - stride - 4] : 0;
      const predictor =
        filter === 1
          ? left
          : filter === 2
            ? above
            : filter === 3
              ? Math.floor((left + above) / 2)
              : filter === 4
                ? paeth(left, above, upperLeft)
                : 0;
      pixels[index] =
        (scanlines[scanlineOffset + column + 1] + predictor) & 255;
    }
  }
  return pixels;
}

export function extractCheckpoint(sourceBytes) {
  const source = Buffer.from(sourceBytes);
  if (
    source.length > maxSourceBytes ||
    createHash("sha256").update(source).digest("hex") !== upstream.sha256
  ) {
    throw new Error("Upstream model bundle does not match its pinned SHA-256.");
  }
  const bundle = JSON.parse(source.toString("utf8"));
  if (
    bundle.model_names?.[upstream.index] !== upstream.model ||
    bundle.layers?.length !== layerProfiles.length
  ) {
    throw new Error("Upstream checkpoint identity or layer count changed.");
  }
  const layers = layerProfiles.map((profile, index) => {
    const layer = bundle.layers[index];
    if (
      JSON.stringify(layer.shape) !== JSON.stringify(profile.shape) ||
      JSON.stringify(layer.layout) !== JSON.stringify(profile.layout) ||
      layer.scale !== profile.scale ||
      !/^data:image\/PNG;base64,[A-Za-z0-9+/]+={0,2}$/.test(layer.data)
    ) {
      throw new Error(`Unexpected layer ${index} architecture or encoding.`);
    }
    const [inputCount, outputCount] = profile.shape;
    const tileWidth = outputCount / 4;
    const width = tileWidth * profile.layout[0];
    const height = inputCount * profile.layout[1];
    const png = Buffer.from(layer.data.split(",")[1], "base64");
    const pixels = decodeRgbaPng(png, width, height);
    const originX = (upstream.index % profile.layout[0]) * tileWidth;
    const originY = Math.floor(upstream.index / profile.layout[0]) * inputCount;
    const weights = [];
    for (let row = 0; row < inputCount; row += 1) {
      const start = ((originY + row) * width + originX) * 4;
      weights.push(...pixels.subarray(start, start + outputCount));
    }
    return { shape: [...profile.shape], scale: profile.scale, weights };
  });
  return {
    format: "latent-field-texture-nca-v1",
    id: "mixed4c-439",
    name: "Vesicle Study",
    source: { ...upstream, authors: [...upstream.authors] },
    layers,
  };
}

async function fetchSource() {
  const response = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Checkpoint download failed: HTTP ${response.status}.`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxSourceBytes) {
      throw new Error("Upstream model bundle exceeded the download limit.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBoundedFile(filePath) {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxSourceBytes) {
      throw new Error("Expected a regular JSON file no larger than 1 MiB.");
    }
    // Bound allocation and reads even if the file grows after the size check.
    const buffer = Buffer.alloc(maxSourceBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maxSourceBytes) {
      throw new Error("JSON file exceeded the 1 MiB input limit.");
    }
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const check = args[0] === "--check";
  if (check) args.shift();
  let localSource;
  if (args.length === 2 && args[0] === "--source") {
    localSource = path.resolve(args[1]);
  } else if (args.length !== 0) {
    throw new Error(
      "Usage: node tools/prepare-neural-growth.mjs [--check] [--source <bundle.json>]",
    );
  }
  const checkpoint = extractCheckpoint(
    localSource ? await readBoundedFile(localSource) : await fetchSource(),
  );
  const serialized = `${JSON.stringify(checkpoint, null, 2)}\n`;
  if (check) {
    const existing = (await readBoundedFile(checkpointPath)).toString("utf8");
    if (existing !== serialized) {
      throw new Error(
        "Checked-in checkpoint differs from its pinned extraction.",
      );
    }
    console.log(`Verified ${upstream.model}: 5,868 quantized parameter bytes.`);
    return;
  }
  await mkdir(path.dirname(checkpointPath), { recursive: true });
  await writeFile(checkpointPath, serialized);
  console.log(`Prepared ${upstream.model}: ${checkpointPath}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
