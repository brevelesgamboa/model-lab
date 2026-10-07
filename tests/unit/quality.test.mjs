import test from "node:test";
import assert from "node:assert/strict";
import {
  recommendedProfile,
  resolveQuality,
} from "../../assets/js/core/quality.js";

test("auto quality does not infer GPU speed from API availability", () => {
  assert.equal(
    recommendedProfile({
      threads: 16,
      memoryGb: 16,
      maxTextureSize: 16384,
      hasWebGPU: true,
    }),
    "high",
  );
  assert.equal(
    recommendedProfile({ threads: 4, memoryGb: 4, maxTextureSize: 4096 }),
    "standard",
  );
  assert.equal(
    recommendedProfile({ threads: 1, maxTextureSize: 2048 }),
    "economy",
  );
});
test("explicit quality is constrained by real device limits", () => {
  assert.equal(resolveQuality("extreme", { maxTextureSize: 512 }).size, 512);
  assert.equal(resolveQuality("missing", { maxTextureSize: 2048 }).size, 512);
});
