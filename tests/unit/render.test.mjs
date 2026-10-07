import test from "node:test";
import assert from "node:assert/strict";
import { createRenderController } from "../../assets/js/app/render-controller.js";

test("redraws and exact captures never advance simulation; live frames opt in", async () => {
  const flags = [];
  const model = {
    render: (_canvas, _parameters, _time, options) => {
      flags.push(options.advanceSimulation);
      return {};
    },
  };
  const renderer = createRenderController({
    getSnapshot: (request) => ({
      model,
      canvas: {},
      parameters: {},
      timeSeconds: 0,
      advanceSimulation: request.advanceSimulation,
    }),
    onFrame: () => "frame",
    onError: () => {},
  });
  await renderer.render();
  await renderer.render({ forceAnalysis: true });
  await renderer.render({ advanceSimulation: true });
  await renderer.render({ advanceSimulation: true, exact: true });
  assert.deepEqual(flags, [false, false, true, false]);
});

test("interactive renders coalesce and stale completions cannot update UI state", async () => {
  const completions = [];
  const paints = [];
  const model = {
    render: (_canvas, params) =>
      new Promise((resolve) => {
        paints.push(params.value);
        completions.push(resolve);
      }),
  };
  const frames = [];
  const renderer = createRenderController({
    getSnapshot: (request) => ({
      model,
      parameters: request,
      canvas: {},
      timeSeconds: 0,
    }),
    onFrame: ({ parameters }) => {
      frames.push(parameters.value);
      return parameters.value;
    },
    onError: () => {},
  });
  const first = renderer.render({ value: 1 });
  await Promise.resolve();
  renderer.render({ value: 2 });
  renderer.render({ value: 3 });
  completions.shift()({});
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(paints, [1, 3]);
  renderer.invalidate();
  completions.shift()({});
  await renderer.waitForIdle();
  assert.deepEqual(frames, [1]);
});

test("exact capture waits for an in-flight render and reports failures", async () => {
  let finish;
  let count = 0;
  const errors = [];
  const model = {
    render: () =>
      ++count === 1
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.reject(new Error("GPU failed")),
  };
  const renderer = createRenderController({
    getSnapshot: () => ({ model, canvas: {}, parameters: {}, timeSeconds: 0 }),
    onFrame: () => "frame",
    onError: (error) => errors.push(error.message),
  });
  const pending = renderer.render();
  await Promise.resolve();
  const exact = renderer.render({ exact: true });
  finish({});
  await pending;
  assert.equal(await exact, null);
  assert.deepEqual(errors, ["GPU failed"]);
});
