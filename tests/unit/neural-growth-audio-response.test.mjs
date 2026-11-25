import test from "node:test";
import assert from "node:assert/strict";
import {
  AudioResponse,
  applyAudioPreset,
  AUDIO_PRESETS,
  SPORE_POLICY,
} from "../../assets/js/models/neural-growth/audio-response.js";
import {
  audioMatrixForModel,
  setAudioRoute,
  restoreAudioMatrix,
  applyAudioModulation,
  updateModulationBounds,
} from "../../assets/js/core/modulation-matrix.js";

test("audio presets expose only Off and a Kick preset targeting safe visual parameters", () => {
  assert.deepEqual(
    AUDIO_PRESETS.map(({ value, label }) => ({ value, label })),
    [
      { value: "off", label: "Off" },
      { value: "kick", label: "Kick" },
    ],
  );
  const kick = AUDIO_PRESETS[1];
  assert.deepEqual(Object.keys(kick.routes), ["echoDecay", "palettePhase"]);
  for (const route of Object.values(kick.routes)) {
    assert.equal(route.source, "audioBeat");
  }
});

test("route-only Kick preset preserves user routes, explicit Off, base parameters and LFOs", () => {
  const id = "preset-policy";
  const keys = [
    "rotation",
    "palettePhase",
    "echoDrift",
    "echoDecay",
  ];
  restoreAudioMatrix(id, {}, keys);
  const base = { echoDecay: 0.9, rotation: 110 };
  const lfo = { rotation: { enabled: true, depth: 0.7 } };
  const before = JSON.stringify({ base, lfo });
  setAudioRoute(id, "echoDrift", { source: "audioAir", depth: -0.2 });
  setAudioRoute(id, "palettePhase", { source: "none", depth: 0.25 });
  applyAudioPreset(id, "kick", keys);
  assert.equal(audioMatrixForModel(id).palettePhase.source, "none");
  assert.equal(audioMatrixForModel(id).echoDecay.owner, "preset");
  assert.equal(audioMatrixForModel(id).echoDecay.source, "audioBeat");

  // Editing a preset route explicitly transfers ownership, including Off.
  setAudioRoute(id, "echoDecay", {
    source: "audioBody",
    depth: 0.1,
    owner: "user",
  });
  // Retired or unknown preset names resolve to Off without removing user routes.
  applyAudioPreset(id, "kick-spore", keys);
  assert.equal(audioMatrixForModel(id).echoDecay.source, "audioBody");
  assert.equal(audioMatrixForModel(id).echoDecay.owner, "user");

  // Re-apply Kick after clearing echoDecay so preset ceiling behavior is exercised.
  restoreAudioMatrix(id, {
    echoDrift: { source: "audioAir", depth: -0.2 },
    palettePhase: { source: "audioBeat", depth: 0.3, owner: "user" },
  }, keys);
  applyAudioPreset(id, "kick", keys);
  const matrix = audioMatrixForModel(id);
  assert.equal(matrix.echoDrift.depth, -0.2);
  assert.equal(matrix.palettePhase.owner, "user");
  assert.equal(matrix.palettePhase.depth, 0.3);
  assert.equal(matrix.echoDecay.owner, "preset");
  assert.equal(
    applyAudioModulation(
      { type: "range", min: 0, max: 0.98 },
      0.6,
      matrix.echoDecay,
      { kick: 1 },
    ),
    0.7,
  );
  assert.equal(
    applyAudioModulation(
      { type: "range", min: 0, max: 0.98 },
      0.9,
      matrix.echoDecay,
      { kick: 1 },
    ),
    0.9,
  );
  // A preset ceiling limits only added audio persistence, never a higher LFO.
  assert.equal(
    applyAudioModulation(
      { type: "range", min: 0, max: 0.98 },
      0.85,
      matrix.echoDecay,
      { kick: 1 },
      0.6,
    ),
    0.85,
  );
  const bounds = {};
  updateModulationBounds(
    bounds,
    { min: 0, max: 0.98 },
    0.6,
    0.1,
    0.8,
    "positive",
    0.7,
  );
  assert.ok(
    Math.abs(((bounds.leftPercent + bounds.widthPercent) * 0.98) / 100 - 0.7) <
      1e-10,
  );
  updateModulationBounds(
    bounds,
    { min: 0, max: 0.98 },
    0.6,
    0.8,
    0.8,
    "positive",
    0.7,
  );
  assert.equal(bounds.leftPercent + bounds.widthPercent, 100);
  applyAudioPreset(id, "off", keys);
  assert.equal(Object.hasOwn(audioMatrixForModel(id), "echoDecay"), false);
  assert.equal(audioMatrixForModel(id).palettePhase.source, "audioBeat");
  assert.equal(audioMatrixForModel(id).palettePhase.owner, "user");
  assert.equal(JSON.stringify({ base, lfo }), before);

  for (const preset of AUDIO_PRESETS.slice(1)) {
    restoreAudioMatrix(id, {}, keys);
    const saved = applyAudioPreset(id, preset.value, keys);
    restoreAudioMatrix(id, saved, keys);
    assert.deepEqual(audioMatrixForModel(id), saved);
  }
  restoreAudioMatrix(id, {}, []);
});

