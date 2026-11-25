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

const parameters = { audioSporeAmount: 0.08, audioRippleAmount: 1 };
const levels = (beatId, timestamp, extra = {}) => ({
  generation: 1,
  beatId,
  onsetTimestamp: timestamp,
  beatStrength: 1,
  hasSignal: true,
  ...extra,
});
function response() {
  const policy = new AudioResponse();
  policy.update(levels(0, 0), 0, parameters);
  return policy;
}

test("only fresh accepted beats dispatch effects, never envelope tails, old sessions or silence", () => {
  const policy = response();
  assert.equal(policy.update(levels(1, 10), 10, parameters).ripple, 1);
  assert.equal(policy.update(levels(1, 10), 20, parameters), null);
  assert.equal(policy.update(levels(2, 10), 400, parameters), null);
  assert.equal(
    policy.update(levels(3, 500, { hasSignal: false }), 500, parameters),
    null,
  );
  assert.equal(policy.active.length, 0);
  assert.equal(policy.update(levels(3, 500), 520, parameters), null);
  assert.equal(
    policy.update(levels(4, 600, { generation: 2 }), 600, parameters),
    null,
  );
  assert.equal(
    policy.update(levels(5, 800, { generation: 2 }), 800, parameters).ripple,
    1,
  );
});

test("a reconnect cancels spores from the previous source", () => {
  const policy = response();
  policy.update(levels(1, 100), 100, parameters);
  assert.equal(policy.active.length, 1);
  policy.update(levels(2, 200, { generation: 2 }), 200, parameters);
  assert.equal(policy.active.length, 0);
});

test("pause, export, hidden and navigation eligibility cancel queued work and consume old beats", () => {
  for (const reason of ["pause", "export", "hidden", "navigation"]) {
    const policy = response();
    policy.update(levels(1, 100), 100, parameters);
    assert.equal(policy.active.length, 1, reason);
    policy.update(levels(2, 200), 200, parameters, false);
    assert.equal(policy.active.length, 0, reason);
    assert.equal(
      policy.update(levels(2, 200), 210, parameters, true),
      null,
      reason,
    );
    const calls = [];
    policy.step(220, 128, (...args) => calls.push(args), [0, 1, 1]);
    assert.equal(calls.length, 0, reason);
  }
});

test("automatic spores yield while pointer is held and for two seconds after release", () => {
  const policy = response();
  policy.interact(true, 100);
  policy.update(levels(1, 4000), 4000, parameters);
  assert.equal(policy.active.length, 0);
  policy.interact(false, 4100);
  policy.update(levels(2, 6000), 6000, parameters);
  assert.equal(policy.active.length, 0);
  policy.update(levels(3, 6100), 6100, parameters);
  assert.equal(policy.active.length, 1);
});

test("spore mixing stays under its per-second budget at varied frame rates and grid sizes", () => {
  for (const size of [128, 256, 512, 1024])
    for (const fps of [15, 30, 60, 144]) {
      const policy = response(),
        calls = [];
      let lastId = 0;
      for (let t = 0; t <= 1000; t += 1000 / fps) {
        const beatId = Math.floor(t / 170) + 1;
        if (beatId !== lastId) {
          policy.update(levels(beatId, t), t, parameters);
          lastId = beatId;
        }
        assert.ok(policy.active.length <= 2);
        policy.step(t, size, (...args) => calls.push(args), [1, 0, 0]);
      }
      assert.ok(calls.length > 0);
      assert.ok(
        calls.reduce((sum, args) => sum + args[4].strength, 0) <=
          SPORE_POLICY.rate + 1e-9,
      );
      for (const [x, y, radius, mode, options] of calls) {
        assert.ok(x >= 0 && x < size && y >= 0 && y < size);
        assert.equal(radius, Math.max(1, Math.round(size * 0.03)));
        assert.equal(mode, "kick_color");
        assert.equal(options.lockBarrier, true);
        assert.equal(options.automatic, true);
        assert.deepEqual(options.dyeColor, [1, 0, 0]);
      }
      policy.step(1600, size, () =>
        assert.fail("Expired spores must not drain"),
      );
      assert.equal(policy.active.length, 0);
    }
});

test("zero amounts never queue audio effects", () => {
  const policy = response();
  assert.equal(
    policy.update(levels(1, 100), 100, {
      audioSporeAmount: 0,
      audioRippleAmount: 0,
    }),
    null,
  );
  assert.equal(policy.active.length, 0);
});

