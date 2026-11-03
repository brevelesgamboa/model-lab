import test from "node:test";
import assert from "node:assert/strict";
import {
  DreamWorldMap,
  WORLD_AREAS,
  worldGates,
  worldAppearance,
} from "../../tools/dream-world-map.mjs";
import { WorldImageStore } from "../../tools/dream-world-storage.mjs";
import {
  createWorldPreset,
  loadWorldPresets,
  storeWorldPreset,
} from "../../tools/dream-world-presets.mjs";

test("the clearing branches, both routes reach the depths, and every fold has a return", () => {
  const world = new DreamWorldMap();
  assert.deepEqual(
    world
      .gates()
      .filter((g) => g.open)
      .map((g) => g.target),
    ["waves", "garden"],
  );
  for (const area of WORLD_AREAS) {
    assert.ok(worldGates(area.id).length <= 4);
    for (const gate of worldGates(area.id)) {
      assert.ok(
        worldGates(gate.target).some((back) => back.target === area.id),
      );
      assert.ok(gate.position.every(Number.isFinite));
    }
  }
  const reached = new Set(["clearing"]),
    queue = ["clearing"];
  while (queue.length) {
    const id = queue.shift();
    for (const g of worldGates(id).filter((g) => !g.shortcut && !g.hidden))
      if (!reached.has(g.target)) {
        reached.add(g.target);
        queue.push(g.target);
      }
  }
  assert.equal(reached.size, 5);
  assert.ok(reached.has("hex"));
});
test("the shortcut opens after the deep signal and the hidden pocket needs discovery", () => {
  const world = new DreamWorldMap();
  assert.throws(() => world.commit("terrace", [0, 0]), RangeError);
  world.commit("garden", [0, 0]);
  assert.ok(!world.discovered.has("pocket"));
  assert.throws(() => world.commit("pocket", [0, 0]), RangeError);
  const secret = world.gates().find((g) => g.target === "pocket");
  world.discoverAt(secret.position);
  assert.ok(world.discovered.has("pocket"));
  world.commit("pocket", secret.position);
  world.commit("hex", [0, 0]);
  assert.equal(world.shortcutOpen, true);
  world.commit("terrace", [0, 0]);
  assert.ok(world.gates().some((g) => g.target === "clearing" && g.open));
});
test("only walking through an available opening triggers a transition", () => {
  const world = new DreamWorldMap(),
    g = world.gates()[0],
    before = g.position.map((v, i) => v - g.direction[i] * 0.2),
    after = g.position.map((v, i) => v + g.direction[i] * 0.2);
  assert.equal(world.crossed(before, after).target, g.target);
  assert.equal(world.crossed(after, before), null);
  const side = [-g.direction[1] * 4, g.direction[0] * 4];
  assert.equal(
    world.crossed(
      before.map((v, i) => v + side[i]),
      after.map((v, i) => v + side[i]),
    ),
    null,
  );
  assert.equal(world.nearest([0, 0]).distance, 12);
});
test("revisits preserve floor phase and restored progress preserves places and unlocks", () => {
  const world = new DreamWorldMap(),
    start = [-8.2, -8.2];
  world.commit("waves", start);
  const phase = [...world.floorOffset];
  world.commit("terrace", [0, -11]);
  world.commit("hex", [9, -8]);
  world.commit("terrace", [-8, 8]);
  world.commit("waves", [0, 12]);
  assert.deepEqual(world.floorOffset, phase);
  const snapshot = world.serialize([2, -3], 0.5, 0.2),
    restored = new DreamWorldMap();
  assert.deepEqual(restored.restore(snapshot), {
    position: [2, -3],
    yaw: 0.5,
    pitch: 0.2,
  });
  assert.equal(restored.current, "waves");
  assert.equal(restored.shortcutOpen, true);
  assert.deepEqual(restored.floorOffset, phase);
  assert.equal(new DreamWorldMap(99).restore(snapshot), null);
  assert.equal(restored.restore({ ...snapshot, position: [NaN, 0] }), null);
  assert.equal(restored.restore({ ...snapshot, current: "missing" }), null);
});
test("floor transition uses the shortest periodic shift, avoiding a large grid jump", () => {
  const world = new DreamWorldMap();
  world.commit("garden", [8.4, -8.4]);
  world.commit("hex", [-5, -11]);
  const before = [-8, 7],
    shift = world.floorShift("garden", before);
  assert.ok(shift.every((v) => Math.abs(v) <= 1.5));
  const from = before.map((v, i) => v + world.floorOffset[i]),
    arrival = world.arrival("garden"),
    phase = world.arrivalFloor("garden", before);
  for (let i = 0; i < 2; i++) {
    const delta = arrival[i] + phase[i] - from[i] - shift[i];
    assert.ok(Math.abs(delta / 3 - Math.round(delta / 3)) < 1e-8);
  }
});
test("full colored hex is reached automatically at depth, with a smooth reversible ramp", () => {
  assert.equal(worldAppearance(0).hex, 0);
  assert.equal(worldAppearance(3).hex, 1);
  let old = 0;
  for (let d = 0.01; d <= 4; d += 0.01) {
    const value = worldAppearance(d).hex;
    assert.ok(value >= old && value - old < 0.01);
    old = value;
  }
  assert.deepEqual(worldAppearance(20), worldAppearance(3));
  assert.ok(worldAppearance(1).hex < worldAppearance(2).hex);
});
test("look presets validate and round-trip the exact wave, floor and manual hex choices", () => {
  const values = new Map(),
    storage = {
      getItem: (k) => values.get(k),
      setItem: (k, v) => values.set(k, v),
    };
  const params = {
      depthScale: 0.6,
      neuralSwell: 0.35,
      waveMode: 3,
      gain: 0.47,
      frequency: 11.3,
      speed: 0.7,
      eccentricity: 0.08,
      edgeCoupling: 0.35,
      chromaticDispersion: 0.35,
      cameraDolly: 0.8,
    },
    settings = {
      floor: 0.62,
      negative: 0.71,
      digital: true,
      fullHex: true,
      portal: true,
    };
  const look = createWorldPreset("My waves", params, settings);
  storeWorldPreset(storage, look);
  assert.deepEqual(loadWorldPresets(storage), [look]);
  assert.equal(loadWorldPresets(storage)[0].params.frequency, 11.3);
  assert.throws(
    () => createWorldPreset("broken", { ...params, gain: Infinity }, settings),
    RangeError,
  );
  values.clear();
  values.set("latent-field:dream-world:looks:v1", "broken");
  assert.deepEqual(loadWorldPresets(storage), []);
});
test("image storage falls back to a bounded memory cache without browser storage", async () => {
  const store = new WorldImageStore({ indexedDB: null });
  for (let i = 0; i < 8; i++)
    await store.put(String(i), new Blob([String(i)]), { id: i });
  assert.equal(store.memory.size, 6);
  assert.equal(await store.get("0"), null);
  assert.equal((await store.get("7")).metadata.id, 7);
  await store.close();
});
