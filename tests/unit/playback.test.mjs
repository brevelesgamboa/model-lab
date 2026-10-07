import test from "node:test";
import assert from "node:assert/strict";
import { createPlaybackController } from "../../assets/js/app/playback-controller.js";

function fixture() {
  const state = { enabled: true, view: "lab", hidden: false, resumes: 0 };
  const calls = [];
  state.model = {
    setClockRunning: (value) => calls.push(value),
    waitForIdle: async () => {},
  };
  const controller = createPlaybackController({
    getModel: () => state.model,
    getEnabled: () => state.enabled,
    getView: () => state.view,
    isHidden: () => state.hidden,
    onResume: () => {
      state.resumes += 1;
    },
  });
  controller.sync();
  return { controller, state, calls };
}

test("navigation and tab visibility pause internally paced models without cancelling them", () => {
  const { controller, state, calls } = fixture();
  state.view = "experiments";
  controller.sync();
  assert.equal(calls.at(-1), false);
  state.view = "lab";
  state.hidden = true;
  controller.sync();
  assert.equal(controller.isActive(), false);
  state.hidden = false;
  controller.sync();
  assert.equal(calls.at(-1), true);
  assert.equal(state.resumes, 2);
  state.enabled = false;
  controller.sync();
  state.hidden = true;
  controller.sync();
  state.hidden = false;
  controller.sync();
  assert.equal(controller.isActive(), false);
});

test("exclusive GPU tasks are serialized and release suspension after failure", async () => {
  const { controller } = fixture();
  const events = [];
  let finish;
  const first = controller.withExclusiveCompute(async () => {
    events.push("first");
    await new Promise((resolve) => {
      finish = resolve;
    });
  });
  const second = controller.withExclusiveCompute(async () => {
    events.push("second");
    throw new Error("failed");
  });
  const checkedSecond = assert.rejects(second, /failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first"]);
  assert.equal(controller.isActive(), false);
  finish();
  await first;
  await checkedSecond;
  assert.deepEqual(events, ["first", "second"]);
  assert.equal(controller.isSuspended(), false);
  assert.equal(controller.isActive(), true);
});
