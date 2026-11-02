import test from "node:test";
import assert from "node:assert/strict";
import {
  DomeJourney,
  DREAM_REGIONS,
  journeyDirection,
} from "../../assets/js/models/dome-journey.js";
import {
  dreamMapSegments,
  dreamWarp,
  dreamUnwarp,
} from "../../assets/js/models/dome-journey-layout.js";
import { advanceDirection } from "../../tools/dream-drift-projection.mjs";
import { DomeCamera } from "../../assets/js/render/dome-mesh.js";

test("free spatial movement reverses, strafes relative to look and has no terminal radius", () => {
  const j = new DomeJourney();
  j.enabled = true;
  for (let i = 0; i < 800; i++) j.move(1, 0, 0.25, 0);
  assert.deepEqual(j.position, [0, -400]);
  for (let i = 0; i < 800; i++) j.move(-1, 0, 0.25, 0);
  assert.deepEqual(j.position, [0, 0]);
  assert.equal(j.sourceWeight, 1);
  j.move(0, 1, 0.25, 0);
  assert.deepEqual(j.position, [0.5, 0]);
  j.home();
  j.move(1, 0, 0.25, Math.PI / 2);
  assert.ok(Math.abs(j.position[0] - 0.5) < 1e-10);
  j.enabled = false;
  const before = [...j.position];
  j.move(1, 0, 0.25, 0);
  assert.deepEqual(j.position, before);
  assert.equal(j.radius, undefined);
  assert.equal(j.durationSeconds, undefined);
});
test("regions are places with continuous reversible blends and retained photographic influence", () => {
  const j = new DomeJourney();
  for (const region of DREAM_REGIONS) {
    j.visit(region.id);
    assert.equal(j.region.id, region.id);
  }
  let previous;
  for (let i = 0; i <= 1000; i++) {
    j.position = [i / 25, -20];
    const weights = [j.sourceWeight, ...j.weights];
    assert.ok(Math.abs(weights.reduce((a, b) => a + b, 0) - 1) < 1e-10);
    assert.ok(weights.every((v) => v >= 0));
    assert.ok(j.sourceWeight >= 0.75);
    if (previous)
      assert.ok(weights.every((v, k) => Math.abs(v - previous[k]) < 0.01));
    previous = weights;
  }
  j.visit("arches");
  const weights = j.weights;
  j.visit("ribbons");
  j.visit("arches");
  assert.deepEqual(j.weights, weights);
  j.faithfulness = 1;
  assert.deepEqual(j.weights, [0, 0, 0, 0]);
  j.home();
  assert.equal(j.geometry, 0);
  assert.equal(j.sourceWeight, 1);
  assert.throws(() => j.visit("ending"), RangeError);
});
test("seeded passages repeat, branch and allow a different dream without a terminal state", () => {
  const j = new DomeJourney(42);
  const original = dreamMapSegments([0, 0], j.seed, 2);
  assert.deepEqual(original, dreamMapSegments([0, 0], 42, 2));
  assert.notDeepEqual(original, dreamMapSegments([0, 0], 43, 2));
  assert.ok(original.some((s) => s.id.endsWith(":1")));
  assert.ok(original.some((s) => s.id.endsWith(":0")));
  // A vertical backbone in every column prevents isolated components.
  for (let x = -2; x <= 2; x++)
    for (let z = -2; z <= 2; z++)
      assert.ok(original.some((s) => s.id === `${x},${z}:0`));
  for (const point of [
    [0, 0],
    [-27, 43],
    [1000, -2000],
  ]) {
    const restored = dreamUnwarp(dreamWarp(point, 42), 42);
    point.forEach((v, i) => assert.ok(Math.abs(restored[i] - v) < 0.0001));
  }
  j.position = [40, -80];
  const weights = j.weights;
  j.newDream(43);
  assert.equal(j.seed, 43);
  assert.deepEqual(j.position, [0, 0]);
  j.newDream(42);
  j.position = [40, -80];
  assert.deepEqual(j.weights, weights);
  assert.equal(j.link, undefined);
});
test("travel projection matches the calibrated ray and the real observer stays centered", () => {
  for (const d of [0, 0.03, 0.25])
    for (const ray of [
      [0, 0, -1],
      [0.3, 0.2, -1],
      [-1, 0.4, 0.2],
    ]) {
      const a = journeyDirection(ray, [0, 0, -d]),
        b = advanceDirection(ray, d);
      a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-12));
    }
  const j = new DomeJourney();
  for (const p of [
    [0, 0],
    [20, -20],
    [10000, -10000],
  ]) {
    j.position = p;
    assert.ok(Math.hypot(...j.offset([2, 1, -2])) <= 0.85000001);
  }
  const camera = new DomeCamera();
  camera.dolly = 2;
  assert.notDeepEqual(camera.matrices(1).position, [0, 0, 0]);
  assert.deepEqual(
    camera.matrices(1, { originLocked: true }).position,
    [0, 0, 0],
  );
  assert.throws(() => journeyDirection([0, 0, 0], [0, 0, 0]), RangeError);
});

