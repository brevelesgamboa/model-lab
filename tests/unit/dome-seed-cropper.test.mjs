import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSemanticAnchors,
  semanticAnchorWindows,
  createSeedAnchors,
} from "../../assets/js/models/dome-seed-cropper.js";
import { seedCanvas } from "./helpers/seed-canvas.mjs";

test("Sobel saliency selects detailed windows while shadow anchors prefer dark contrast", () => {
  const image = seedCanvas(90, 60, (x, y) => {
    const v = x < 36 ? (((x >> 2) + (y >> 2)) % 2 ? 255 : 0) : x > 66 ? 8 : 180;
    return [v, v, v, 255];
  });
  const windows = semanticAnchorWindows(image.data, 90, 60);
  assert.equal(windows.candidates.length, 9);
  assert.equal(windows.detail.x, 0);
  assert.ok(windows.detail.detail > windows.candidates.at(-1).detail * 2);
  assert.ok(windows.shadow.mean < 0.6);
  assert.ok(
    windows.candidates.every(
      (w) => Number.isFinite(w.detail) && w.variance >= 0,
    ),
  );
});

test("all nine overlapping crop windows stay inside tiny, portrait and landscape sources", () => {
  for (const [w, h] of [
    [1, 1],
    [2, 5],
    [67, 19],
    [19, 67],
  ]) {
    const source = seedCanvas(w, h, () => [40, 90, 160, 255]),
      before = source.data.slice(),
      windows = semanticAnchorWindows(source.data, w, h),
      anchors = extractSemanticAnchors(source, 24, 12, seedCanvas);
    for (const c of windows.candidates) {
      assert.ok(
        c.x >= 0 && c.y >= 0 && c.x + c.width <= w && c.y + c.height <= h,
      );
    }
    for (const a of Object.values(anchors)) {
      assert.equal(a.width, 24);
      assert.equal(a.height, 12);
      const [x, y, cw, ch] = a.sourceRect;
      assert.ok(x >= 0 && y >= 0 && x + cw <= w + 1e-8 && y + ch <= h + 1e-8);
      assert.ok(a.data.every(Number.isFinite));
    }
    assert.deepEqual(anchors.anchor0.sourceRect, [0, 0, w, h]);
    assert.deepEqual(source.data, before, "source pixels are never modified");
    assert.notDeepEqual(anchors.anchor2.data, anchors.anchor0.data);
  }
});

test("one source derives three anchors; two and three sources preserve their explicit slot assignments", () => {
  const sources = [
    [200, 20, 10, 255],
    [20, 200, 10, 255],
    [10, 20, 200, 255],
  ].map((p) => seedCanvas(8, 4, () => p));
  for (const count of [1, 2, 3]) {
    const anchors = createSeedAnchors(
      sources.slice(0, count),
      8,
      4,
      seedCanvas,
    );
    assert.equal(anchors.length, 3);
    for (let i = 0; i < count; i++)
      assert.deepEqual(anchors[i].data, sources[i].data);
    assert.equal(new Set(anchors).size, 3);
  }
  for (const sources of [[], [1, 2, 3, 4]])
    assert.throws(() => createSeedAnchors(sources), RangeError);
  assert.throws(() => extractSemanticAnchors(sources[0], 0, 2), RangeError);
});
