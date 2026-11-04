import test from "node:test";
import assert from "node:assert/strict";
import {
  OpenDriftField,
  driftWaves,
  openAppearance,
} from "../../tools/dream-open-field.mjs";
const base = {
  waveMode: 2,
  gain: 0.25,
  frequency: 8,
  speed: 0.7,
  eccentricity: 0.12,
  neuralSwell: 0.35,
  edgeCoupling: 0.35,
  chromaticDispersion: 0.35,
  depthScale: 0.6,
  cameraDolly: 0.8,
};
test("drift continues without arches or movement and eventually reaches full hex", () => {
  const field = new OpenDriftField();
  for (let n = 0; n < 3000; n++) field.advance(0.1, 0, base);
  assert.equal(field.depth, 3);
  assert.equal(openAppearance(field.depth).hex, 1);
  assert.equal(field.effect, null);
});
test("procedural descriptors vary across space and time without a fixed destination list", () => {
  const field = new OpenDriftField();
  field.depth = 2;
  const first = field.descriptor([0, 0]);
  assert.deepEqual(field.descriptor([0, 0]), first);
  const keys = new Set();
  for (let n = 0; n < 100; n++)
    keys.add(field.descriptor([n * 57, n * -43]).key);
  assert.equal(keys.size, 100);
  field.age = 1000;
  assert.notEqual(field.descriptor([0, 0]).key, first.key);
  assert.equal(field.descriptor([0, 0], false).landscape, -1);
});
test("rebasing preserves global position, image mapping and the floor grid phase", () => {
  const field = new OpenDriftField(),
    position = [145.5, -200.2],
    global = field.global(position),
    mapping = field.mappingAt(position);
  const before = [...position];
  field.rebase(position);
  assert.deepEqual(field.global(position), global);
  assert.deepEqual(field.mappingAt(position), mapping);
  assert.ok(position.every((v) => Math.abs(v) < 128));
  for (let i = 0; i < 2; i++)
    assert.equal(Math.abs((before[i] - position[i]) % 3), 0);
});
test("automatic waves leave base sliders intact and turn down smoothly", () => {
  const snapshot = { ...base },
    field = new OpenDriftField();
  field.depth = 3;
  for (let n = 0; n < 120; n++) {
    const values = driftWaves(base, n / 10, 3, 0.65);
    assert.ok(values.gain >= 0 && values.gain <= 1);
    assert.ok(values.frequency >= 1 && values.frequency <= 30);
    assert.equal(values.waveMode, base.waveMode);
  }
  assert.deepEqual(base, snapshot);
  field.autoWaves = false;
  const old = field.waveAmount;
  field.advance(0.1, 0, base);
  assert.ok(field.waveAmount < old && field.waveAmount > 0);
  for (let n = 0; n < 250; n++) field.advance(0.1, 0, base);
  assert.equal(field.waveAmount, 0);
  assert.deepEqual(driftWaves(base, field.age, 3, field.waveAmount), base);
  assert.equal(openAppearance(field.depth).hex, 1);
});
test("depth can be held independently of waves and continues in any walking direction", () => {
  const a = new OpenDriftField(),
    b = new OpenDriftField();
  a.advance(0.1, 2, base);
  b.advance(0.1, 2, base);
  assert.equal(a.depth, b.depth);
  a.autoDepth = false;
  const depth = a.depth;
  a.advance(10, 50, base);
  assert.equal(a.depth, depth);
  assert.ok(a.age > 0);
});
test("arches can be bypassed, either crossing direction works, and effects expire", () => {
  const field = new OpenDriftField(),
    arch = field.arches([0, 0]).find((a) => a.id === "first");
  const f = [Math.sin(arch.yaw), -Math.cos(arch.yaw)],
    r = [Math.cos(arch.yaw), Math.sin(arch.yaw)];
  const a = arch.position.map((v, i) => v - f[i] * 0.1),
    b = arch.position.map((v, i) => v + f[i] * 0.1);
  assert.equal(field.crossed(a, b).id, "first");
  assert.equal(field.crossed(b, a).id, "first");
  assert.equal(
    field.crossed(
      a.map((v, i) => v + r[i] * 6),
      b.map((v, i) => v + r[i] * 6),
    ),
    null,
  );
  assert.equal(field.encounter(arch), true);
  assert.equal(field.encounter(arch), false);
  assert.equal(field.effectAmount, 0);
  field.advance(4, 0, base);
  assert.ok(field.effectAmount > 0);
  field.advance(40, 0, base);
  assert.equal(field.effect, null);
});
test("procedural arch density and recent encounter memory stay bounded", () => {
  const field = new OpenDriftField();
  for (let n = 0; n < 1000; n++) {
    assert.ok(field.arches([n * 81, -n * 61]).length <= 3);
    field.encounter({ id: String(n), type: n % 4 });
    field.advance(40, 0, base);
  }
  assert.ok(field.recent.size <= 32);
});
