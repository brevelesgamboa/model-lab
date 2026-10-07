import { clamp } from "./utils.js";

const metricCanvas = document.createElement("canvas");
metricCanvas.width = 96;
metricCanvas.height = 96;
const metricContext = metricCanvas.getContext("2d", {
  alpha: false,
  willReadFrequently: true,
});

export function analyzeCanvas(sourceCanvas) {
  const width = metricCanvas.width;
  const height = metricCanvas.height;
  metricContext.imageSmoothingEnabled = true;
  metricContext.clearRect(0, 0, width, height);
  metricContext.drawImage(sourceCanvas, 0, 0, width, height);
  const { data } = metricContext.getImageData(0, 0, width, height);

  const luminance = new Float32Array(width * height);
  const histogram = new Uint32Array(64);
  let mean = 0;
  let chroma = 0;

  for (let pixel = 0; pixel < luminance.length; pixel += 1) {
    const index = pixel * 4;
    const r = data[index] / 255;
    const g = data[index + 1] / 255;
    const b = data[index + 2] / 255;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luminance[pixel] = y;
    mean += y;
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
    histogram[Math.min(63, Math.floor(y * 64))] += 1;
  }

  mean /= luminance.length;
  chroma /= luminance.length;

  let variance = 0;
  let horizontalEdges = 0;
  let verticalEdges = 0;
  let edgeSamples = 0;
  let symmetryError = 0;
  let symmetrySamples = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const value = luminance[index];
      variance += (value - mean) ** 2;

      if (x + 1 < width) {
        horizontalEdges += Math.abs(value - luminance[index + 1]);
        edgeSamples += 1;
      }
      if (y + 1 < height) {
        verticalEdges += Math.abs(value - luminance[index + width]);
        edgeSamples += 1;
      }
      if (x < Math.floor(width / 2)) {
        const mirror = y * width + (width - 1 - x);
        symmetryError += Math.abs(value - luminance[mirror]);
        symmetrySamples += 1;
      }
    }
  }

  variance /= luminance.length;
  const deviation = Math.sqrt(variance);
  const edgeDensity = edgeSamples
    ? (horizontalEdges + verticalEdges) / edgeSamples
    : 0;
  symmetryError = symmetrySamples ? symmetryError / symmetrySamples : 0;

  let entropy = 0;
  for (const count of histogram) {
    if (!count) continue;
    const probability = count / luminance.length;
    entropy -= probability * Math.log2(probability);
  }
  entropy /= Math.log2(histogram.length);

  const complexity = clamp(
    entropy * 0.42 +
      clamp(edgeDensity / 0.25) * 0.38 +
      clamp(deviation / 0.32) * 0.2,
  );

  return {
    signalMean: mean,
    signalDeviation: deviation,
    entropy: clamp(entropy),
    edgeDensity: clamp(edgeDensity),
    symmetryError: clamp(symmetryError),
    chroma: clamp(chroma),
    complexity,
  };
}
