import test from "node:test";
import assert from "node:assert/strict";
import { DomeJourney } from "../../assets/js/models/dome-journey.js";
import {
  dreamWarp,
  dreamBridge,
} from "../../assets/js/models/dome-journey-layout.js";
import { depthContours } from "../../assets/js/ui/dome-neuro-radar.js";

function ready() {
  const j = new DomeJourney(42);
  j.enabled = true;
  return j;
}

test("warp lasts five seconds independently of frame partition and lands exactly on the selected frontier", () => {
  for (const steps of [[5], [1, 2, 1, 1], Array(300).fill(1 / 60)]) {
    const j = ready(),
      destination = j.discovered.get("0,-1");
    assert.equal(j.visited.has(destination.id), false);
    assert.equal(j.startWarp(destination.id), true);
    assert.deepEqual(j.warpUniform, [1, 0, 0, 0]);
    const startEpoch = j.historyEpoch;
    for (const dt of steps) j.advanceWarp(dt);
    assert.equal(j.warping, false);
    assert.equal(j.warpProgress, 1);
    assert.deepEqual(j.position, destination.position);
    assert.deepEqual(j.warpUniform, [0, 0, 0, 0]);
    assert.equal(j.visited.has(destination.id), true);
    assert.equal(j.historyEpoch, startEpoch + 1);
    assert.equal(j.discovered.has("0,-2"), true, "arrival exposes new space");
    j.home();
    assert.equal(j.warpProgress, 0);
  }
});

test("warp accelerates and decelerates smoothly while manual travel is locked", () => {
  const j = ready();
  j.startWarp("0,-1");
  const positions = [[...j.position]],
    speeds = [];
  for (let i = 0; i < 100; i++) {
    const before = [...j.position];
    assert.equal(j.move(1, 1, 0.25, Math.PI), false);
    assert.deepEqual(j.position, before);
    j.advanceWarp(0.05);
    speeds.push(Math.hypot(...j.position.map((v, k) => v - before[k])));
    positions.push([...j.position]);
  }
  assert.ok(speeds[0] < speeds[49] * 0.002);
  assert.ok(speeds[99] < speeds[49] * 0.002);
  for (let i = 0; i < 100; i++)
    assert.ok(Math.hypot(...positions[i + 1]) > Math.hypot(...positions[i]));
});

test("unsafe warp requests cannot change state and cancellation leaves a walkable current location", () => {
  const j = ready();
  for (const id of ["0,0", "99,99", null]) assert.equal(j.startWarp(id), false);
  j.enabled = false;
  assert.equal(j.startWarp("0,-1"), false);
  j.enabled = true;
  assert.equal(j.startWarp("0,-1"), true);
  assert.equal(j.startWarp("0,1"), false);
  for (const dt of [-1, 0, NaN, Infinity])
    assert.equal(j.advanceWarp(dt), false);
  assert.equal(j.warpProgress, 0);
  j.advanceWarp(2.5);
  assert.equal(j.warpUniform[3], 1);
  const halfway = [...j.position],
    epoch = j.historyEpoch;
  assert.equal(j.cancelWarp(), true);
  assert.equal(j.cancelWarp(), false);
  assert.deepEqual(j.position, halfway);
  assert.equal(j.historyEpoch, epoch + 1);
  assert.equal(j.warpProgress, 0);
  assert.equal(j.move(1, 0, 0.1, 0), true);
  assert.equal(j.startWarp("0,1"), true);
  j.enabled = false;
  j.advanceWarp(1);
  assert.equal(j.warping, false);
});

test("home and reseeding clear warp and keep discovery aligned with the seeded corridor topology", () => {
  const j = ready();
  const expected = new Set(["0,0", "0,-1", "0,1"]);
  if (dreamBridge(0, 0, 42)) expected.add("1,0");
  if (dreamBridge(-1, 0, 42)) expected.add("-1,0");
  assert.deepEqual(new Set(j.discovered.keys()), expected);
  for (const node of j.discovered.values()) {
    dreamWarp(node.position, j.seed).forEach((v, i) =>
      assert.ok(Math.abs(v - node.cell[i] * 18) < 0.0001),
    );
  }
  j.startWarp("0,-1");
  j.advanceWarp(3);
  j.home();
  assert.deepEqual(j.position, [0, 0]);
  assert.equal(j.warping, false);
  assert.equal(j.breadcrumbs.at(-1).break, true);
  j.startWarp("0,-1");
  j.newDream(123);
  assert.equal(j.warping, false);
  assert.equal(j.seed, 123);
  assert.deepEqual([...j.visited], ["0,0"]);
  assert.equal(j.breadcrumbs.length, 1);
});

test("memory breadcrumbs are bounded, age out and survive invalid clock inputs", () => {
  const j = ready();
  for (let i = 1; i <= 400; i++) {
    j.setRadarTime(i / 100);
    j.move(1, 0, 0.1, 0);
  }
  assert.equal(j.breadcrumbs.length, 256);
  for (const invalid of [NaN, Infinity, -1]) j.setRadarTime(invalid);
  assert.equal(j.radarTime, 4);
  j.setRadarTime(29);
  assert.equal(j.breadcrumbs.length, 0);
  j.move(1, 0, 0.1, 0);
  assert.equal(
    j.breadcrumbs.length,
    2,
    "first fresh segment retains its origin",
  );
  assert.ok(j.breadcrumbs.every((p) => p.time === 29));
});

test("depth radar isolines follow cached image depth rather than decorative terrain", () => {
  const levels = [0.15, 0.27, 0.39, 0.51, 0.63, 0.75, 0.87];
  const vertical = depthContours(
    { width: 2, height: 2, depth: [0, 1, 0, 1] },
    9,
    7,
  );
  assert.equal(vertical.length, levels.length * 6);
  for (const [a, b] of vertical) {
    assert.ok(levels.some((v) => Math.abs(a[0] - v) < 1e-6));
    assert.equal(a[0], b[0]);
    assert.ok(a[1] >= 0 && b[1] <= 1);
  }
  const horizontal = depthContours(
    { width: 2, height: 2, depth: [0, 0, 1, 1] },
    9,
    7,
  );
  assert.equal(horizontal.length, levels.length * 8);
  for (const [a, b] of horizontal) assert.equal(a[1], b[1]);
  assert.deepEqual(depthContours({ width: 1, height: 1, depth: [0.5] }), []);
  assert.deepEqual(depthContours(null), []);
  assert.deepEqual(
    depthContours({ width: 2, height: 2, depth: [NaN, NaN, NaN, NaN] }),
    [],
  );
});
