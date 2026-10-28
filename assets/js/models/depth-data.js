export const DEPTH_MODEL_REVISION = "c3b67641fd837b2368757101311e5d21e511441e";
export const DEPTH_MODEL_ROOT = `https://huggingface.co/onnx-community/depth-anything-v2-small-ONNX/resolve/${DEPTH_MODEL_REVISION}/onnx/`;

// Preserve aspect ratio and cap the longest side, keeping both dimensions on
// the checkpoint's 14-pixel patch grid. No square stretching of the photo.
export function depthInputSize(width, height, limit = 518) {
  if (!(width > 0 && height > 0)) throw new RangeError("The image is empty.");
  const scale = limit / Math.max(width, height);
  return [
    Math.max(14, Math.round((width * scale) / 14) * 14),
    Math.max(14, Math.round((height * scale) / 14) * 14),
  ];
}

export function imagenetRgb(rgba, width, height) {
  const size = width * height,
    data = new Float32Array(3 * size);
  const mean = [0.485, 0.456, 0.406],
    std = [0.229, 0.224, 0.225];
  for (let c = 0; c < 3; c++)
    for (let i = 0; i < size; i++)
      data[c * size + i] = (rgba[4 * i + c] / 255 - mean[c]) / std[c];
  return data;
}

export function normalizeDepth(values) {
  let min = Infinity,
    max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value))
      throw new Error("The depth map contains non-finite values.");
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!values.length) throw new Error("The depth map is empty.");
  const range = max - min;
  return Float32Array.from(values, (x) =>
    range > 1e-6 ? (x - min) / range : 0.5,
  );
}

export function blurredLuminance(rgba, width, height) {
  let values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i++)
    values[i] =
      (0.2126 * rgba[4 * i] +
        0.7152 * rgba[4 * i + 1] +
        0.0722 * rgba[4 * i + 2]) /
      255;
  const kernel = [1, 4, 6, 4, 1];
  for (let pass = 0; pass < 3; pass++) {
    for (const horizontal of [true, false]) {
      const next = new Float32Array(values.length);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          let sum = 0;
          for (let k = -2; k <= 2; k++) {
            const sx = Math.max(
              0,
              Math.min(width - 1, x + (horizontal ? k : 0)),
            );
            const sy = Math.max(
              0,
              Math.min(height - 1, y + (horizontal ? 0 : k)),
            );
            sum += values[sy * width + sx] * kernel[k + 2];
          }
          next[y * width + x] = sum / 16;
        }
      values = next;
    }
  }
  return normalizeDepth(values);
}
