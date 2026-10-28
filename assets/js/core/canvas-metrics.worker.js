import { analyzePixels } from "./canvas-statistics.js";

const canvas = new OffscreenCanvas(96, 96);
const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
self.onmessage = ({ data: { id, bitmap } }) => {
  try {
    ctx.clearRect(0, 0, 96, 96);
    ctx.drawImage(bitmap, 0, 0, 96, 96);
    const metrics = analyzePixels(ctx.getImageData(0, 0, 96, 96).data, 96, 96);
    self.postMessage({ id, metrics });
  } finally {
    bitmap.close();
  }
};
