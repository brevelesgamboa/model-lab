export const NEURAL_INPUT_SIZE = 128;
export const PCA_INPUT_SIZE = 48;

export function validateRgbSample(pixels, size = NEURAL_INPUT_SIZE) {
  if (!(pixels instanceof Float32Array) && !Array.isArray(pixels)) {
    throw new Error("Training sample must contain RGB float pixels.");
  }
  if (pixels.length !== size * size * 3) {
    throw new Error(`Expected ${size} × ${size} RGB sample data.`);
  }
}

export function resampleRgbPixels(pixels, sourceSize, targetSize) {
  validateRgbSample(pixels, sourceSize);
  if (sourceSize === targetSize)
    return pixels instanceof Float32Array
      ? pixels.slice()
      : Float32Array.from(pixels);

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = sourceSize;
  sourceCanvas.height = sourceSize;
  const sourceContext = sourceCanvas.getContext("2d", { alpha: false });
  const image = sourceContext.createImageData(sourceSize, sourceSize);
  for (let pixel = 0; pixel < sourceSize * sourceSize; pixel += 1) {
    const src = pixel * 3;
    const dst = pixel * 4;
    image.data[dst] = Math.round(Math.max(0, Math.min(1, pixels[src])) * 255);
    image.data[dst + 1] = Math.round(
      Math.max(0, Math.min(1, pixels[src + 1])) * 255,
    );
    image.data[dst + 2] = Math.round(
      Math.max(0, Math.min(1, pixels[src + 2])) * 255,
    );
    image.data[dst + 3] = 255;
  }
  sourceContext.putImageData(image, 0, 0);

  const targetCanvas = document.createElement("canvas");
  targetCanvas.width = targetSize;
  targetCanvas.height = targetSize;
  const targetContext = targetCanvas.getContext("2d", { alpha: false });
  targetContext.imageSmoothingEnabled = true;
  targetContext.imageSmoothingQuality = "high";
  targetContext.drawImage(sourceCanvas, 0, 0, targetSize, targetSize);
  const data = targetContext.getImageData(0, 0, targetSize, targetSize).data;
  const output = new Float32Array(targetSize * targetSize * 3);
  for (let pixel = 0; pixel < targetSize * targetSize; pixel += 1) {
    const src = pixel * 4;
    const dst = pixel * 3;
    output[dst] = data[src] / 255;
    output[dst + 1] = data[src + 1] / 255;
    output[dst + 2] = data[src + 2] / 255;
  }
  return output;
}

export function stackSamples(tf, samples, size = NEURAL_INPUT_SIZE) {
  if (!Array.isArray(samples) || !samples.length)
    throw new Error("No neural training samples were provided.");
  const flat = new Float32Array(samples.length * size * size * 3);
  const stride = size * size * 3;
  samples.forEach((sample, index) => {
    validateRgbSample(sample.pixels || sample, size);
    flat.set(sample.pixels || sample, index * stride);
  });
  return tf.tensor4d(flat, [samples.length, size, size, 3]);
}

export function tensorPixelsToFloat32(tensorData) {
  return tensorData instanceof Float32Array
    ? tensorData.slice()
    : Float32Array.from(tensorData);
}
