import { clamp } from "./utils.js";

const DEFAULT_MOSH_AMOUNT = 0.34;
const PIXEL_CLUSTER_SIZE = 3;

function cellNoise(x, y, salt = 0) {
  let value = Math.imul(x + 1 + salt * 17, 374761393);
  value ^= Math.imul(y + 1 + salt * 29, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

export function applyDatamosh(canvas, scratchCanvas, enabled = true) {
  if (!enabled) return;
  const amount = DEFAULT_MOSH_AMOUNT;
  const size = canvas.width;
  const block = PIXEL_CLUSTER_SIZE;
  const displacement = 1 + Math.floor(amount * 3);
  const affected = 0.08 + amount * 0.55;
  scratchCanvas.width = size;
  scratchCanvas.height = size;
  const scratch = scratchCanvas.getContext("2d", { alpha: false });
  scratch.imageSmoothingEnabled = false;
  scratch.clearRect(0, 0, size, size);
  scratch.drawImage(canvas, 0, 0);
  const context = canvas.getContext("2d", { alpha: false });
  context.imageSmoothingEnabled = false;
  context.drawImage(scratchCanvas, 0, 0);

  for (let y = 0, cellY = 0; y <= size - block; y += block, cellY += 1) {
    for (let x = 0, cellX = 0; x <= size - block; x += block, cellX += 1) {
      if (cellNoise(cellX, cellY) > affected) continue;
      let offsetX = Math.round(
        (cellNoise(cellX, cellY, 1) * 2 - 1) * displacement,
      );
      const offsetY = Math.round(
        (cellNoise(cellX, cellY, 2) * 2 - 1) * displacement,
      );
      if (offsetX === 0 && offsetY === 0) offsetX = 1;
      const sourceX = clamp(x + offsetX * block, 0, size - block);
      const sourceY = clamp(y + offsetY * block, 0, size - block);
      context.drawImage(
        scratchCanvas,
        sourceX,
        sourceY,
        block,
        block,
        x,
        y,
        block,
        block,
      );
    }
  }
}
