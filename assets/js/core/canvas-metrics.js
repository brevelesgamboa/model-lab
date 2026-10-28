import { analyzePixels } from "./canvas-statistics.js";

const metricCanvas = document.createElement("canvas");
metricCanvas.width = 96;
metricCanvas.height = 96;
const metricContext = metricCanvas.getContext("2d", {
  alpha: false,
  willReadFrequently: true,
});

export function analyzeCanvas(sourceCanvas) {
  const { width, height } = metricCanvas;
  metricContext.imageSmoothingEnabled = true;
  metricContext.clearRect(0, 0, width, height);
  metricContext.drawImage(sourceCanvas, 0, 0, width, height);
  return analyzePixels(
    metricContext.getImageData(0, 0, width, height).data,
    width,
    height,
  );
}
