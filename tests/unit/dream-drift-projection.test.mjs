import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceDirection,
  advancePanoramaPixels,
} from "../../tools/dream-drift-projection.mjs";

test("zero advance preserves every image byte over repeated passes", () => {
  const original = Uint8ClampedArray.from(
    { length: 64 * 32 * 4 },
    (_, i) => (i * 73 + 19) % 256,
  );
  let image = original;
  for (let pass = 0; pass < 20; pass++)
    image = advancePanoramaPixels(image, 64, 32, 0);
  assert.deepEqual(image, original);
  assert.notEqual(image, original);
});

test("reprojection recovers known sphere landmarks from the translated observer's rays", () => {
  for (const advance of [0, 0.03, 0.08, 0.25])
    for (const longitude of [-3, -1.2, -0.2, 0, 0.7, 2.8])
      for (const latitude of [-1.4, -0.4, 0, 0.6, 1.4]) {
        const point = [
          Math.sin(longitude) * Math.cos(latitude),
          Math.sin(latitude),
          -Math.cos(longitude) * Math.cos(latitude),
        ];
        const ray = [point[0], point[1], point[2] + advance];
        const sampled = advanceDirection(ray, advance);
        for (let axis = 0; axis < 3; axis++)
          assert.ok(Math.abs(sampled[axis] - point[axis]) < 1e-12);
      }
});

test("forward landmarks move outward symmetrically and both axial directions stay fixed", () => {
  assert.deepEqual(advanceDirection([0, 0, -1], 0.08), [0, 0, -1]);
  const rear = advanceDirection([0, 0, 1], 0.08);
  assert.ok(Math.abs(rear[2] - 1) < 1e-12);
  const angle = 0.2;
  for (const direction of [
    [Math.sin(angle), 0, -Math.cos(angle)],
    [0, Math.sin(angle), -Math.cos(angle)],
  ]) {
    const sampled = advanceDirection(direction, 0.08);
    const sourceAngle = Math.acos(-sampled[2]);
    assert.ok(sourceAngle > 0 && sourceAngle < angle);
  }
  const horizontal = advanceDirection([0.2, 0, -1], 0.08);
  const vertical = advanceDirection([0, 0.2, -1], 0.08);
  assert.ok(Math.abs(horizontal[0] - vertical[1]) < 1e-12);
});

test("constant opaque panoramas remain constant during ten approach steps", () => {
  let image = new Uint8ClampedArray(128 * 64 * 4);
  for (let i = 0; i < image.length; i += 4) image.set([37, 119, 201, 255], i);
  for (let pass = 0; pass < 10; pass++)
    image = advancePanoramaPixels(image, 128, 64, 0.08);
  for (let i = 0; i < image.length; i += 4)
    assert.deepEqual([...image.slice(i, i + 4)], [37, 119, 201, 255]);
});

test("smooth periodic longitude colors stay continuous at the rear", () => {
  const width = 128,
    height = 64,
    image = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const longitude = ((x + 0.5) / width - 0.5) * Math.PI * 2;
      const ring = Math.cos((0.5 - (y + 0.5) / height) * Math.PI);
      image.set(
        [
          128 + 100 * Math.cos(longitude) * ring,
          128 + 100 * Math.sin(longitude) * ring,
          90,
          255,
        ],
        (y * width + x) * 4,
      );
    }
  const output = advancePanoramaPixels(image, width, height, 0.08);
  for (let y = 0; y < height; y++)
    for (let channel = 0; channel < 3; channel++)
      assert.ok(
        Math.abs(
          output[y * width * 4 + channel] -
            output[(y * width + width - 1) * 4 + channel],
        ) <= 6,
      );
});

test("invalid dimensions, pixels, directions, and advances are rejected", () => {
  const image = new Uint8ClampedArray(16 * 8 * 4);
  for (const advance of [-0.01, 0.251, Infinity, NaN])
    assert.throws(
      () => advancePanoramaPixels(image, 16, 8, advance),
      RangeError,
    );
  assert.throws(() => advancePanoramaPixels(image, 8, 8), RangeError);
  assert.throws(() => advancePanoramaPixels(image.slice(4), 16, 8), RangeError);
  assert.throws(() => advanceDirection([0, 0, 0], 0.08), RangeError);
  assert.throws(() => advanceDirection([NaN, 0, 1], 0.08), RangeError);
});
