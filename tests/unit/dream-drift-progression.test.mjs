import test from "node:test";
import assert from "node:assert/strict";
import {
  PROGRESSION_RECIPES,
  progressionStage,
  marmotSubjectRect,
  neonPanoramaPixels,
} from "../../tools/dream-drift-progression.mjs";

function solid(width, height, rgb = [80, 110, 150]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return data;
}

test("progression uses equal ascent budgets across recipes and increases strength at each depth", () => {
  let previous = 0;
  for (let level = 1; level <= 6; level++) {
    const stages = PROGRESSION_RECIPES.map((r) =>
      progressionStage(r.id, level),
    );
    const totals = stages.map((s) =>
      s.passes.reduce((n, p) => n + p.iterations, 0),
    );
    assert.ok(totals.every((n) => n === totals[0] && n > 0));
    const strength = stages[0].iterations * stages[0].stepSize;
    assert.ok(strength >= previous);
    previous = strength;
    assert.ok(stages.every((s) => s.stepSize <= 0.012));
  }
  assert.deepEqual(
    progressionStage("mixed", 1).passes.map((p) => p.target),
    ["arches"],
  );
  assert.deepEqual(
    progressionStage("mixed", 4).passes.map((p) => p.target),
    ["arches", "organic"],
  );
  assert.deepEqual(
    progressionStage("mixed", 6).passes.map((p) => p.target),
    ["organic"],
  );
  for (const level of [0, 7, NaN, 1.5])
    assert.throws(() => progressionStage("mixed", level), RangeError);
  assert.throws(() => progressionStage("missing", 1), RangeError);
});

test("annotated marmot head cores stay inside the supplied photo placement", () => {
  const photo = { x: 380, y: 82, width: 261, height: 348, feather: 50 };
  for (const name of [
    "484351002_3898009110462736_2299646428952345762_n.jpg",
    "Himalayan-marmot_-udeyismailShutterstock-copy_en6jwc.jpg",
    "images.jpg",
  ]) {
    const r = marmotSubjectRect(name, photo);
    assert.ok(r.x > photo.x && r.y > photo.y);
    assert.ok(
      r.x + r.width < photo.x + photo.width &&
        r.y + r.height < photo.y + photo.height,
    );
    assert.ok(r.feather > 0 && r.feather < Math.min(r.width, r.height));
  }
});

test("zero neon strength preserves every byte, including alpha, and leaves model inputs untouched", () => {
  const image = Uint8ClampedArray.from(
    { length: 32 * 16 * 4 },
    (_, i) => (i * 29) % 256,
  );
  const before = image.slice();
  const reference = solid(32, 16),
    originalReference = reference.slice();
  const output = neonPanoramaPixels(image, reference, 32, 16, { strength: 0 });
  assert.deepEqual(output, before);
  assert.notEqual(output, image);
  neonPanoramaPixels(image, reference, 32, 16);
  assert.deepEqual(image, before);
  assert.deepEqual(reference, originalReference);
});

test("neon lighting cannot invent spatial patterns on a constant unchanged panorama", () => {
  const image = solid(32, 16);
  const output = neonPanoramaPixels(image, image, 32, 16, { strength: 1 });
  for (let i = 0; i < output.length; i += 4)
    assert.deepEqual(output.slice(i, i + 4), output.slice(0, 4));
});

test("bloom and lighting commute with longitude rotation across the panorama seam", () => {
  const width = 32,
    height = 16;
  const image = solid(width, height),
    reference = solid(width, height);
  for (let y = 3; y < 13; y++)
    for (const x of [0, 1, width - 1])
      image.set([180, 180, 210, 255], (y * width + x) * 4);
  const rotate = (data, shift) => {
    const result = data.slice();
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + ((x + shift) % width)) * 4;
        result.set(
          data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
          i,
        );
      }
    return result;
  };
  const output = neonPanoramaPixels(image, reference, width, height);
  assert.deepEqual(
    neonPanoramaPixels(rotate(image, 9), rotate(reference, 9), width, height),
    rotate(output, 9),
  );
});

test("photo protection attenuates neon treatment while preserving opacity", () => {
  const image = solid(32, 16, [40, 45, 70]);
  const output = neonPanoramaPixels(image, image, 32, 16, {
    strength: 1,
    photoRect: { x: 8, y: 4, width: 16, height: 8, feather: 2 },
  });
  const change = (x, y) => {
    const i = (y * 32 + x) * 4;
    return [0, 1, 2].reduce(
      (n, c) => n + Math.abs(output[i + c] - image[i + c]),
      0,
    );
  };
  assert.ok(change(16, 8) < change(1, 8));
  for (let i = 3; i < output.length; i += 4) assert.equal(output[i], 255);
});

test("invalid lighting dimensions, references and strengths are rejected", () => {
  const image = solid(32, 16);
  for (const strength of [-0.1, 1.1, NaN, Infinity])
    assert.throws(
      () => neonPanoramaPixels(image, image, 32, 16, { strength }),
      RangeError,
    );
  assert.throws(
    () => neonPanoramaPixels(image, image.slice(4), 32, 16),
    RangeError,
  );
  assert.throws(() => neonPanoramaPixels(image, image, 16, 16), RangeError);
});
