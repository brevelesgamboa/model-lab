import test from "node:test";
import assert from "node:assert/strict";
import {
  restoreAudioMatrix,
  audioMatrixForModel,
  getAudioRoute,
  applyAudioModulation,
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
    growthSpeed: { source: "bass", depth: -0.4 },
    twist: { source: "kick", depth: 0.2 },
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
