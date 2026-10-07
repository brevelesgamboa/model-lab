import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeParameters,
  supportsModulation,
  validateModelDefinition,
} from "../../assets/js/core/model-contract.js";
import { resolveView } from "../../assets/js/app/navigation-controller.js";

const model = {
  id: "fixture",
  name: "Fixture",
  render() {},
  controls: [
    { key: "strength", type: "range", min: 0, max: 1, step: 0.1, default: 0.5 },
    {
      key: "levels",
      type: "select",
      options: [{ value: 3 }, { value: 5 }],
      default: 3,
    },
  ],
};

test("parameter restoration validates options and discards nonexistent preset keys", () => {
  assert.deepEqual(
    sanitizeParameters(model, { strength: 8, levels: "5", bloom: 1 }),
    { strength: 1, levels: 5 },
  );
  assert.deepEqual(
    sanitizeParameters(model, { strength: "invalid", levels: 7 }),
    { strength: 0.5, levels: 3 },
  );
});

test("expensive internal-clock engines cannot acquire generic modulation controls", () => {
  assert.equal(supportsModulation(model, model.controls[0]), true);
  assert.equal(
    supportsModulation(
      { ...model, usesInternalClock: true },
      model.controls[0],
    ),
    false,
  );
  assert.equal(
    supportsModulation(model, { ...model.controls[0], modulation: false }),
    false,
  );
});

test("registration catches duplicate controls and missing generation methods", () => {
  validateModelDefinition(model);
  assert.throws(
    () => validateModelDefinition({ ...model, render: undefined }),
    /render/,
  );
  assert.throws(
    () =>
      validateModelDefinition({
        ...model,
        controls: [model.controls[0], model.controls[0]],
      }),
    /schema/,
  );
});

test("previous navigation links resolve to consolidated destinations", () => {
  assert.equal(resolveView("datasets"), "experiments");
  assert.equal(resolveView("studio"), "experiments");
  assert.equal(resolveView("method"), "about");
  assert.equal(resolveView("missing"), "lab");
});
