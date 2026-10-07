import test from "node:test";
import assert from "node:assert/strict";
import {
  floodFillSelect,
  getContainRect,
} from "../../assets/js/app/spatial-mask-controller.js";
import { InceptionDreamModel } from "../../assets/js/models/inception-dream.js";

test("getContainRect correctly computes scale and letterbox offsets", () => {
  // 500x500 container, 400x200 content (2:1 landscape)
  const landscape = getContainRect(500, 500, 400, 200);
  assert.equal(landscape.scale, 1.25);
  assert.equal(landscape.dw, 500);
  assert.equal(landscape.dh, 250);
  assert.equal(landscape.dx, 0);
  assert.equal(landscape.dy, 125);

  // 500x500 container, 200x400 content (1:2 portrait)
  const portrait = getContainRect(500, 500, 200, 400);
  assert.equal(portrait.scale, 1.25);
  assert.equal(portrait.dw, 250);
  assert.equal(portrait.dh, 500);
  assert.equal(portrait.dx, 125);
  assert.equal(portrait.dy, 0);
});

test("floodFillSelect isolates contiguous region matching color tolerance", () => {
  // Create an 8x8 image with a 4x4 red square in the center on a black background
  const width = 8;
  const height = 8;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      if (x >= 2 && x <= 5 && y >= 2 && y <= 5) {
        data[idx] = 220; // R
        data[idx + 1] = 20; // G
        data[idx + 2] = 20; // B
      } else {
        data[idx] = 10;
        data[idx + 1] = 10;
        data[idx + 2] = 10;
      }
      data[idx + 3] = 255;
    }
  }

  // Click on seed (3, 3) inside red square
  const mask = floodFillSelect({ width, height, data }, 3, 3, 30);
  assert.equal(mask.length, width * height);

  // Center pixel must be selected (255)
  assert.equal(mask[3 * width + 3], 255);
  assert.equal(mask[2 * width + 2], 255);

  // Reach radius bounds selection
  const boundedMask = floodFillSelect({ width, height, data }, 3, 3, 30, 1.1);
  assert.equal(boundedMask[3 * width + 3], 255);
  // (5, 5) is distance sqrt((5-3)^2 + (5-3)^2) = sqrt(8) ~ 2.82 > 1.1
  assert.equal(boundedMask[5 * width + 5], 0);

  // Out of bounds seed returns empty mask
  const oobMask = floodFillSelect({ width, height, data }, -1, 10, 30);
  assert.equal(oobMask.every((v) => v === 0), true);
});

test("InceptionDreamModel normalizes spatialFocus and frequencyBand parameters", () => {
  const dream = new InceptionDreamModel();

  assert.equal(dream.normalizeStoredParameter("spatialFocus", "attention"), "attention");
  assert.equal(dream.normalizeStoredParameter("spatialFocus", "spotlight"), "spotlight");
  assert.equal(dream.normalizeStoredParameter("spatialFocus", "custom"), "custom");
  assert.equal(dream.normalizeStoredParameter("spatialFocus", "edges"), "edges");
  assert.equal(dream.normalizeStoredParameter("spatialFocus", "invalid_mode"), "full");

  assert.equal(
    dream.normalizeStoredParameter("frequencyBand", "high_freq_texture"),
    "high_freq_texture",
  );
  assert.equal(
    dream.normalizeStoredParameter("frequencyBand", "micro_detail"),
    "micro_detail",
  );
  assert.equal(
    dream.normalizeStoredParameter("frequencyBand", "full"),
    "full",
  );
  assert.equal(
    dream.normalizeStoredParameter("frequencyBand", "unknown_band"),
    "high_freq_texture",
  );

  assert.equal(dream.normalizeStoredParameter("brushRadius", 50), 50);
  assert.equal(dream.normalizeStoredParameter("brushRadius", 5), 10);
  assert.equal(dream.normalizeStoredParameter("brushRadius", 300), 150);
  assert.equal(dream.normalizeStoredParameter("wandTolerance", 45), 45);
  assert.equal(dream.normalizeStoredParameter("wandTolerance", 200), 100);
  assert.equal(dream.normalizeStoredParameter("wandRadius", 220), 220);
  assert.equal(dream.normalizeStoredParameter("wandRadius", 10), 30);
  assert.equal(dream.normalizeStoredParameter("wandRadius", 500), 400);
  assert.equal(dream.normalizeStoredParameter("spotlightRadius", 180), 180);
  assert.equal(dream.normalizeStoredParameter("spotlightRadius", 5), 30);
  assert.equal(dream.normalizeStoredParameter("spotlightHardness", 0.85), 0.85);
  assert.equal(dream.normalizeStoredParameter("spotlightHardness", 1.5), 1.0);
  assert.equal(dream.normalizeStoredParameter("spotlightHardness", -0.2), 0.0);
});

