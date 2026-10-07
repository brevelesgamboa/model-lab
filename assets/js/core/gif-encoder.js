class ByteWriter {
  constructor() {
    this.bytes = [];
  }

  byte(value) {
    this.bytes.push(value & 0xff);
  }

  bytesFrom(values) {
    for (const value of values) this.byte(value);
  }

  word(value) {
    this.byte(value);
    this.byte(value >> 8);
  }

  ascii(text) {
    for (let index = 0; index < text.length; index += 1) {
      this.byte(text.charCodeAt(index));
    }
  }

  toUint8Array() {
    return Uint8Array.from(this.bytes);
  }
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.buffer = 0;
    this.bitCount = 0;
  }

  write(code, size) {
    this.buffer |= code << this.bitCount;
    this.bitCount += size;
    while (this.bitCount >= 8) {
      this.bytes.push(this.buffer & 0xff);
      this.buffer >>>= 8;
      this.bitCount -= 8;
    }
  }

  finish() {
    if (this.bitCount > 0) this.bytes.push(this.buffer & 0xff);
    return Uint8Array.from(this.bytes);
  }
}

function makePalette332() {
  const palette = new Uint8Array(256 * 3);
  for (let index = 0; index < 256; index += 1) {
    const red = (index >> 5) & 0x07;
    const green = (index >> 2) & 0x07;
    const blue = index & 0x03;
    palette[index * 3] = Math.round((red / 7) * 255);
    palette[index * 3 + 1] = Math.round((green / 7) * 255);
    palette[index * 3 + 2] = Math.round((blue / 3) * 255);
  }
  return palette;
}

function rgbaToIndexed332(rgba, width, height) {
  const pixelCount = width * height;
  if (rgba.length < pixelCount * 4)
    throw new Error("GIF frame data is too short.");
  const indexed = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    const r = rgba[offset] >> 5;
    const g = rgba[offset + 1] >> 5;
    const b = rgba[offset + 2] >> 6;
    indexed[pixel] = (r << 5) | (g << 2) | b;
  }
  return indexed;
}

function lzwEncode(indices, minimumCodeSize = 8) {
  if (!indices.length) return new Uint8Array();

  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  let nextCode = endCode + 1;
  let codeSize = minimumCodeSize + 1;
  let codeLimit = 1 << codeSize;
  const dictionary = new Map();
  const writer = new BitWriter();

  const reset = () => {
    dictionary.clear();
    nextCode = endCode + 1;
    codeSize = minimumCodeSize + 1;
    codeLimit = 1 << codeSize;
  };

  writer.write(clearCode, codeSize);
  let prefix = indices[0];

  for (let index = 1; index < indices.length; index += 1) {
    const suffix = indices[index];
    const key = prefix * 256 + suffix;
    const existing = dictionary.get(key);

    if (existing !== undefined) {
      prefix = existing;
      continue;
    }

    writer.write(prefix, codeSize);

    if (nextCode < 4096) {
      dictionary.set(key, nextCode);
      nextCode += 1;
      if (nextCode > codeLimit && codeSize < 12) {
        codeSize += 1;
        codeLimit <<= 1;
      }
    } else {
      writer.write(clearCode, codeSize);
      reset();
    }

    prefix = suffix;
  }

  writer.write(prefix, codeSize);
  writer.write(endCode, codeSize);
  return writer.finish();
}

function writeSubBlocks(writer, data) {
  for (let offset = 0; offset < data.length; offset += 255) {
    const block = data.subarray(offset, Math.min(data.length, offset + 255));
    writer.byte(block.length);
    writer.bytesFrom(block);
  }
  writer.byte(0);
}

function delay() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

export async function encodeAnimatedGif({
  frames,
  width,
  height,
  fps = 12,
  loop = 0,
  onProgress = () => {},
}) {
  if (!Array.isArray(frames) || frames.length < 1)
    throw new Error("At least one GIF frame is required.");
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error("Invalid GIF dimensions.");
  }

  const writer = new ByteWriter();
  const palette = makePalette332();
  const frameDelay = Math.max(2, Math.round(100 / Math.max(1, fps)));

  writer.ascii("GIF89a");
  writer.word(width);
  writer.word(height);
  writer.byte(0xf7); // global palette, 8-bit color resolution, 256 entries
  writer.byte(0);
  writer.byte(0);
  writer.bytesFrom(palette);

  // Netscape loop extension.
  writer.byte(0x21);
  writer.byte(0xff);
  writer.byte(0x0b);
  writer.ascii("NETSCAPE2.0");
  writer.byte(0x03);
  writer.byte(0x01);
  writer.word(loop);
  writer.byte(0x00);

  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex];
    const rgba = frame instanceof ImageData ? frame.data : frame;
    const indexed = rgbaToIndexed332(rgba, width, height);
    const compressed = lzwEncode(indexed, 8);

    // Graphic control extension.
    writer.byte(0x21);
    writer.byte(0xf9);
    writer.byte(0x04);
    writer.byte(0x04); // keep previous frame; no transparency
    writer.word(frameDelay);
    writer.byte(0x00);
    writer.byte(0x00);

    // Image descriptor.
    writer.byte(0x2c);
    writer.word(0);
    writer.word(0);
    writer.word(width);
    writer.word(height);
    writer.byte(0x00);

    writer.byte(0x08);
    writeSubBlocks(writer, compressed);

    onProgress((frameIndex + 1) / frames.length);
    if (frameIndex % 3 === 2) await delay();
  }

  writer.byte(0x3b);
  return new Blob([writer.toUint8Array()], { type: "image/gif" });
}