test("recovery spores yield while pointer is held and for two seconds after release", () => {
  const policy = new AudioResponse();
  policy.interact(true, 100);
  assert.equal(policy.queueRecovery(4000, 0.5, 0.5), false);
  assert.equal(policy.active.length, 0);
  policy.interact(false, 4100);
  assert.equal(policy.queueRecovery(6000, 0.5, 0.5), false);
  assert.equal(policy.active.length, 0);
  assert.equal(policy.queueRecovery(6100, 0.5, 0.5), true);
  assert.equal(policy.active.length, 1);
});

test("recovery spore mixing stays under its per-second budget at varied frame rates and grid sizes", () => {
  for (const size of [128, 256, 512, 1024])
    for (const fps of [15, 30, 60, 144]) {
      const policy = new AudioResponse();
      const calls = [];
      let nextBatch = -Infinity;
      for (let t = 0; t <= 1000; t += 1000 / fps) {
        if (t >= nextBatch) {
          policy.queueRecovery(t, 0.25, 0.25);
          policy.queueRecovery(t, 0.75, 0.75);
          nextBatch = t + 450;
        }
        assert.ok(policy.active.length <= SPORE_POLICY.maximum);
        policy.step(t, size, (...args) => calls.push(args), [1, 0, 0]);
      }
      assert.ok(calls.length > 0);
      assert.ok(
        calls.reduce((sum, args) => sum + args[4].strength, 0) <=
          SPORE_POLICY.rate * 3,
      );
      for (const [x, y, radius, mode, options] of calls) {
        assert.ok(x >= 0 && x < size && y >= 0 && y < size);
        assert.equal(radius, Math.max(1, Math.round(size * 0.03)));
        assert.equal(mode, "noise");
        assert.equal(options.lockBarrier, true);
        assert.equal(options.automatic, true);
      }
      policy.step(1600, size, () =>
        assert.fail("Expired spores must not drain"),
      );
      assert.equal(policy.active.length, 0);
    }
});

test("recovery spore budget enforces maximum of two and clears on cancel or manual interaction", () => {
  const policy = new AudioResponse();
  const calls = [];
  assert.equal(policy.queueRecovery(0, 0.25, 0.25), true);
  assert.equal(policy.queueRecovery(0, 0.5, 0.5), true);
  assert.equal(policy.queueRecovery(0, 0.75, 0.75), false);
  for (let time = 16; time < 400; time += 16)
    policy.step(time, 256, (...args) => calls.push(args), [0, 1, 1]);
  assert.ok(calls.some((args) => args[3] === "noise"));
  assert.ok(
    calls.reduce((sum, args) => sum + args[4].strength, 0) <=
      SPORE_POLICY.rate * 0.4 + 1e-9,
  );
  policy.cancel("audio");
  assert.equal(policy.active.length, 2);
  policy.cancel("recovery");
  assert.equal(policy.active.length, 0);
  assert.equal(policy.queueRecovery(500, 0.5, 0.5), true);
  policy.interact(true, 510);
  assert.equal(policy.active.length, 0);
});