test("InceptionDreamModel manages spotlight and custom mask lifecycle", () => {
  const dream = new InceptionDreamModel();

  // Initial state
  assert.equal(dream.customMaskActive, false);
  assert.equal(dream.spotlightState.active, false);

  // Set spotlight with hardness
  dream.setSpotlight(0.4, 0.6, 150, 0.85);
  assert.equal(dream.spotlightState.active, true);
  assert.equal(dream.spotlightState.x, 0.4);
  assert.equal(dream.spotlightState.y, 0.6);
  assert.equal(dream.spotlightState.radius, 150);
  assert.equal(dream.spotlightState.hardness, 0.85);
  assert.equal(dream.customMaskActive, false);

  // Invert spotlight
  dream.invertCustomMask();
  assert.equal(dream.spotlightState.inverted, true);

  // Clear mask resets spotlight
  dream.clearCustomMask();
  assert.equal(dream.spotlightState.active, false);
  assert.equal(dream.spotlightState.inverted, false);
});

test("InceptionDreamModel tracks cumulative steps without resetting on parameter inspection", () => {
  const dream = new InceptionDreamModel();
  dream.totalSteps = 15;
  dream.stepCount = 15;

  // Parameter configuration inspection retains totalSteps
  dream.synchronizeDreamConfiguration({
    targetDepth: "deep_mixed7",
    brushRadius: 60,
  });
  assert.equal(dream.totalSteps, 15);
});

test("computeTileGrid correctly calculates overlapping grid coordinates", async () => {
  const { computeTileGrid } = await import(
    "../../assets/js/models/inception-dream.js"
  );

  const grid = computeTileGrid(2048, 2048, 384, 64);
  assert.equal(grid.tileWidth, 384);
  assert.equal(grid.tileHeight, 384);
  assert.equal(grid.tiles.length > 0, true);

  // First tile starts at (0, 0)
  assert.equal(grid.tiles[0].x, 0);
  assert.equal(grid.tiles[0].y, 0);

  // Last tile finishes exactly at the border: 2048 - 384 = 1664
  const lastTile = grid.tiles[grid.tiles.length - 1];
  assert.equal(lastTile.x, 1664);
  assert.equal(lastTile.y, 1664);

  // Small canvas (smaller than tileSize) yields single tile
  const smallGrid = computeTileGrid(250, 200, 384, 64);
  assert.equal(smallGrid.tiles.length, 1);
  assert.equal(smallGrid.tiles[0].x, 0);
  assert.equal(smallGrid.tiles[0].y, 0);
  assert.equal(smallGrid.tiles[0].width, 250);
  assert.equal(smallGrid.tiles[0].height, 200);
});

test("getHannWeight computes smooth 2D bell falloff", async () => {
  const { getHannWeight } = await import(
    "../../assets/js/models/inception-dream.js"
  );

  // Center pixel weight should be ~1.0
  const centerWeight = getHannWeight(191.5, 191.5, 384, 384);
  assert.ok(Math.abs(centerWeight - 1.0) < 0.001);

  // Edge pixel (0, 0) weight should be nearly 0 (< 0.01)
  const edgeWeight = getHannWeight(0, 0, 384, 384);
  assert.ok(edgeWeight < 0.01);
});

test("InceptionDreamModel normalizes detailFusion parameter and exposes high-res synthesis interface", () => {
  const dream = new InceptionDreamModel();

  assert.equal(dream.normalizeStoredParameter("detailFusion", 0.22), 0.22);
  assert.equal(dream.normalizeStoredParameter("detailFusion", 0.4), 0.4);
  assert.equal(dream.normalizeStoredParameter("detailFusion", -0.5), 0.0);
  assert.equal(dream.normalizeStoredParameter("detailFusion", 1.5), 0.5);
  assert.equal(dream.normalizeStoredParameter("detailFusion", "invalid"), 0.22);

  // Verify renderHighRes and drawSharpenedContain methods are available
  assert.equal(typeof dream.renderHighRes, "function");
  assert.equal(typeof dream.drawSharpenedContain, "function");
});

test("drawSharpenedContain blends photographic detail with soft-light", async () => {
  const { drawSharpenedContain } = await import(
    "../../assets/js/models/inception-dream.js"
  );

  const drawCalls = [];
  const operations = [];
  const mockContext = {
    fillStyle: "",
    globalCompositeOperation: "source-over",
    globalAlpha: 1.0,
    fillRect() {},
    drawImage(...args) {
      drawCalls.push(args);
    },
    save() {
      operations.push("save");
    },
    restore() {
      operations.push("restore");
    },
  };

  const dreamCanvas = { width: 448, height: 448 };
  const sourceImage = { width: 1920, height: 1080 };

  drawSharpenedContain(mockContext, dreamCanvas, sourceImage, 800, 600, 0.25);

  assert.equal(drawCalls.length, 2); // 1 for dreamCanvas, 1 for sourceImage
  assert.equal(operations.includes("save"), true);
  assert.equal(operations.includes("restore"), true);
  assert.equal(mockContext.globalCompositeOperation, "soft-light");
  assert.equal(mockContext.globalAlpha, 0.25);
});



