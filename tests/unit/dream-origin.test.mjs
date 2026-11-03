import test from "node:test";
import assert from "node:assert/strict";
import {
  OriginSpace,
  originTreatment,
} from "../../tools/dream-origin-space.mjs";

test("free movement has no route, walls, automatic heading or distance limit", () => {
  const space = new OriginSpace();
  space.enabled = true;
  for (let n = 0; n < 4000; n++) space.move(1, 1, 0.1);
  assert.ok(space.position[0] > 700 && space.position[1] < -700);
  assert.equal(space.yaw, 0);
  const previous = [...space.position];
  space.move(0, -1, 0.1);
  assert.ok(space.position[0] < previous[0]);
  assert.equal(space.position[1], previous[1]);
  assert.ok(space.trace.length <= 128);
});
test("diagonal speed is normalized and inactive exploration preserves the original pose", () => {
  const straight = new OriginSpace(),
    diagonal = new OriginSpace();
  straight.enabled = diagonal.enabled = true;
  straight.move(1, 0, 0.1);
  diagonal.move(1, 1, 0.1);
  assert.ok(
    Math.abs(
      Math.hypot(...straight.position) - Math.hypot(...diagonal.position),
    ) < 1e-9,
  );
  straight.enabled = false;
  const old = [...straight.position];
  straight.move(1, 1, 1);
  assert.deepEqual(straight.position, old);
  assert.deepEqual(straight.parallax, [0, 0, 0]);
});
test("parallax remains inside the original dome even at distant world coordinates", () => {
  const space = new OriginSpace();
  space.enabled = true;
  space.position = [1e10, -1e10];
  const p = space.parallax;
  assert.ok(p.every(Number.isFinite));
  assert.ok(Math.hypot(...p) < 0.7);
  assert.equal(p[1], 0);
  assert.throws(() => space.move(1, NaN, 0.1), RangeError);
  assert.throws(() => space.move(1, 0, -1), RangeError);
});
test("a fold is optional, and completing it preserves the user's position and heading", () => {
  const space = new OriginSpace();
  space.enabled = true;
  space.position = [10, -12];
  assert.equal(space.nearPortal, false);
  space.position = [0, -10];
  assert.equal(space.nearPortal, true);
  space.yaw = 0.7;
  const before = [...space.position];
  space.completeFold();
  assert.deepEqual(space.position, before);
  assert.equal(space.yaw, 0.7);
  assert.equal(space.frontier, 1);
  assert.ok(
    Math.abs(
      Math.hypot(space.portal[0] - before[0], space.portal[1] - before[1]) - 18,
    ) < 1e-8,
  );
  space.home();
  assert.deepEqual(space.position, [0, 0]);
  assert.deepEqual(space.portal, [0, -12]);
  assert.equal(space.frontier, 0);
});
test("digital treatment starts at zero and increases smoothly within a bounded range", () => {
  assert.deepEqual(originTreatment(0), { neon: 0, hex: 0, corruption: 0 });
  let old = originTreatment(0);
  for (let n = 0.01; n < 3; n += 0.01) {
    const next = originTreatment(n);
    for (const key of ["neon", "hex", "corruption"]) {
      assert.ok(next[key] >= old[key]);
      assert.ok(next[key] - old[key] < 0.01);
    }
    old = next;
  }
  assert.deepEqual(originTreatment(100), originTreatment(2));
  assert.equal(originTreatment(2).hex, 0.34);
});