test("area presets are seeded, coordinated and smooth while Clarity remains global", () => {
  const j = new DomeJourney(42),
    other = new DomeJourney(43);
  // Exercise the full preset range independently of the calmer launch settings.
  for (const journey of [j, other])
    Object.assign(journey, { recursion: 0.72, corruption: 0.64, density: 0.65 });
  const samples = [];
  let previous;
  for (let i = 0; i <= 1000; i++) {
    j.position = [i / 25, -20];
    const style = j.style;
    assert.ok(style.every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
    assert.equal(style[3], j.clarity);
    if (previous)
      assert.ok(style.every((v, k) => Math.abs(v - previous[k]) < 0.015));
    previous = style;
    if (i % 100 === 0) samples.push(style);
  }
  assert.ok(
    Math.max(...samples.map((s) => s[0])) -
      Math.min(...samples.map((s) => s[0])) >
      0.2,
  );
  j.position = [18, -18];
  other.position = [...j.position];
  assert.notDeepEqual(j.areaPreset, other.areaPreset);
  const style = j.style;
  j.position = [0, 0];
  j.position = [18, -18];
  assert.deepEqual(j.style, style);
  j.clarity = 1;
  assert.deepEqual(j.style.slice(0, 3), style.slice(0, 3));
  assert.equal(j.style[3], 1);
  j.recursion = j.corruption = j.density = 0;
  assert.deepEqual(j.style, [0, 0, 0, 1]);
  j.recursion = j.corruption = j.density = 1;
  assert.deepEqual(j.style, [1, 1, 1, 1]);
});

test("entrance stages meet smoothly and reverse at the same world position", () => {
  const j = new DomeJourney(42),
    snapshots = [];
  for (const d of [0, 0.75, 1.5, 2.5, 4, 10]) {
    j.position = [0, -d];
    snapshots.push(j.entrance);
  }
  assert.deepEqual(snapshots[0], { relief: 0, aperture: 0 });
  assert.deepEqual(snapshots[2], { relief: 1, aperture: 0 });
  assert.deepEqual(snapshots[4], { relief: 1, aperture: 1 });
  assert.deepEqual(snapshots[5], snapshots[4]);
  for (const d of [1.5, 4]) {
    j.position = [0, -d + 0.001];
    const before = j.entrance;
    j.position = [0, -d - 0.001];
    const after = j.entrance;
    assert.ok(Math.abs(before.relief - after.relief) < 0.00001);
    assert.ok(Math.abs(before.aperture - after.aperture) < 0.00001);
  }
  for (const [i, d] of [0, 0.75, 1.5, 2.5, 4, 10].entries()) {
    j.position = [0, -d];
    assert.deepEqual(j.entrance, snapshots[i]);
  }
});
