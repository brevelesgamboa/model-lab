import test from "node:test";
import assert from "node:assert/strict";
import { validateCustomModel } from "../../assets/js/core/custom-model-store.js";

function fixture() {
  return {
    schema: "latent-field-local-pca-v1",
    width: 32,
    height: 32,
    channels: 1,
    mean: Array(1024).fill(0.5),
    basis: [Array(1024).fill(0.01)],
    explainedVariance: [1],
    explainedVarianceRatio: [1],
    sources: Array.from({ length: 64 }, (_, index) => ({
      title: "SOURCE " + index,
      license: "USER PROVIDED",
    })),
  };
}

test("PCA import rejects non-finite vectors and negative variance", () => {
  const invalidMean = fixture();
  invalidMean.mean[0] = NaN;
  assert.throws(() => validateCustomModel(invalidMean), /non-finite/);
  const invalidBasis = fixture();
  invalidBasis.basis[0][0] = Infinity;
  assert.throws(() => validateCustomModel(invalidBasis), /non-finite/);
  const invalidVariance = fixture();
  invalidVariance.explainedVariance[0] = -1;
  assert.throws(() => validateCustomModel(invalidVariance), /nonnegative/);
});

test("PCA validation retains attribution for the full 64-image dataset", () => {
  assert.equal(validateCustomModel(fixture()).sources.length, 64);
});
