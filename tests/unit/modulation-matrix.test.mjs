import test from "node:test";
import assert from "node:assert/strict";
import {
  restoreAudioMatrix,
  audioMatrixForModel,
  getAudioRoute,
  applyAudioModulation,
  setAudioRoute,
  MODULATION_SOURCES,
  getModulationLevel,
} from "../../assets/js/core/modulation-matrix.js";

test("restoring retired Inception routes disables them while preserving Full/Kick routing", () => {
  const model = "neural-growth";
  restoreAudioMatrix(
    model,
    {
      rotation: { source: "inception", depth: 0.8 },
      growthSpeed: { source: "bass", depth: -0.4 },
      twist: { source: "kick", depth: 0.2 },
    },
    ["rotation", "growthSpeed", "twist"],
  );
  assert.equal(getAudioRoute(model, "rotation").source, "none");
  assert.deepEqual(audioMatrixForModel(model), {
    growthSpeed: { source: "bass", depth: -0.4, owner: "user" },
    twist: { source: "kick", depth: 0.2, owner: "user" },
  });
  const range = { type: "range", min: 0, max: 100 };
  assert.equal(
    applyAudioModulation(range, 50, getAudioRoute(model, "rotation"), {
      inception: 1,
    }),
    50,
  );
  assert.equal(
    applyAudioModulation(range, 50, getAudioRoute(model, "growthSpeed"), {
      bass: 1,
    }),
    30,
  );
  assert.equal(
    applyAudioModulation(range, 50, getAudioRoute(model, "twist"), { kick: 1 }),
    60,
  );
  restoreAudioMatrix(model, {}, []);
});

test("source registry, legacy music alias and depth validation share a safe contract", () => {
  assert.deepEqual(
    MODULATION_SOURCES.map(({ value }) => value),
    [
      "none",
      "audioBass",
      "audioBody",
      "audioAir",
      "audioBeat",
      "audioActivity",
    ],
  );
  const levels = {
    bass: 0.1,
    body: 0.2,
    air: 0.3,
    kick: 0.4,
    activity: 0.5,
    music: 0.6,
    hasSignal: true,
  };
  assert.deepEqual(
    MODULATION_SOURCES.map(({ value }) => getModulationLevel(value, levels)),
    [0, 0.1, 0.2, 0.3, 0.4, 0.5],
  );
  assert.equal(getModulationLevel("bass", levels), 0.6);
  assert.equal(
    getModulationLevel("audioBass", { ...levels, hasSignal: false }),
    0.1,
  );
  for (const depth of [NaN, Infinity, "invalid", "", null, false, {}, []])
    assert.equal(
      setAudioRoute("validation", "rotation", { source: "audioBeat", depth })
        .depth,
      0.25,
    );
  assert.equal(
    setAudioRoute("validation", "rotation", { source: "audioBeat", depth: -5 })
      .depth,
    -1,
  );
  restoreAudioMatrix("validation", {}, []);
});