test("malformed, zero-strength and out-of-order beat records never replay an event", () => {
  const policy = response();
  assert.equal(policy.update(levels(1, NaN), 100, parameters), null);
  assert.equal(
    policy.update(levels(2, 200, { beatStrength: 0 }), 200, parameters),
    null,
  );
  assert.ok(policy.update(levels(3, 300), 300, parameters));
  assert.equal(policy.update(levels(2, 320), 320, parameters), null);
  assert.equal(policy.update(levels(3, 330), 330, parameters), null);
});

test("route-only presets preserve user routes, explicit Off, base parameters and LFOs", () => {
  const id = "preset-policy";
  const keys = [
    "rotation",
    "palettePhase",
    "echoDrift",
    "echoDecay",
    "audioRippleAmount",
    "audioSporeAmount",
  ];
  restoreAudioMatrix(id, {}, keys);
  const base = { echoDecay: 0.9, rotation: 110 },
    lfo = { rotation: { enabled: true, depth: 0.7 } };
  const before = JSON.stringify({ base, lfo });
  setAudioRoute(id, "echoDrift", { source: "audioAir", depth: -0.2 });
  setAudioRoute(id, "audioSporeAmount", { source: "none", depth: 0.25 });
  applyAudioPreset(id, "kick-spore", keys);
  assert.equal(audioMatrixForModel(id).audioSporeAmount.source, "none");
  assert.equal(audioMatrixForModel(id).audioRippleAmount.owner, "preset");
  // Editing a preset route explicitly transfers ownership, including Off.
  setAudioRoute(id, "audioRippleAmount", {
    source: "audioBody",
    depth: 0.1,
    owner: "user",
  });
  applyAudioPreset(id, "bass-trails", keys);
  const matrix = audioMatrixForModel(id);
  assert.equal(matrix.echoDrift.depth, -0.2);
  assert.equal(matrix.audioRippleAmount.owner, "user");
  assert.equal(matrix.echoDecay.owner, "preset");
  assert.equal(
    applyAudioModulation(
      { type: "range", min: 0, max: 0.98 },
      0.6,
      matrix.echoDecay,
      { activity: 1 },
    ),
    0.7,
  );
  assert.equal(
    applyAudioModulation(
      { type: "range", min: 0, max: 0.98 },
      0.9,
      matrix.echoDecay,
      { activity: 1 },
    ),
    0.9,
  );
  // A preset ceiling limits only added audio persistence, never a higher LFO.
  assert.equal(
    applyAudioModulation(
      { type: "range", min: 0, max: 0.98 },
      0.85,
      matrix.echoDecay,
      { activity: 1 },
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
  assert.equal(audioMatrixForModel(id).audioRippleAmount.source, "audioBody");
  assert.equal(JSON.stringify({ base, lfo }), before);
  for (const preset of AUDIO_PRESETS.slice(1)) {
    restoreAudioMatrix(id, {}, keys);
    const saved = applyAudioPreset(id, preset.value, keys);
    restoreAudioMatrix(id, saved, keys);
    assert.deepEqual(audioMatrixForModel(id), saved);
  }
  restoreAudioMatrix(id, {}, []);
});

test("audio destinations are evaluated only once for an eligible accepted event", () => {
  const policy = response();
  let evaluations = 0;
  const evaluate = () => {
    evaluations++;
    return parameters;
  };
  policy.update(levels(1, 100), 100, evaluate, false);
  policy.update(levels(1, 100), 110, evaluate);
  policy.update(levels(2, 200, { hasSignal: false }), 200, evaluate);
  assert.equal(evaluations, 0);
  policy.update(levels(3, 300), 300, evaluate);
  policy.update(levels(3, 300), 310, evaluate);
  assert.equal(evaluations, 1);
});

test("audio and recovery share one two-spore mixing budget and manual interaction cancels both", () => {
  const policy = response(),
    calls = [];
  policy.update(levels(1, 0), 0, parameters);
  assert.equal(policy.queueRecovery(0, 0.5, 0.5), true);
  assert.equal(policy.queueRecovery(0, 0.7, 0.7), false);
  for (let time = 16; time < 400; time += 16)
    policy.step(time, 256, (...args) => calls.push(args), [0, 1, 1]);
  assert.ok(calls.some((args) => args[3] === "noise"));
  assert.ok(calls.some((args) => args[3] === "kick_color"));
  assert.ok(
    calls.reduce((sum, args) => sum + args[4].strength, 0) <= 0.08 * 0.4,
  );
  policy.update(levels(2, 400, { hasSignal: false }), 400, parameters);
  assert.equal(policy.active.length, 1);
  assert.equal(policy.active[0].kind, "recovery");
  policy.interact(true, 410);
  assert.equal(policy.active.length, 0);
});
